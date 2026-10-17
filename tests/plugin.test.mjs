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
import { createServer } from 'node:http'
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
  return {
    effects,
    logger,
    webServer: { port: officialPort },
    get: () => undefined,
    effect: (execute) => {
      effects.push(execute())
      return () => {}
    },
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
     without the plugin. The strongest form of that is "no socket, no effect". */
  await withTempHome(() => {
    const { calls, logger } = recordingLogger()
    const ctx = gatewayContext({ officialPort: 1, logger })

    const result = entry.apply(ctx)
    assert.equal(result, undefined, 'nothing is binding, so nothing is returned')
    assert.equal(calls.length, 1, 'still exactly one load line')
    assert.match(calls[0].message, /remote access off/)
    assert.deepEqual(ctx.effects, [], 'no effect was registered')
  })
})

test('apply binds a gateway and logs one listening line when remote access is on', async () => {
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

      await entry.apply(ctx, { port: 0, host: '127.0.0.1' })

      const infos = calls.filter((call) => call.level === 'info')
      assert.equal(infos.length, 2, 'the load line and the listening line, nothing else')
      assert.match(infos[0].message, /^\[remote-control\] loaded/)

      const listening = infos[1].message
      assert.match(listening, /^\[remote-control\] gateway listening on /)
      assert.match(listening, new RegExp(`upstream 127\\.0\\.0\\.1:${String(official.port)}`))
      /* Never a token or a cookie value. */
      assert.ok(!/[A-Za-z0-9_-]{43,}/.test(listening), 'the listening line carries no secret')

      assert.equal(ctx.effects.length, 1, 'the listener registered exactly one disposer')
      await ctx.effects[0]()
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
