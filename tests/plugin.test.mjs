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
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import * as entry from '../src/index.js'
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
  await withTempHome(() => {
    const { calls, logger } = recordingLogger()
    entry.apply({ logger })

    assert.equal(calls.length, 1, 'stage 0 acceptance is exactly one line')
    assert.equal(calls[0].level, 'info')
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
