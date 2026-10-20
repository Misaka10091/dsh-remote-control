/**
 * The managed Cloudflare Tunnel: grammar, token file, and the process state machine.
 *
 * No real `cloudflared` is started and no network is touched. The child process is
 * a fake `EventEmitter` with two `PassThrough` streams, so every state transition
 * (URL observed, exit, timeout, stop) is deterministic and instant — the production
 * timeouts are injected down to single-digit milliseconds.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  createTunnel,
  defaultTunnel,
  isValidTunnelToken,
  normalizeTunnel,
  quickTunnelUrl,
  readTunnelToken,
  tunnelTokenPath,
  validateTunnel,
  writeTunnelToken,
} from '../src/host/tunnel.js'
import { clientAddress } from '../src/host/loopback.js'
import { cleanupDir, makeTempDir } from './helpers.mjs'

const QUICK_URL = 'https://abc-def-ghi.trycloudflare.com'

/** A temp file that can serve as "a cloudflared the user configured". */
function makeBinary(dir, name = 'cloudflared') {
  const file = path.join(dir, name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  try {
    chmodSync(file, 0o755)
  } catch {
    /* Windows has no POSIX execute bit; `resolveTunnelBinary` accepts it anyway. */
  }
  return file
}

/**
 * A fake ChildProcess.
 *
 * `autoExit: false` models a process that ignores SIGTERM, which is the case the
 * controller's stop timeout exists for.
 */
function makeFakeChild(options = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(typeof signal === 'string' ? signal : 'SIGTERM')
    if (options.autoExit !== false) child.emit('exit', null, typeof signal === 'string' ? signal : 'SIGTERM')
    return true
  }
  return child
}

function makeHarness(options = {}) {
  const children = []
  const spawnImpl = (binary, args, spawnOptions) => {
    const child = makeFakeChild(options.child)
    children.push({ binary, args, spawnOptions, child })
    return child
  }
  const tunnel = createTunnel({
    baseDir: options.baseDir ?? makeTempDir(),
    spawnImpl,
    startTimeoutMs: options.startTimeoutMs ?? 100,
    readyGraceMs: options.readyGraceMs ?? 5,
    stopTimeoutMs: options.stopTimeoutMs ?? 20,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  return { tunnel, children }
}

function tunnelSettings(overrides = {}) {
  return { enabled: true, mode: 'quick', binaryPath: '', publicUrl: '', ...overrides }
}

/** Let the queued start task run and attach its listeners. */
function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

/* ------------------------------------------------------------------ *
 * Grammar
 * ------------------------------------------------------------------ */

test('defaultTunnel is fresh and fully defaulted', () => {
  const first = defaultTunnel()
  assert.deepEqual(first, { enabled: false, mode: 'quick', binaryPath: '', publicUrl: '' })
  assert.notEqual(defaultTunnel(), first)
})

test('normalizeTunnel keeps what it can and repairs the rest', () => {
  assert.deepEqual(normalizeTunnel(undefined), defaultTunnel())
  assert.deepEqual(normalizeTunnel(null), defaultTunnel())
  assert.deepEqual(normalizeTunnel('nope'), defaultTunnel())
  assert.deepEqual(normalizeTunnel({
    enabled: true,
    mode: 'token',
    binaryPath: '  /usr/local/bin/cloudflared  ',
    publicUrl: '  dsh.example.com  ',
  }), {
    enabled: true,
    mode: 'token',
    binaryPath: '/usr/local/bin/cloudflared',
    publicUrl: 'https://dsh.example.com',
  })
  /* Unknown mode falls back to quick (the mode that needs no credentials), and a
     relative path with a separator is refused rather than resolved against cwd. */
  assert.deepEqual(normalizeTunnel({ mode: 'sideload', binaryPath: './bin/cloudflared' }), {
    enabled: false,
    mode: 'quick',
    binaryPath: '',
    publicUrl: '',
  })
  assert.equal(normalizeTunnel({ publicUrl: 'https://x.example/a?b' }).publicUrl, '')
  assert.equal(normalizeTunnel({ binaryPath: 'x'.repeat(600) }).binaryPath, '')
})

test('validateTunnel refuses exactly what normalizeTunnel had to repair', () => {
  for (const value of [
    null,
    'nope',
    [],
    { mode: 'sideload' },
    { mode: 42 },
    { enabled: 'yes' },
    { binaryPath: 42 },
    { binaryPath: './relative/cloudflared' },
    { binaryPath: 'x'.repeat(600) },
    { binaryPath: 'a\u0000b' },
    { publicUrl: 42 },
    { publicUrl: 'https://x.example/path' },
    { publicUrl: 'not a host' },
  ]) {
    const result = validateTunnel(value)
    assert.equal(result.ok, false, JSON.stringify(value))
    assert.equal(typeof result.message, 'string')
    assert.ok(result.message.length > 0)
  }
  assert.deepEqual(validateTunnel({ mode: 'token', binaryPath: 'cloudflared' }), {
    ok: true,
    tunnel: { enabled: false, mode: 'token', binaryPath: 'cloudflared', publicUrl: '' },
  })
})

test('a quick-tunnel URL is recognised in cloudflared output', () => {
  assert.equal(quickTunnelUrl(`2026-10-20 INF |  ${QUICK_URL}  |`), QUICK_URL)
  assert.equal(quickTunnelUrl(`${QUICK_URL}\r`), QUICK_URL)
  /* Documentation links are not ours: a quick-tunnel hostname has at least three
     hyphen-separated labels. */
  assert.equal(quickTunnelUrl('https://docs.trycloudflare.com/quick'), null)
  assert.equal(quickTunnelUrl('https://a-b.trycloudflare.com'), null)
  assert.equal(quickTunnelUrl('https://example.com'), null)
  assert.equal(quickTunnelUrl(''), null)
  assert.equal(quickTunnelUrl(null), null)
})

test('isValidTunnelToken accepts a dashboard token and refuses whitespace', () => {
  assert.equal(isValidTunnelToken('eyJhIjoiZXhhbXBsZSJ9'), true)
  assert.equal(isValidTunnelToken('  eyJhIjoiZXhhbXBsZSJ9  '), true)
  assert.equal(isValidTunnelToken('has space'), false)
  assert.equal(isValidTunnelToken('short'), false, 'a four-character paste is not a token')
  assert.equal(isValidTunnelToken(''), false)
  assert.equal(isValidTunnelToken(42), false)
})

/* ------------------------------------------------------------------ *
 * Token file
 * ------------------------------------------------------------------ */

test('the tunnel token round-trips through its own 0600 file and can be cleared', () => {
  const dir = makeTempDir()
  try {
    assert.deepEqual(readTunnelToken(dir), { token: '', present: false, valid: false })
    assert.deepEqual(writeTunnelToken(dir, 'eyJhIjoiZXhhbXBsZSJ9'), { tokenSet: true })
    assert.ok(existsSync(tunnelTokenPath(dir)))
    assert.deepEqual(readTunnelToken(dir), {
      token: 'eyJhIjoiZXhhbXBsZSJ9',
      present: true,
      valid: true,
    })
    writeTunnelToken(dir, '')
    assert.deepEqual(readTunnelToken(dir), { token: '', present: false, valid: false })
    assert.ok(!existsSync(tunnelTokenPath(dir)), 'clearing deletes the file')
  } finally {
    cleanupDir(dir)
  }
})

test('a corrupt token file is reported as present-but-unusable', () => {
  const dir = makeTempDir()
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tunnelTokenPath(dir), 'not a token with spaces')
    const stored = readTunnelToken(dir)
    assert.equal(stored.present, true)
    assert.equal(stored.valid, false)
    assert.equal(stored.token, '', 'an invalid token is never handed to a caller')
  } finally {
    cleanupDir(dir)
  }
})

test('the token file is never written into devices.json', () => {
  /* The grammar itself has no token field; this is the structural half of
     `prd.md` R2. The file writer is the other half. */
  assert.deepEqual(Object.keys(defaultTunnel()).sort(), ['binaryPath', 'enabled', 'mode', 'publicUrl'])
  assert.ok(!JSON.stringify(normalizeTunnel({ token: 'secret' })).includes('secret'))
})

/* ------------------------------------------------------------------ *
 * Process lifecycle
 * ------------------------------------------------------------------ */

test('a quick tunnel starts, reports its URL and spawns with an argv array', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir })
    const promise = tunnel.start({
      settings: tunnelSettings({ binaryPath: binary }),
      port: 3090,
    })
    await nextTurn()
    assert.equal(children.length, 1)
    assert.equal(children[0].spawnOptions.shell, false)
    assert.equal(children[0].spawnOptions.windowsHide, true)
    assert.deepEqual(children[0].args, [
      'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3090',
    ])
    children[0].child.stdout.write(`INF |  ${QUICK_URL}  |\n`)
    const status = await promise
    assert.equal(status.state, 'running')
    assert.equal(status.url, QUICK_URL)
    assert.equal(status.mode, 'quick')
    assert.equal(status.error, null)
    assert.ok(typeof status.startedAt === 'string')
    assert.equal(status.binary.source, 'custom')

    /* Stopping kills the process and clears the URL. */
    const stopped = await tunnel.stop()
    assert.equal(stopped.state, 'stopped')
    assert.equal(stopped.url, '')
    assert.deepEqual(children[0].child.signals, ['SIGTERM'])
  } finally {
    cleanupDir(dir)
  }
})

test('the URL is parsed from stderr too', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir })
    const promise = tunnel.start({ settings: tunnelSettings({ binaryPath: binary }), port: 3090 })
    await nextTurn()
    children[0].child.stderr.write(`2026-10-20T00:00:00Z INF ${QUICK_URL}\n`)
    const status = await promise
    assert.equal(status.url, QUICK_URL)
    await tunnel.stop()
  } finally {
    cleanupDir(dir)
  }
})

test('a quick tunnel that never prints a URL fails with a stable code', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir, startTimeoutMs: 5 })
    const status = await tunnel.start({ settings: tunnelSettings({ binaryPath: binary }), port: 3090 })
    assert.equal(status.state, 'failed')
    assert.equal(status.error.code, 'tunnel/start-timeout')
    assert.equal(children.length, 1)
    assert.deepEqual(children[0].child.signals, ['SIGTERM'], 'the stuck process is cleaned up')
  } finally {
    cleanupDir(dir)
  }
})

test('an exit before the URL is a failure, not a running tunnel', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir })
    const promise = tunnel.start({ settings: tunnelSettings({ binaryPath: binary }), port: 3090 })
    await nextTurn()
    children[0].child.emit('exit', 1, null)
    const status = await promise
    assert.equal(status.state, 'failed')
    assert.equal(status.error.code, 'tunnel/exited')
    assert.equal(status.url, '')
  } finally {
    cleanupDir(dir)
  }
})

test('a token tunnel runs after the grace window, with the token only in a file', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    writeTunnelToken(dir, 'eyJhIjoiZXhhbXBsZSJ9')
    const { tunnel, children } = makeHarness({ baseDir: dir, readyGraceMs: 5 })
    const status = await tunnel.start({
      settings: tunnelSettings({
        mode: 'token',
        binaryPath: binary,
        publicUrl: 'https://dsh.example.com',
      }),
      port: 3090,
    })
    assert.equal(status.state, 'running')
    assert.equal(status.url, 'https://dsh.example.com')
    assert.equal(status.tokenSet, true)
    assert.equal(children.length, 1)
    assert.deepEqual(children[0].args, [
      'tunnel', '--no-autoupdate', 'run', '--token-file', tunnelTokenPath(dir),
    ])
    assert.ok(!children[0].args.includes('eyJhIjoiZXhhbXBsZSJ9'), 'the token is not in argv')
    assert.ok(!JSON.stringify(children[0].spawnOptions.env ?? {}).includes('eyJhIjoiZXhhbXBsZSJ9'),
      'the token is not in the child environment')
    assert.ok(!JSON.stringify(status).includes('eyJhIjoiZXhhbXBsZSJ9'), 'status never carries the token')
    await tunnel.stop()
  } finally {
    cleanupDir(dir)
  }
})

test('a token tunnel refuses to start without a token or a public hostname', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel } = makeHarness({ baseDir: dir })

    const noToken = await tunnel.start({
      settings: tunnelSettings({ mode: 'token', binaryPath: binary, publicUrl: 'https://dsh.example.com' }),
      port: 3090,
    })
    assert.equal(noToken.state, 'failed')
    assert.equal(noToken.error.code, 'tunnel/token-missing')

    writeTunnelToken(dir, 'eyJhIjoiZXhhbXBsZSJ9')
    const noUrl = await tunnel.start({
      settings: tunnelSettings({ mode: 'token', binaryPath: binary }),
      port: 3090,
    })
    assert.equal(noUrl.state, 'failed')
    assert.equal(noUrl.error.code, 'tunnel/url-missing')
  } finally {
    cleanupDir(dir)
  }
})

test('a malformed token file is reported, not silently ignored', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    writeFileSync(tunnelTokenPath(dir), 'has spaces')
    const { tunnel } = makeHarness({ baseDir: dir })
    const status = await tunnel.start({
      settings: tunnelSettings({ mode: 'token', binaryPath: binary, publicUrl: 'https://dsh.example.com' }),
      port: 3090,
    })
    assert.equal(status.state, 'failed')
    assert.equal(status.error.code, 'tunnel/token-invalid')
    assert.equal(status.tokenSet, false)
    assert.equal(status.tokenState, 'invalid', 'a corrupt file is distinguishable from no file')
  } finally {
    cleanupDir(dir)
  }
})

test('a missing binary is a status, never a throw', async () => {
  const dir = makeTempDir()
  try {
    const { tunnel, children } = makeHarness({ baseDir: dir })
    const status = await tunnel.start({
      settings: tunnelSettings({ binaryPath: path.join(dir, 'does-not-exist') }),
      port: 3090,
    })
    assert.equal(status.state, 'failed')
    assert.equal(status.error.code, 'tunnel/binary-missing')
    assert.equal(children.length, 0, 'nothing is spawned without a binary')
  } finally {
    cleanupDir(dir)
  }
})

test('a configured path that is missing does not fall back to PATH or the download', async () => {
  const dir = makeTempDir()
  try {
    /* A downloaded copy exists, but the user named a different file. Falling back
       would hide their typo behind a version they did not choose. */
    makeBinary(dir, 'cloudflared')
    const { tunnel } = makeHarness({ baseDir: dir, platform: process.platform })
    const status = await tunnel.start({
      settings: tunnelSettings({ binaryPath: path.join(dir, 'nope') }),
      port: 3090,
    })
    assert.equal(status.error.code, 'tunnel/binary-missing')
    assert.equal(status.binary.available, false)
  } finally {
    cleanupDir(dir)
  }
})

test('an identical start is a no-op, and stop is idempotent', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir })
    const settings = tunnelSettings({ binaryPath: binary })
    const first = tunnel.start({ settings, port: 3090 })
    await nextTurn()
    children[0].child.stdout.write(`${QUICK_URL}\n`)
    await first

    const second = await tunnel.start({ settings, port: 3090 })
    assert.equal(second.state, 'running')
    assert.equal(children.length, 1, 'the same configuration does not restart the process')

    await tunnel.stop()
    const again = await tunnel.stop()
    assert.equal(again.state, 'stopped')
    assert.deepEqual(children[0].child.signals, ['SIGTERM'])
  } finally {
    cleanupDir(dir)
  }
})

test('a changed port restarts the process', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir })
    const settings = tunnelSettings({ binaryPath: binary })
    const first = tunnel.start({ settings, port: 3090 })
    await nextTurn()
    children[0].child.stdout.write(`${QUICK_URL}\n`)
    await first

    const second = tunnel.start({ settings, port: 3091 })
    await nextTurn()
    assert.equal(children.length, 2)
    children[1].child.stdout.write(`${QUICK_URL}\n`)
    await second
    assert.match(children[1].args[3], /:3091$/)
    await tunnel.stop()
  } finally {
    cleanupDir(dir)
  }
})

test('a process that ignores SIGTERM is killed after the stop timeout', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir, child: { autoExit: false }, stopTimeoutMs: 5 })
    const promise = tunnel.start({ settings: tunnelSettings({ binaryPath: binary }), port: 3090 })
    await nextTurn()
    children[0].child.stdout.write(`${QUICK_URL}\n`)
    await promise

    const stopped = await tunnel.stop()
    assert.equal(stopped.state, 'stopped')
    assert.deepEqual(children[0].child.signals, ['SIGTERM', 'SIGKILL'])
  } finally {
    cleanupDir(dir)
  }
})

test('stopping a start that is still waiting for its URL does not wait for the timeout', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir, startTimeoutMs: 30_000 })
    const starting = tunnel.start({ settings: tunnelSettings({ binaryPath: binary }), port: 3090 })
    await nextTurn()
    const at = Date.now()
    const stopped = await tunnel.stop()
    assert.ok(Date.now() - at < 1_000, 'the stop resolved without the 30 s start timeout')
    assert.equal(stopped.state, 'stopped')
    const started = await starting
    assert.equal(started.state, 'stopped', 'the pre-empted start reports the terminal state')
    assert.deepEqual(children[0].child.signals, ['SIGTERM'])
  } finally {
    cleanupDir(dir)
  }
})

test('dispose abandons a stuck start and releases the process', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir, startTimeoutMs: 30_000 })
    const starting = tunnel.start({ settings: tunnelSettings({ binaryPath: binary }), port: 3090 })
    await nextTurn()
    const at = Date.now()
    await tunnel.dispose()
    assert.ok(Date.now() - at < 1_000, 'unload must not wait for a URL that never comes')
    const started = await starting
    assert.equal(started.state, 'stopped')
    assert.deepEqual(children[0].child.signals, ['SIGTERM'])
    /* After disposal a start is a no-op, never a new process. */
    const after = await tunnel.start({ settings: tunnelSettings({ binaryPath: binary }), port: 3090 })
    assert.equal(after.state, 'stopped')
    assert.equal(children.length, 1)
  } finally {
    cleanupDir(dir)
  }
})

test('configure adopts settings without spawning anything', () => {
  /* The index uses this when the gateway is off: the user's settings must be
     readable even though there is nowhere to forward to. */
  const dir = makeTempDir()
  try {
    const { tunnel, children } = makeHarness({ baseDir: dir })
    const status = tunnel.configure({ enabled: true, mode: 'token', publicUrl: 'dsh.example.com' })
    assert.equal(status.enabled, true)
    assert.equal(status.mode, 'token')
    assert.equal(status.publicUrl, 'https://dsh.example.com')
    assert.equal(status.state, 'stopped')
    assert.equal(children.length, 0)
  } finally {
    cleanupDir(dir)
  }
})

test('download is refused while a process is live', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir })
    const promise = tunnel.start({ settings: tunnelSettings({ binaryPath: binary }), port: 3090 })
    await nextTurn()
    children[0].child.stdout.write(`${QUICK_URL}\n`)
    await promise

    await assert.rejects(tunnel.download(), (error) => error.code === 'tunnel/busy')
    await tunnel.stop()
  } finally {
    cleanupDir(dir)
  }
})

test('download is refused immediately during a start, not after it resolves', async () => {
  const dir = makeTempDir()
  try {
    const binary = makeBinary(dir)
    const { tunnel, children } = makeHarness({ baseDir: dir, startTimeoutMs: 30_000 })
    const starting = tunnel.start({ settings: tunnelSettings({ binaryPath: binary }), port: 3090 })
    await nextTurn()
    const at = Date.now()
    await assert.rejects(tunnel.download(), (error) => error.code === 'tunnel/busy')
    assert.ok(Date.now() - at < 500, 'the busy answer does not wait for the URL timeout')
    await tunnel.stop()
    await starting
    assert.equal(children.length, 1)
  } finally {
    cleanupDir(dir)
  }
})

/* ------------------------------------------------------------------ *
 * Cloudflare client address
 * ------------------------------------------------------------------ */

test('CF-Connecting-IP is trusted only when the socket is loopback', () => {
  const request = (peer, header) => ({
    socket: { remoteAddress: peer },
    headers: header === undefined ? {} : { 'cf-connecting-ip': header },
  })

  assert.equal(clientAddress(request('127.0.0.1', '203.0.113.9')), '203.0.113.9')
  assert.equal(clientAddress(request('::ffff:127.0.0.1', '203.0.113.9')), '203.0.113.9')
  assert.equal(clientAddress(request('::1', '203.0.113.9')), '203.0.113.9')
  /* A LAN client cannot choose the address the audit and the rate limiter believe. */
  assert.equal(clientAddress(request('192.168.1.9', '203.0.113.9')), '192.168.1.9')
  /* A malformed header is ignored rather than stored as a fake address. */
  assert.equal(clientAddress(request('127.0.0.1', 'not-an-ip')), '127.0.0.1')
  assert.equal(clientAddress(request('127.0.0.1', '')), '127.0.0.1')
  assert.equal(clientAddress(request('127.0.0.1')), '127.0.0.1')
  assert.equal(clientAddress({ socket: {}, headers: {} }), undefined)
})
