/**
 * Plugin entry shape.
 *
 * Stage 0's acceptance is "loads without error and prints one load log". The
 * assertions behind it are: the module exports the Cordis plugin shape, `apply`
 * emits exactly one line through `ctx.logger`, and it survives a host that
 * provides no logger at all.
 *
 * `apply` resolves the device table through `os.homedir()`, so the tests point
 * HOME/USERPROFILE at a temp directory (see {@link withTempHome}). Nothing here
 * may read or write the real `~/.dsh`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import path from 'node:path'

import * as entry from '../src/index.js'
import { ADMIN_API_PREFIX } from '../src/host/constants.js'
import { resolveTunnelBinary } from '../src/host/tunnel-binary.js'
import { cleanupDir, makeTempDir } from './helpers.mjs'

/** A logger stub that records each call, per level. */
function recordingLogger() {
  const calls = []
  const record = (level) => (message) => calls.push({ level, message })
  return {
    calls,
    logger: { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') },
  }
}

/**
 * Run `fn` with the user's home pointed at a fresh temp directory.
 *
 * Windows resolves `os.homedir()` from USERPROFILE first, POSIX from HOME, so both
 * are set and both restored. This is the injection seam for `apply`, which by
 * design resolves its own default base directory.
 */
async function withTempHome(fn) {
  const dir = makeTempDir()
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  try {
    await fn(dir)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    cleanupDir(dir)
  }
}

test('the module exports a Cordis plugin shape', () => {
  assert.equal(entry.name, 'dsh-remote-control')
  assert.deepEqual(entry.inject, ['webServer'])
  assert.equal(typeof entry.apply, 'function')
})

test('createRuntime builds a store and a pairing store bound to the injected directory', () => {
  const dir = makeTempDir()
  try {
    const runtime = entry.createRuntime({ baseDir: dir })
    assert.equal(runtime.store.baseDir, dir)
    assert.deepEqual(runtime.store.listDevices(), [])
    assert.equal(typeof runtime.pairing.create, 'function')
    assert.equal(runtime.pairing.pending(), 0)
  } finally {
    cleanupDir(dir)
  }
})

test('createRuntime keeps two runtimes independent', () => {
  const first = makeTempDir()
  const second = makeTempDir()
  try {
    const one = entry.createRuntime({ baseDir: first })
    const two = entry.createRuntime({ baseDir: second })
    const pair = one.pairing.create()

    assert.equal(one.pairing.pending(), 1)
    assert.equal(two.pairing.pending(), 0)
    assert.throws(() => two.pairing.redeem(pair.pairId, pair.code), /not found/)
  } finally {
    cleanupDir(first)
    cleanupDir(second)
  }
})

test('apply logs exactly one line through ctx.logger.info', async () => {
  /* Stage 0's acceptance, and it still holds: the LOAD path prints one info line.
     Since stage 4 there can additionally be one `warn` when the host provides no
     `webServer.register` (the panel's backend is then absent, and silence would
     be the wrong answer — `quality-guidelines.md` §5). No `webServer` is passed
     here, so that warning is expected and is asserted rather than tolerated. */
  await withTempHome(() => {
    const { calls, logger } = recordingLogger()
    entry.apply({ logger })

    const infos = calls.filter((call) => call.level === 'info')
    assert.equal(infos.length, 1, 'stage 0 acceptance is exactly one info line')
    assert.equal(infos[0].level, 'info')
    assert.match(infos[0].message, /^\[remote-control\] loaded/)

    /* Exactly one warning, and only for the documented reason. Two would mean the
       degradation is reported twice; none would mean it is silent. */
    const warns = calls.filter((call) => call.level === 'warn')
    assert.equal(warns.length, 1, 'the missing admin route is reported exactly once')
    assert.match(warns[0].message, /register is unavailable/)
  })
})

test('with a web server available, apply logs the load line and nothing else', async () => {
  /* The stage-0 shape, restored: once the host CAN serve the panel's backend
     there is no degradation to report, so the load path is exactly one line. */
  await withTempHome(() => {
    const { calls, logger } = recordingLogger()
    const ctx = { logger, webServer: { port: 1, register: () => () => {} }, effect: (run) => run() }
    entry.apply(ctx)

    assert.equal(calls.length, 1, 'one line, and it is the load line')
    assert.match(calls[0].message, /^\[remote-control\] loaded/)
  })
})

test('the load line reports device count and configured port, and carries no secret', async () => {
  await withTempHome(() => {
    const { calls, logger } = recordingLogger()
    entry.apply({ logger })

    const line = calls[0].message
    assert.match(line, /0 paired device\(s\)/)
    assert.match(line, /configured port 3090/)
    assert.match(line, /remote access off/)
    /* Nothing token-shaped (43+ base64url characters) may appear in a log line. */
    assert.ok(!/[A-Za-z0-9_-]{43,}/.test(line), `the load line looks like it carries a token: ${line}`)
  })
})

test('apply reports the real device count from the store', async () => {
  await withTempHome(async (home) => {
    const runtime = entry.createRuntime({ baseDir: path.join(home, '.dsh', 'remote-control') })
    runtime.store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: 'a'.repeat(64) })
    runtime.store.addDevice({ id: 'dev_2', name: 'tablet', tokenHash: 'b'.repeat(64) })

    const { calls, logger } = recordingLogger()
    entry.apply({ logger })
    assert.match(calls[0].message, /2 paired device\(s\)/)
  })
})

test('apply counts active devices, not revoked rows', async () => {
  await withTempHome(async (home) => {
    const runtime = entry.createRuntime({ baseDir: path.join(home, '.dsh', 'remote-control') })
    runtime.store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: 'a'.repeat(64) })
    runtime.store.addDevice({ id: 'dev_2', name: 'tablet', tokenHash: 'b'.repeat(64) })
    runtime.store.revokeDevice('dev_2')

    const { calls, logger } = recordingLogger()
    entry.apply({ logger })
    /* The revoked row stays in the table for the panel, but the load line must
       not count it — "2 paired devices" with one revoked is misleading. */
    assert.match(calls[0].message, /1 paired device\(s\)/)
    assert.equal(runtime.store.listDevices().length, 2, 'both rows are still stored')
  })
})

test('apply does not throw when the host provides no usable logger', async () => {
  await withTempHome(() => {
    assert.doesNotThrow(() => entry.apply({}))
    assert.doesNotThrow(() => entry.apply({ logger: null }))
    assert.doesNotThrow(() => entry.apply({ logger: {} }))
    assert.doesNotThrow(() => entry.apply({ logger: { info: 'not a function' } }))
  })
})

test('apply fails loudly on a corrupt device table instead of pretending remote access works', async () => {
  await withTempHome((home) => {
    const baseDir = path.join(home, '.dsh', 'remote-control')
    mkdirSync(baseDir, { recursive: true })
    writeFileSync(path.join(baseDir, 'devices.json'), '{ this is not json')

    const { calls, logger } = recordingLogger()
    /* Error-handling spec: a corrupt store must fail the row, not be treated as
       an empty table — that would silently invalidate every paired device. */
    assert.throws(() => entry.apply({ logger }), (error) => error.code === 'store/corrupt')
    assert.equal(calls.length, 0, 'nothing is logged as "loaded" when the load failed')
  })
})

/* ------------------------------------------------------------------ *
 * Stage 2: the listener is gated on settings.enabled
 * ------------------------------------------------------------------ */

/**
 * A context sufficient for `apply` to start a gateway.
 *
 * `webServer.port` is the official port; it points at a stub listener so the
 * startup path has a real upstream to name. The gateway itself binds port 0 —
 * never a fixed port — so a test run cannot collide with a running DSH instance.
 */
function gatewayContext({ officialPort, logger }) {
  const effects = []
  const effectLabels = []
  return {
    effects,
    effectLabels,
    logger,
    webServer: { port: officialPort, register: () => () => {} },
    get: () => undefined,
    /* Cordis hands `ctx.effect` an acquire function and keeps what it RETURNS as
       the disposer, so the stub does the same — that is what makes "the route's
       disposer is the registration's return value" testable here. */
    effect: (acquire, label) => {
      const release = typeof acquire === 'function' ? acquire() : undefined
      effects.push(typeof release === 'function' ? release : () => {})
      effectLabels.push(label)
      return () => {}
    },
  }
}

/**
 * Release every effect a context recorded, newest first.
 *
 * Cordis disposes in reverse registration order, so the listener registered last
 * is released first — the same order the managed-tunnel test relies on. Two
 * properties make this the failure path as well as the happy path:
 *
 *   - `splice(0)` empties the list, so the safety net registered with `t.after`
 *     is a no-op after an explicit call and vice versa;
 *   - a disposer that throws is swallowed, because the assertion that is already
 *     failing is the news. Letting a shutdown error replace it would cost the
 *     reader the actual reason the test went red.
 *
 * This exists because of a real CI failure: the managed-tunnel test below shut
 * its gateway down only on the success path, so one failed assertion on Linux
 * left a listening socket behind, the child test process never exited, and
 * `npm test` sat there until the workflow timed out with no failing test to show
 * for it.
 *
 * @param {{ effects: Array<() => unknown> }} ctx
 * @returns {Promise<void>}
 */
async function disposeEffects(ctx) {
  for (const dispose of ctx.effects.splice(0).reverse()) {
    try {
      await dispose()
    } catch {
      /* the test's own failure is the news; a shutdown error must not replace it */
    }
  }
}

/** A throwaway listener standing in for the official `dsh web` port. */
async function stubOfficialPort() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('official')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}

test('apply starts no listener while remote access is off', async () => {
  /* PRD D1 / acceptance 1: with the switch off, behaviour is identical to a host
     without the plugin. The strongest form of that is "no socket".

     Since stage 4 two effects ARE registered while the switch is off — the audit
     retention timer and the admin API route — and neither opens a listening port:
     the admin API is served by the host's own loopback web server, and the timer
     touches one directory. So the assertion moved from "no effect at all" to
     "no LISTENER", which is what the requirement is actually about. */
  await withTempHome(() => {
    const { calls, logger } = recordingLogger()
    const ctx = gatewayContext({ officialPort: 1, logger })

    const result = entry.apply(ctx)
    assert.equal(result, undefined, 'nothing is binding, so nothing is returned')
    assert.match(calls[0].message, /remote access off/)

    /* Every registered effect must be one of the two stage-4 effects, and neither
       may be a socket. Asserting the LABELS is what makes this a real test: a
       future `server.listen()` registered here would fail it. */
    assert.deepEqual(
      ctx.effectLabels,
      [
        'remote-control: audit retention',
        'remote-control: cloudflared tunnel',
        'remote-control: admin API',
      ],
      'only the retention timer, the tunnel disposer and the admin route, no gateway listener',
    )
    for (const dispose of ctx.effects) dispose()
  })
})

test('apply binds a gateway and logs one listening line when remote access is on', async (t) => {
  const official = await stubOfficialPort()
  try {
    await withTempHome(async (home) => {
      /* Turn the switch on. The port is pinned to 0 through the plugin config —
         the same seam a profile uses — so the test can NEVER bind a real port and
         collide with the DSH instance the suite is running inside. */
      const baseDir = path.join(home, '.dsh', 'remote-control')
      const runtime = entry.createRuntime({ baseDir })
      runtime.store.updateSettings({ enabled: true })

      const { calls, logger } = recordingLogger()
      const ctx = gatewayContext({ officialPort: official.port, logger })
      /* Registered BEFORE the bind, so every failed assertion below still releases
         the listener. A socket left open outlives the test and keeps the whole run
         alive, which is how this file once hung CI for fifteen minutes. */
      t.after(() => disposeEffects(ctx))

      await entry.apply(ctx, { port: 0, host: '127.0.0.1' })

      const infos = calls.filter((call) => call.level === 'info')
      assert.equal(infos.length, 2, 'the load line and the listening line, nothing else')
      assert.match(infos[0].message, /^\[remote-control\] loaded/)

      const listening = infos[1].message
      assert.match(listening, /^\[remote-control\] gateway listening on /)
      assert.match(listening, new RegExp(`upstream 127\\.0\\.0\\.1:${String(official.port)}`))
      /* Never a token or a cookie value. */
      assert.ok(!/[A-Za-z0-9_-]{43,}/.test(listening), 'the listening line carries no secret')

      /* Three effects now: the retention timer, the admin route and the listener.
         The LISTENER is the last one, and it is the one that must be released or
         the port stays held for the rest of the run. Disposing all three is what
         the old single-disposer version was doing implicitly. */
      assert.deepEqual(
        ctx.effectLabels,
        [
          'remote-control: audit retention',
          'remote-control: cloudflared tunnel',
          'remote-control: admin API',
          'remote-control: gateway listener',
        ],
        'the listener is the last effect, and it is registered last',
      )

      await disposeEffects(ctx)
    })
  } finally {
    await official.close()
  }
})

/** A fake `cloudflared` process factory that records what it was asked to run. */
function fakeCloudflared(children) {
  return (binary, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.signals = []
    child.kill = (signal) => {
      child.signals.push(typeof signal === 'string' ? signal : 'SIGTERM')
      child.emit('exit', null, typeof signal === 'string' ? signal : 'SIGTERM')
      return true
    }
    children.push({ binary, args, options, child })
    return child
  }
}

/**
 * A temp file that `resolveTunnelBinary` accepts as a configured `cloudflared`.
 *
 * The execute bit is the part that is easy to forget: `resolveTunnelBinary` tests
 * POSIX paths with `accessSync(..., X_OK)`, and a file created by `writeFileSync`
 * alone has no execute bit on Linux or macOS. The shebang in the content does not
 * help — the mode does. Windows has no POSIX execute bit and accepts the file
 * either way, which is why a missing `chmod` passes on the primary dev platform
 * and fails on the ubuntu runner.
 *
 * @param {string} dir
 * @returns {string} The file's absolute path.
 */
function makeFakeTunnelBinary(dir) {
  const file = path.join(dir, 'cloudflared')
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  try {
    chmodSync(file, 0o755)
  } catch {
    /* Windows has no POSIX execute bit; `resolveTunnelBinary` accepts it there. */
  }
  return file
}

test('the managed tunnel follows the gateway listener and stops with it', async (t) => {
  const official = await stubOfficialPort()
  try {
    await withTempHome(async (home) => {
      const baseDir = path.join(home, '.dsh', 'remote-control')
      const binary = makeFakeTunnelBinary(home)
      /* Assert the fixture BEFORE anything binds. On a POSIX host a file without
         the execute bit resolves to `tunnel/binary-missing`, the tunnel never
         spawns, and `children.length` below fails for a reason that has nothing to
         do with the lifecycle this test is about. */
      assert.equal(
        resolveTunnelBinary({ baseDir, binaryPath: binary, platform: process.platform }).available,
        true,
        'the fake cloudflared must be executable, or this test measures the fixture',
      )
      const runtime = entry.createRuntime({ baseDir })
      runtime.store.updateSettings({
        enabled: true,
        tunnel: { enabled: true, mode: 'quick', binaryPath: binary },
      })

      const children = []
      const { calls, logger } = recordingLogger()
      const ctx = gatewayContext({ officialPort: official.port, logger })
      t.after(() => disposeEffects(ctx))
      await entry.apply(ctx, {
        port: 0,
        host: '127.0.0.1',
        tunnelSpawnImpl: fakeCloudflared(children),
      })
      await new Promise((resolve) => setImmediate(resolve))

      assert.equal(children.length, 1, 'the enabled tunnel starts with the listener')
      assert.equal(children[0].options.shell, false, 'argv array, never a shell')
      assert.match(children[0].args[3], /^http:\/\/127\.0\.0\.1:\d+$/, 'it targets the BOUND port')
      assert.ok(!calls.some((call) => call.level === 'error'))

      children[0].child.stdout.write('https://abc-def-ghi.trycloudflare.com\n')
      await new Promise((resolve) => setImmediate(resolve))

      /* Cordis disposes in reverse order; the listener's disposer is what stops the
         tunnel before the port disappears. */
      await disposeEffects(ctx)
      assert.deepEqual(children[0].child.signals, ['SIGTERM'], 'no cloudflared outlives the plugin')
    })
  } finally {
    await official.close()
  }
})

test('a tunnel that cannot start is reported, and the gateway keeps working', async (t) => {
  const official = await stubOfficialPort()
  try {
    await withTempHome(async (home) => {
      const baseDir = path.join(home, '.dsh', 'remote-control')
      const runtime = entry.createRuntime({ baseDir })
      runtime.store.updateSettings({
        enabled: true,
        tunnel: { enabled: true, mode: 'quick', binaryPath: path.join(home, 'missing-cloudflared') },
      })

      const children = []
      const { calls, logger } = recordingLogger()
      const ctx = gatewayContext({ officialPort: official.port, logger })
      t.after(() => disposeEffects(ctx))
      await entry.apply(ctx, {
        port: 0,
        host: '127.0.0.1',
        tunnelSpawnImpl: fakeCloudflared(children),
      })
      await new Promise((resolve) => setImmediate(resolve))

      /* The LAN gateway is the feature; a missing tunnel binary degrades to a panel
         state and one warn line, never a failed plugin. */
      assert.equal(children.length, 0)
      assert.ok(calls.some((call) => call.level === 'info' && /gateway listening/.test(call.message)))
      assert.ok(calls.some((call) => call.level === 'warn' && /tunnel\/binary-missing/.test(call.message)))

      await disposeEffects(ctx)
    })
  } finally {
    await official.close()
  }
})

test('apply logs the load line before the listening line, so a bind failure is attributable', async () => {
  const official = await stubOfficialPort()
  const blocker = createServer(() => {})
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const heldPort = blocker.address().port

  try {
    await withTempHome(async (home) => {
      const runtime = entry.createRuntime({ baseDir: path.join(home, '.dsh', 'remote-control') })
      runtime.store.updateSettings({ enabled: true })

      const { calls, logger } = recordingLogger()
      await assert.rejects(
        () => entry.apply(gatewayContext({ officialPort: official.port, logger }), { port: heldPort, host: '127.0.0.1' }),
        (error) => error.code === 'EADDRINUSE',
        'a port in use must fail the row, not be warned about',
      )
      /* The load line was printed; the listening line was not. No warn either,
         because this context CAN register the admin route. */
      assert.equal(calls.length, 1, 'the load line was printed, the listening line was not')
      assert.match(calls[0].message, /loaded/)
    })
  } finally {
    await new Promise((resolve) => { blocker.closeAllConnections(); blocker.close(resolve) })
    await official.close()
  }
})

test('apply refuses to start when the official server reports no port', async () => {
  /* Fail loudly rather than bind a gateway that proxies to nowhere. The throw is
     SYNCHRONOUS on purpose: a precondition failure must fail the fiber at the
     moment of the call, not as a floating rejection (see the `apply` note). */
  await withTempHome(async (home) => {
    const runtime = entry.createRuntime({ baseDir: path.join(home, '.dsh', 'remote-control') })
    runtime.store.updateSettings({ enabled: true })

    const { calls, logger } = recordingLogger()
    assert.throws(
      () => entry.apply(gatewayContext({ officialPort: 0, logger }), { port: 0, host: '127.0.0.1' }),
      (error) => error.code === 'gateway/invalid-upstream',
    )
    assert.equal(calls.filter((call) => /gateway listening/.test(call.message)).length, 0)
  })
})

/* ------------------------------------------------------------------ *
 * Stage 4: the audit retention sweep is gated on nothing
 * ------------------------------------------------------------------ */

test('apply prunes expired audit day files at startup, even with remote access off', async () => {
  /* `prd.md` R5's retention is about the FILES, not about the feature being on. A
     user who turns remote access off for a month must not come back to a
     directory full of files older than the documented window. */
  await withTempHome((home) => {
    const baseDir = path.join(home, '.dsh', 'remote-control')
    const runtime = entry.createRuntime({ baseDir })
    const today = Date.now()
    /* One file well outside the window, one inside it. Dates are derived from the
       real clock because `apply` resolves its own clock — the point here is that
       the sweep runs on the LOAD path, not that it can be time-travelled. */
    const expired = new Date(today - 40 * 86_400_000).toISOString().slice(0, 10)
    const fresh = new Date(today - 2 * 86_400_000).toISOString().slice(0, 10)
    mkdirSync(baseDir, { recursive: true })
    writeFileSync(path.join(baseDir, `audit-${expired}.jsonl`), '')
    writeFileSync(path.join(baseDir, `audit-${fresh}.jsonl`), '')
    /* And a file that is NOT ours: the sweep must not touch it. */
    writeFileSync(path.join(baseDir, 'notes.txt'), 'keep me')

    const { calls, logger } = recordingLogger()
    const ctx = gatewayContext({ officialPort: 1, logger })
    entry.apply(ctx)

    assert.equal(existsSync(path.join(baseDir, `audit-${expired}.jsonl`)), false, 'the expired file is gone')
    assert.equal(existsSync(path.join(baseDir, `audit-${fresh}.jsonl`)), true, 'the fresh one is kept')
    assert.equal(existsSync(path.join(baseDir, 'notes.txt')), true, 'a foreign file is never deleted')
    assert.ok(
      calls.some((call) => call.level === 'warn' && /audit retention removed 1 expired/.test(call.message)),
      'the deletion is reported once, as a warning',
    )
    for (const dispose of ctx.effects) dispose()
  })
})

test('an audit failure is a warning, never a fatal load or a thrown request', async () => {
  /* `quality-guidelines.md` §5 / the module note in `audit.js`: an unwritable
     audit trail must be VISIBLE but not FATAL. The requests it would have
     recorded were already authorized, so failing the plugin over it would take
     remote access down for a reason that has nothing to do with access. */
  await withTempHome((home) => {
    /* A FILE where the audit DIRECTORY should be: every listing and every append
       against it fails with ENOTDIR. (A missing directory is deliberately not a
       failure — it is the first run.) */
    const blocked = path.join(home, 'blocked')
    writeFileSync(blocked, 'not a directory')

    const { calls, logger } = recordingLogger()
    const audit = entry.createRuntime({
      baseDir: blocked,
      onAuditError: (error) => logger.warn(`[remote-control] audit: ${error.code}`),
    }).audit

    assert.deepEqual(audit.prune().deleted, [], 'prune survives a directory it cannot read')
    assert.ok(
      calls.some((call) => /audit: audit\/unreadable/.test(call.message)),
      'the sweep failure is reported as a warning',
    )

    /* And a failed append is reported, not thrown: this is the path a request
       would take. */
    const line = audit.record({ event: 'connect', deviceId: 'dev_1' })
    assert.equal(line, null, 'nothing was written')
    assert.ok(audit.stats.failures > 0, 'the failure was counted')
    assert.ok(
      calls.some((call) => /audit: audit\/write-failed/.test(call.message)),
      'the append failure is reported too',
    )
  })
})

/* ------------------------------------------------------------------ *
 * Hot reload: the switch and the port apply to THIS process
 * ------------------------------------------------------------------ */

/**
 * The official `dsh web` port with a real route table.
 *
 * The admin guard requires a loopback socket, a loopback `Host` and the origin
 * fence, so the hot-reload tests must reach the API over a REAL socket: a fake
 * request object would skip exactly the admission path the panel uses.
 */
async function officialHost() {
  const routes = new Map()
  const server = createServer((req, res) => {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      res.writeHead(400).end()
      return
    }
    let best
    for (const [prefix, route] of routes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.prefix.length) best = { prefix, route }
    }
    if (best === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    Promise.resolve(best.route.handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    webServer: {
      port,
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}

/**
 * One JSON request against the official loopback port.
 *
 * @param {number} port
 * @param {{ method?: string, path: string, body?: object }} spec
 */
function adminRequest(port, { method = 'GET', path: target, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path: target,
      headers: {
        host: `127.0.0.1:${String(port)}`,
        'sec-fetch-site': 'same-origin',
        ...(payload === null
          ? {}
          : { 'content-type': 'application/json', 'content-length': String(payload.length) }),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

/** Whether a loopback TCP port accepts a connection right now. */
function isListening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const settle = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/**
 * A port that was free a moment ago.
 *
 * Only ever used as `settings.port`; the plugin's own config seam (`port: 0`) is
 * how the other tests avoid picking a number at all.
 */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/**
 * A context sufficient for `apply` to start a gateway AND route the admin API.
 *
 * Same shape as {@link gatewayContext}, but the web server is a real listener so
 * the panel's own HTTP path (guard + fence + handler) runs.
 */
function hotReloadContext({ webServer, logger }) {
  const effects = []
  const effectLabels = []
  const ctx = {
    effects,
    effectLabels,
    logger,
    webServer,
    get: () => undefined,
    effect: (acquire, label) => {
      const release = typeof acquire === 'function' ? acquire() : undefined
      effects.push(typeof release === 'function' ? release : () => {})
      effectLabels.push(label)
      return () => {}
    },
  }
  return ctx
}

test('turning remote access off closes the listener without a restart', async (t) => {
  /* The switch used to be restart-only, which is a switch the user does not believe.
     `prd.md` D1 also says "off" must be indistinguishable from "not installed", and
     a released socket is the only proof of that. */
  const official = await officialHost()
  try {
    await withTempHome(async (home) => {
      const runtime = entry.createRuntime({ baseDir: path.join(home, '.dsh', 'remote-control') })
      const port = await freePort()
      runtime.store.updateSettings({ enabled: true, port })

      const { calls, logger } = recordingLogger()
      const ctx = hotReloadContext({ webServer: official.webServer, logger })
      t.after(() => disposeEffects(ctx))
      await entry.apply(ctx, { host: '127.0.0.1' })
      assert.equal(await isListening(port), true, 'the switch was on at load, so it listens')

      const off = await adminRequest(official.port, {
        method: 'POST',
        path: `${ADMIN_API_PREFIX}/settings`,
        body: { enabled: false },
      })
      assert.equal(off.status, 200)
      assert.equal(off.json.data.requiresReload, false, 'nothing is left to restart')
      assert.equal(await isListening(port), false, 'the port is released immediately')
      assert.ok(
        calls.some((call) => /gateway stopped/.test(call.message)),
        'the stop is reported on the host log',
      )

      const state = await adminRequest(official.port, { path: `${ADMIN_API_PREFIX}/state` })
      assert.equal(state.json.data.gateway, null, 'the panel is told the truth, not the setting')

      const on = await adminRequest(official.port, {
        method: 'POST',
        path: `${ADMIN_API_PREFIX}/settings`,
        body: { enabled: true },
      })
      assert.equal(on.status, 200)
      assert.equal(on.json.data.applied, true)
      assert.equal(await isListening(port), true, 'the switch turns it back on in the same process')
      assert.equal(
        ctx.effectLabels.filter((label) => label === 'remote-control: gateway listener').length,
        1,
        'one listener disposer across every bind, not one per bind',
      )

      await disposeEffects(ctx)
    })
  } finally {
    await official.close()
  }
})

test('changing the port moves the listener and releases the old one', async (t) => {
  const official = await officialHost()
  try {
    await withTempHome(async (home) => {
      const runtime = entry.createRuntime({ baseDir: path.join(home, '.dsh', 'remote-control') })
      const first = await freePort()
      let second = await freePort()
      for (let attempt = 0; attempt < 8 && second === first; attempt += 1) second = await freePort()
      assert.notEqual(second, first, 'two distinct free ports are needed for this test')

      runtime.store.updateSettings({ enabled: true, port: first })
      const { logger } = recordingLogger()
      const ctx = hotReloadContext({ webServer: official.webServer, logger })
      t.after(() => disposeEffects(ctx))
      await entry.apply(ctx, { host: '127.0.0.1' })
      assert.equal(await isListening(first), true)

      const moved = await adminRequest(official.port, {
        method: 'POST',
        path: `${ADMIN_API_PREFIX}/settings`,
        body: { port: second },
      })
      assert.equal(moved.status, 200)
      assert.equal(moved.json.data.requiresReload, false)
      assert.equal(moved.json.data.applied, true)
      assert.equal(await isListening(second), true, 'the new port is bound')
      assert.equal(await isListening(first), false, 'the old port is released')

      const state = await adminRequest(official.port, { path: `${ADMIN_API_PREFIX}/state` })
      assert.equal(state.json.data.gateway.port, second, 'the state read names the port actually bound')

      await disposeEffects(ctx)
    })
  } finally {
    await official.close()
  }
})

test('a port another process holds is refused and the running listener stays up', async (t) => {
  /* Bind-before-release: a mistyped or occupied port must cost the user an error,
     not their remote session. The setting is restored so the panel and the file
     keep agreeing with the socket that is still open. */
  const official = await officialHost()
  const blocker = createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const heldPort = blocker.address().port
  try {
    await withTempHome(async (home) => {
      const runtime = entry.createRuntime({ baseDir: path.join(home, '.dsh', 'remote-control') })
      const port = await freePort()
      runtime.store.updateSettings({ enabled: true, port })

      const { logger } = recordingLogger()
      const ctx = hotReloadContext({ webServer: official.webServer, logger })
      t.after(() => disposeEffects(ctx))
      await entry.apply(ctx, { host: '127.0.0.1' })
      assert.equal(await isListening(port), true)

      const refused = await adminRequest(official.port, {
        method: 'POST',
        path: `${ADMIN_API_PREFIX}/settings`,
        body: { port: heldPort },
      })
      assert.equal(refused.status, 409)
      assert.equal(refused.json.error.code, 'admin/listener-failed')
      assert.ok(!refused.json.error.message.includes('EADDRINUSE'), 'no raw errno in the message')

      assert.equal(runtime.store.getSettings().port, port, 'the setting is restored')
      assert.equal(await isListening(port), true, 'the previous listener never went down')

      const state = await adminRequest(official.port, { path: `${ADMIN_API_PREFIX}/state` })
      assert.equal(state.json.data.gateway.port, port, 'the state read agrees with the live socket')

      await disposeEffects(ctx)
    })
  } finally {
    await new Promise((resolve) => { blocker.closeAllConnections(); blocker.close(resolve) })
    await official.close()
  }
})
