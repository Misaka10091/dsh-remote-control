/**
 * The admin API: loopback-only, and not on the gateway port at all.
 *
 * ## Two layers, tested separately, because either one alone is a bypass
 *
 * `prd.md` R4: pairing grants session access, not administration. The tests below
 * prove BOTH layers independently, because a suite that only proved the second
 * would pass even if the route were mounted on the LAN-facing port:
 *
 *   1. **Not served on the gateway port.** `startGateway` refuses the prefix, so a
 *      paired remote device cannot reach the admin API through the one listener
 *      the LAN can see. This is the layer that matters, because the gateway
 *      rewrites `Host` to loopback before forwarding — a proxied admin request
 *      would satisfy the API's own loopback guard.
 *   2. **Loopback + origin fence on the official port.** Even a request that
 *      ARRIVES at the official server is checked, with both halves of the
 *      loopback test (DNS rebinding) and the CSRF fence on top.
 *
 * The official server is simulated with a real `http.Server` on port 0 whose
 * request handler is the one `webServer.register` captured — so the route
 * dispatch, the real headers and a real socket are all exercised. No real DSH
 * instance is touched and no fixed port is ever bound.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createAudit, dayKeyOf } from '../src/host/audit.js'
import { startAdminApi } from '../src/host/api.js'
import { classify } from '../src/host/classify.js'
import { ADMIN_API_PREFIX, DEVICE_COOKIE_NAME } from '../src/host/constants.js'
import { createPairingStore } from '../src/host/pairing.js'
import { createStore } from '../src/host/store.js'
import { startGateway } from '../src/host/gateway/server.js'
import { TEST_JWT_KEY, cleanupDir, makeTempDir, pairDevice } from './helpers.mjs'

/** Fixed clock: 2026-10-17T03:04:43.000Z. */
const AT = Date.UTC(2026, 9, 17, 3, 4, 43)

/**
 * The NIC list every admin-API test reports.
 *
 * Injected (`startAdminApi` takes `listLanAddresses`) because the real
 * `os.networkInterfaces()` differs per machine: an assertion about `GET /state`
 * must not describe the runner's hardware, and a suite that silently depends on
 * "this box has a 192.168 address" fails only on somebody else's laptop.
 */
const FAKE_LAN = [
  { address: '192.168.1.5', iface: 'WLAN', private: true },
  { address: '10.0.0.7', iface: 'Ethernet', private: true },
]

/** The default access block a fresh store carries. */
const DEFAULT_ACCESS = { mode: 'lan', lanAddress: '', public: [], selectedPublicId: null }

/** Every listener started by a test, torn down in `after`. */
const started = []

after(async () => {
  for (const stop of started.splice(0)) {
    try {
      await stop()
    } catch {
      /* teardown must never fail a test run */
    }
  }
})

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/**
 * A runtime directory: store, pairing and audit bound together with one clock.
 *
 * @param {object} [spec]
 * @param {boolean} [spec.withDevice] Whether to pair one device.
 */
function makeRuntime(spec = {}) {
  const dir = makeTempDir()
  const clock = { now: AT }
  const store = createStore({ baseDir: dir, now: () => clock.now })
  const audit = createAudit({ baseDir: dir, now: () => clock.now })
  const pairing = createPairingStore({
    now: () => clock.now,
    random: (size) => Buffer.alloc(size, 7),
    onFailure: (failure) => {
      audit.record({
        event: 'pair_failed',
        ip: failure.source ?? undefined,
        meta: {
          ...(failure.pairId === null ? {} : { pairId: failure.pairId }),
          code: failure.code,
        },
      })
    },
  })

  let token
  if (spec.withDevice !== false) {
    token = pairDevice(store, { id: 'dev_1', name: 'iPhone · Safari' }).token
  }

  return { dir, clock, store, audit, pairing, token }
}

/**
 * Start the admin API on a REAL server, dispatching exactly as the official
 * `WebServer` does: by pathname, through the handler the registration captured.
 *
 * @param {object} spec
 * @param {object} spec.runtime From {@link makeRuntime}.
 * @param {object} [spec.gateway] A started gateway, for `revoke` delegation.
 * @param {string[]} [spec.log] Receives log lines.
 */
async function startAdminHost(spec) {
  const log = spec.log ?? []
  const registered = []
  /** What `ctx.effect` collected, so the suite can prove the route is disposable. */
  const effects = []

  /* The route table the fake official server dispatches from — the same
     `{ kind, path, handler }` shape `WebServer.register` stores. */
  const routes = new Map()
  const webServer = {
    port: 0,
    register: (route) => {
      registered.push(route)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    effect: (acquire, label) => {
      const release = typeof acquire === 'function' ? acquire() : undefined
      effects.push({ release: typeof release === 'function' ? release : () => {}, label })
      return () => {}
    },
    get: () => undefined,
  }

  const api = startAdminApi({
    ctx,
    webServer,
    store: spec.runtime.store,
    pairing: spec.runtime.pairing,
    audit: spec.runtime.audit,
    getGateway: () => spec.gateway ?? null,
    /* A fixed NIC list, so `GET /state` is asserted against a known answer rather
       than against the machine running the suite. */
    listLanAddresses: spec.listLanAddresses ?? (() => FAKE_LAN),
    logger: {
      debug: () => {}, info: () => {}, error: () => {},
      warn: (message) => log.push(message),
    },
  })

  /* The official server: prefix dispatch over the registered table, exactly like
     `WebServer.match` (exact first, then longest prefix). */
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

  const stop = async () => {
    for (const effect of effects) await effect.release()
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
  }
  started.push(stop)

  return { api, server, port: server.address().port, routes, registered, effects, log, stop }
}

/**
 * Issue one request against a listener.
 *
 * Raw `http.request` and not `fetch`: the tests must control `Host` precisely —
 * that header is half of the loopback test — and `fetch` normalizes it away.
 *
 * @param {object} spec
 * @param {number} spec.port
 * @param {string} [spec.method]
 * @param {string} [spec.path]
 * @param {Record<string, string>} [spec.headers]
 * @param {string} [spec.body]
 */
function send(spec) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: spec.port,
      method: spec.method ?? 'GET',
      path: spec.path ?? '/',
      headers: spec.headers ?? {},
      agent: false,
    }, (res) => {
      const chunks = []
      res.setEncoding('utf8')
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: chunks.join(''),
      }))
    })
    req.on('error', reject)
    if (spec.body !== undefined) req.write(spec.body)
    req.end()
  })
}

/** The `Host` a LOCAL browser sends when it opens `http://localhost:<port>/`. */
function loopbackHost(port) {
  return `127.0.0.1:${String(port)}`
}

/* ------------------------------------------------------------------ *
 * Layer 2: loopback + origin, on the official port
 * ------------------------------------------------------------------ */

test('the route is registered on the official server at the documented prefix', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    assert.equal(host.api.available, true)
    assert.equal(host.registered.length, 1)
    assert.deepEqual(
      { kind: host.registered[0].kind, path: host.registered[0].path },
      { kind: 'prefix', path: ADMIN_API_PREFIX },
      'a prefix route under /remote-control/api',
    )
    assert.equal(typeof host.registered[0].handler, 'function')

    /* Registered through `ctx.effect`, so a hot reload removes it rather than
       leaving a duplicate that makes the next registration throw. */
    assert.deepEqual(host.effects.map((effect) => effect.label), ['remote-control: admin API'])
    assert.equal(host.routes.has(ADMIN_API_PREFIX), true, 'the registration really ran')
    await host.effects[0].release()
    assert.equal(host.routes.has(ADMIN_API_PREFIX), false, 'and the disposer unregisters it')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('a loopback request with a loopback Host is served', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const res = await send({
      port: host.port,
      path: `${ADMIN_API_PREFIX}/devices`,
      headers: { host: loopbackHost(host.port), accept: 'application/json' },
    })

    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /application\/json/)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.data.devices.length, 1)
    assert.equal(body.data.devices[0].id, 'dev_1')
    assert.equal(body.data.devices[0].name, 'iPhone · Safari')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('a non-loopback Host is refused even over a loopback socket (DNS rebinding)', async () => {
  /* The attack the Host half exists for: a page on a public site resolves a name
     to 127.0.0.1, so the socket genuinely IS loopback while the request was never
     meant for this machine. The socket half alone would admit it. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    for (const hostHeader of [
      `192.168.1.7:${String(host.port)}`,
      `rebind.evil.example:${String(host.port)}`,
      'evil.example',
    ]) {
      const res = await send({
        port: host.port,
        path: `${ADMIN_API_PREFIX}/devices`,
        headers: { host: hostHeader },
      })
      assert.equal(res.status, 403, hostHeader)
      const body = JSON.parse(res.body)
      assert.equal(body.ok, false)
      assert.equal(body.error.code, 'admin/loopback-only')
    }
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('a loopback request with no Host at all is refused', async () => {
  /* HTTP/1.0-shaped or hand-rolled: no Host means the authority half of the test
     cannot hold, so the request is treated as remote.
     Note on the wire: node's own HTTP/1.1 parser rejects a missing `Host` with a
     400 before any handler runs, so over a real socket this test can only assert
     "refused". The exact arm is asserted on {@link guard} below, where a request
     without `Host` is available to the code under test. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: host.port,
        path: `${ADMIN_API_PREFIX}/devices`,
        /* `setHost: false` suppresses the header node would add. */
        setHost: false,
        agent: false,
      }, (response) => {
        const chunks = []
        response.setEncoding('utf8')
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode, body: chunks.join('') }))
      })
      req.on('error', reject)
      req.end()
    })
    assert.ok(res.status >= 400, `refused, got ${String(res.status)}`)
    assert.ok(!res.body.includes('dev_1'), 'and never the device list')

    /* The arm itself: no Host is not loopback. */
    const verdict = host.api.guard({ socket: { remoteAddress: '127.0.0.1' }, headers: {}, method: 'GET' })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'admin/loopback-only')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('the origin fence applies to the loopback arm — a cross-site write is refused', async () => {
  /* `quality-guidelines.md` §8: an "exempt" branch must not skip the fence. This
     is the stage-2 defect in a new place, so it gets its own test: a no-preflight
     form post from a page on another site reaches a loopback socket with a
     loopback Host, and every one of these routes mutates state. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const crossSite = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/devices/dev_1/revoke`,
      headers: {
        host: loopbackHost(host.port),
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain',
      },
      body: '',
    })
    assert.equal(crossSite.status, 403)
    assert.equal(JSON.parse(crossSite.body).error.code, 'admin/cross-origin')
    assert.equal(runtime.store.listDevices()[0].revokedAt, null, 'the device was NOT revoked')

    /* The same page relying on a form post, which older browsers send with no
       Sec-Fetch-Site: refused on the Origin arm instead. */
    const formPost = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/devices/dev_1/revoke`,
      headers: {
        host: loopbackHost(host.port),
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: '',
    })
    assert.equal(formPost.status, 403)
    assert.equal(JSON.parse(formPost.body).error.code, 'admin/cross-origin')
    assert.equal(runtime.store.listDevices()[0].revokedAt, null, 'still not revoked')

    /* An unmarked local write (no Origin, no Sec-Fetch-Site) is the fourth arm:
       refused, because nothing proves where it came from. */
    const unmarked = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/devices/dev_1/revoke`,
      headers: { host: loopbackHost(host.port) },
      body: '',
    })
    assert.equal(unmarked.status, 403)
    assert.equal(JSON.parse(unmarked.body).error.code, 'admin/cross-origin')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('a same-origin write from the local page is allowed, so the panel works', async () => {
  /* The guarantee that must survive the fence: the desktop browser calls this API
     from the DSH page's own origin. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const withOrigin = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/devices/dev_1/revoke`,
      headers: {
        host: loopbackHost(host.port),
        origin: `http://${loopbackHost(host.port)}`,
        'content-type': 'application/json',
      },
      body: '',
    })
    assert.equal(withOrigin.status, 200)
    assert.notEqual(runtime.store.listDevices()[0].revokedAt, null)
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('the guard reports both arms independently, for a unit-level assertion', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    /* Loopback socket AND Host: admitted. */
    assert.deepEqual(host.api.guard({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3090' }, method: 'GET' }), { ok: true })
    /* Remote socket: refused. */
    const remote = host.api.guard({ socket: { remoteAddress: '192.168.1.7' }, headers: { host: '127.0.0.1:3090' }, method: 'GET' })
    assert.equal(remote.ok, false)
    assert.equal(remote.code, 'admin/loopback-only')
    /* Loopback socket, public Host: refused (rebinding). */
    const rebound = host.api.guard({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example' }, method: 'GET' })
    assert.equal(rebound.code, 'admin/loopback-only')
    /* Both halves right, cross-site: refused by the fence, NOT by the loopback arm. */
    const crossSite = host.api.guard({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3090', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      method: 'POST',
    })
    assert.equal(crossSite.ok, false)
    assert.equal(crossSite.code, 'admin/cross-origin')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

/* ------------------------------------------------------------------ *
 * Layer 1: the admin API is not on the gateway port at all
 * ------------------------------------------------------------------ */

test('the gateway refuses the admin prefix outright, so a paired device cannot reach it', async () => {
  /* THE boundary test. The gateway forwards from loopback with `Host` rewritten
     to `127.0.0.1:<officialPort>`, so a proxied admin request WOULD satisfy the
     admin API's own loopback guard — the proxy hop would verify itself. The
     refusal here is what makes `prd.md` R4 true.
     A REAL device cookie is presented: the refusal must not depend on being
     unpaired, because a paired device is exactly the attacker this guards. */
  const runtime = makeRuntime()
  /* The upstream the gateway would forward to. It must see NOTHING. */
  const upstreamHits = []
  const upstream = createServer((req, res) => {
    upstreamHits.push(req.url)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('official')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  const gateway = await startGateway({
    ctx: { effect: () => () => {}, get: () => undefined },
    store: runtime.store,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
    audit: runtime.audit,
    now: () => runtime.clock.now,
  })
  started.push(async () => {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
  })

  try {
    for (const path of [
      `${ADMIN_API_PREFIX}/devices`,
      `${ADMIN_API_PREFIX}/devices/dev_1/revoke`,
      `${ADMIN_API_PREFIX}/audit/export`,
      '/remote-control/api',
    ]) {
      const res = await send({
        port: gateway.port,
        path,
        headers: {
          /* A LAN authority, i.e. a real remote device. */
          host: `192.168.1.7:${String(gateway.port)}`,
          /* A genuine, currently-valid device cookie. */
          cookie: `${DEVICE_COOKIE_NAME}=${runtime.token}`,
        },
      })
      assert.equal(res.status, 403, path)
      assert.equal(JSON.parse(res.body).error.code, 'gateway/admin-not-here', path)
    }

    assert.equal(upstreamHits.length, 0, 'not one admin request reached the official port')
    /* And the refusal did not depend on the device being revoked. */
    assert.equal(runtime.store.listDevices()[0].revokedAt, null)
  } finally {
    cleanupDir(runtime.dir)
  }
})

test('the gateway refuses the admin prefix before authorization, for the same answer either way', async () => {
  /* Even a loopback request on the gateway port is refused. The admin API exists
     on the OFFICIAL port and nowhere else, so answering it here — for anyone —
     would create a second, weaker path to the same authority. */
  const upstreamHits = []
  const upstream = createServer((req, res) => {
    upstreamHits.push(req.url)
    res.writeHead(200).end('official')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  const runtime = makeRuntime()
  const gateway = await startGateway({
    ctx: { effect: () => () => {}, get: () => undefined },
    store: runtime.store,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
  })
  started.push(async () => {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
  })

  try {
    const res = await send({
      port: gateway.port,
      path: `${ADMIN_API_PREFIX}/devices`,
      headers: { host: `127.0.0.1:${String(gateway.port)}` },
    })
    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).error.code, 'gateway/admin-not-here')
    assert.equal(upstreamHits.length, 0)
  } finally {
    cleanupDir(runtime.dir)
  }
})

/* ------------------------------------------------------------------ *
 * Revocation goes through the gateway (`quality-guidelines.md` §18)
 * ------------------------------------------------------------------ */

test('revoke goes through gateway.revokeDevice, so live sockets are closed', async () => {
  /* The whole point of §18. Calling `store.revokeDevice()` directly would leave
     an already-upgraded WebSocket streaming — `prd.md` constraint 5 half met. */
  const runtime = makeRuntime()
  const calls = []
  /* A stand-in gateway recording how it was invoked, plus a socket registry with
     a live socket for dev_1 that must be closed. */
  const closed = []
  const gateway = {
    server: { listening: true },
    host: '0.0.0.0',
    port: 3090,
    upstream: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
    activity: { flush: (id) => calls.push(['flush', id]) },
    upgradeProxy: {
      sockets: {
        count: () => 1,
        countFor: (id) => (id === 'dev_1' ? 1 : 0),
        closeDevice: (id) => { closed.push(id); return 1 },
      },
    },
    revokeDevice: (id) => {
      calls.push(['gateway.revokeDevice', id])
      /* What the real one does, in order: flush, store, close. */
      const device = runtime.store.revokeDevice(id)
      const closedSockets = gateway.upgradeProxy.sockets.closeDevice(id)
      return { device, closedSockets }
    },
  }

  const host = await startAdminHost({ runtime, gateway })
  try {
    const res = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/devices/dev_1/revoke`,
      headers: { host: loopbackHost(host.port), origin: `http://${loopbackHost(host.port)}` },
      body: '',
    })

    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.data.id, 'dev_1')
    assert.equal(body.data.closedSockets, 1, 'the response reports the sockets that were closed')

    assert.deepEqual(calls, [['gateway.revokeDevice', 'dev_1']], 'the gateway entry point was used')
    assert.deepEqual(closed, ['dev_1'], 'and the live socket was actually closed')
    assert.notEqual(runtime.store.listDevices()[0].revokedAt, null, 'the store was updated too')

    /* The revocation is audited, with the count — the observable proof that it
       was immediate rather than merely recorded. */
    const raw = readFileSync(path.join(runtime.dir, `audit-${dayKeyOf(AT)}.jsonl`), 'utf8')
    const lines = raw.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    const revoke = lines.find((line) => line.event === 'revoke')
    assert.ok(revoke !== undefined, 'a revoke line was written')
    assert.equal(revoke.deviceId, 'dev_1')
    assert.equal(revoke.meta.closedSockets, 1)
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('with no gateway running, revoke still works and reports zero closed sockets', async () => {
  /* Remote access off: there is no listener, so there are no live sockets to
     close. The two halves are not being separated — only one exists. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const res = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/devices/dev_1/revoke`,
      headers: { host: loopbackHost(host.port), origin: `http://${loopbackHost(host.port)}` },
      body: '',
    })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.data.closedSockets, 0)
    assert.notEqual(runtime.store.listDevices()[0].revokedAt, null)
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('revoking an unknown device is a 404 with the documented envelope', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const res = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/devices/dev_nope/revoke`,
      headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin' },
      body: '',
    })
    assert.equal(res.status, 404)
    const body = JSON.parse(res.body)
    assert.deepEqual(Object.keys(body), ['ok', 'error'])
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'admin/unknown-device')
    assert.equal(typeof body.error.message, 'string')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('a malformed device id is refused before it reaches the store', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    for (const id of ['..', 'dev_', 'token-not-an-id', encodeURIComponent('../../etc/passwd')]) {
      const res = await send({
        port: host.port,
        method: 'POST',
        path: `${ADMIN_API_PREFIX}/devices/${id}/revoke`,
        headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin' },
        body: '',
      })
      assert.ok(res.status === 400 || res.status === 404, `${id} -> ${String(res.status)}`)
      assert.equal(JSON.parse(res.body).ok, false)
    }
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

/* ------------------------------------------------------------------ *
 * The device list never leaks the verifier
 * ------------------------------------------------------------------ */

test('the device list omits every credential field and every other internal one', async () => {
  /* The panel gets the ROW. What it must never get is anything that could be used
     as, or turned into, a credential: no JWT, no `tokenHash` verifier (a page
     holding one can brute-force a candidate offline), and not the raw document. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const res = await send({
      port: host.port,
      path: `${ADMIN_API_PREFIX}/devices`,
      headers: { host: loopbackHost(host.port) },
    })
    assert.ok(!res.body.includes(runtime.token), 'the device JWT is not in the response')
    assert.ok(!/eyJ[A-Za-z0-9_-]{6,}\./.test(res.body), 'and no JWT-shaped value of any kind')
    assert.ok(!res.body.includes('tokenHash'))
    assert.ok(!res.body.includes('capabilities'), 'reserved internal fields stay internal')
    const device = JSON.parse(res.body).data.devices[0]
    assert.deepEqual(
      Object.keys(device).sort(),
      ['createdAt', 'id', 'lastSeenAt', 'liveConnections', 'name', 'revokedAt', 'ua'],
    )
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

/* ------------------------------------------------------------------ *
 * Pairing, settings, state
 * ------------------------------------------------------------------ */

test('creating a pairing code returns it once and audits nothing about it', async () => {
  /* The code goes to the loopback browser in this response and nowhere else: it
     is never logged, never audited and never written to disk
     (`logging-guidelines.md` — a pairing code is on the never-log list). */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const res = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/pairing`,
      headers: {
        host: loopbackHost(host.port),
        origin: `http://${loopbackHost(host.port)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ label: 'my phone' }),
    })

    assert.equal(res.status, 200)
    const data = JSON.parse(res.body).data
    assert.match(data.pairId, /^pair_/)
    assert.equal(data.code.length, 8)
    assert.equal(data.fragment, `${data.pairId}:${data.code}`)
    assert.equal(data.pairPath, '/remote-control/pair')
    assert.match(data.expiresAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(data.ttlMs, 120_000)

    /* Nothing about the code is on disk, and no log line mentions it. */
    const auditFile = path.join(runtime.dir, `audit-${dayKeyOf(AT)}.jsonl`)
    let auditText = ''
    try {
      auditText = readFileSync(auditFile, 'utf8')
    } catch {
      auditText = ''
    }
    assert.ok(!auditText.includes(data.code), 'the code is not in the audit trail')
    assert.ok(!host.log.some((line) => line.includes(data.code)), 'and not in the log')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('a failed pairing is audited as pair_failed', async () => {
  /* `research/official-connection-fence.md` §7.1: 爆破不可见 — the user cannot
     notice someone guessing unless a failed attempt leaves a trace. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const pair = runtime.pairing.create()
    /* Five wrong codes: the per-pair budget is 5, so the last one locks the pair. */
    for (let index = 0; index < 5; index += 1) {
      assert.throws(
        () => runtime.pairing.redeem(pair.pairId, 'AAAAAAAA', { source: '192.168.1.9' }),
      )
    }

    const raw = readFileSync(path.join(runtime.dir, `audit-${dayKeyOf(AT)}.jsonl`), 'utf8')
    const lines = raw.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    const failures = lines.filter((line) => line.event === 'pair_failed')
    assert.equal(failures.length, 5, 'every guess is recorded')
    for (const line of failures) {
      assert.equal(line.ip, '192.168.1.9', 'the source address is the useful correlate')
      assert.equal(line.deviceId, undefined, 'a failed pairing has no device')
      assert.equal(line.meta.pairId, pair.pairId, 'and the pair id, for correlation')
      assert.ok(['pairing/invalid-code', 'pairing/locked'].includes(line.meta.code), line.meta.code)
    }
    /* The CODE itself is never in the trail — it is not even in scope where the
       failure is reported. */
    assert.ok(!raw.includes(pair.code), 'the pairing code is not in the audit')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('settings are readable and writable, and a reload is flagged', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const before = await send({
      port: host.port,
      path: `${ADMIN_API_PREFIX}/settings`,
      headers: { host: loopbackHost(host.port) },
    })
    assert.equal(JSON.parse(before.body).data.settings.enabled, false)

    const after = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/settings`,
      headers: {
        host: loopbackHost(host.port),
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: true, port: 3091 }),
    })
    assert.equal(after.status, 200)
    const data = JSON.parse(after.body).data
    assert.deepEqual(data.settings, { enabled: true, port: 3091, access: DEFAULT_ACCESS })
    assert.equal(data.requiresReload, true, 'a live listener is not restarted underneath itself')
    assert.deepEqual(runtime.store.getSettings(), { enabled: true, port: 3091, access: DEFAULT_ACCESS })
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('an invalid setting is refused rather than silently ignored', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    for (const body of ['{}', '{"port":"3091"}', '{"port":0}', '{"port":70000}', '{"enabled":"yes"}']) {
      const res = await send({
        port: host.port,
        method: 'POST',
        path: `${ADMIN_API_PREFIX}/settings`,
        headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body,
      })
      assert.equal(res.status, 400, body)
      assert.equal(JSON.parse(res.body).error.code, 'admin/invalid-settings', body)
    }
    assert.deepEqual(runtime.store.getSettings(), { enabled: false, port: 3090, access: DEFAULT_ACCESS }, 'nothing changed')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('the state read reports the live NIC list beside the stored choice', async () => {
  /* The list is a fact about THIS MOMENT while the choice is a setting, so they
     travel together and the panel resolves them. `GET /state` never writes the
     fallback (`design.md` §1.2) — a cable that comes back must not have silently
     replaced what the user picked. */
  const runtime = makeRuntime()
  runtime.store.updateSettings({ access: { mode: 'lan', lanAddress: '10.0.0.7' } })
  const host = await startAdminHost({ runtime })
  try {
    const res = await send({
      port: host.port,
      path: `${ADMIN_API_PREFIX}/state`,
      headers: { host: loopbackHost(host.port) },
    })
    assert.equal(res.status, 200)
    const data = JSON.parse(res.body).data
    assert.deepEqual(data.addresses, { lan: FAKE_LAN })
    assert.deepEqual(data.settings.access, {
      mode: 'lan',
      lanAddress: '10.0.0.7',
      public: [],
      selectedPublicId: null,
    })
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('an invalid access block is refused with 400 and nothing is written', async () => {
  /* The point of the strict validator: a refused request must not half-apply. The
     FILE BYTES are compared, not just the parsed settings — a write that left the
     same values in a different order would still be a write, and a 400 followed by
     a disk change is exactly the panel/host disagreement this guards. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  const settingsPath = path.join(runtime.dir, 'devices.json')
  try {
    /* Seed a document so the file exists before the refused requests. */
    runtime.store.updateSettings({ port: 3090 })
    const before = readFileSync(settingsPath, 'utf8')

    const invalid = [
      { access: null },
      { access: 'nope' },
      { access: { mode: 'sideload' } },
      { access: { lanAddress: 'has/a/path' } },
      { access: { public: 'nope' } },
      { access: { public: [{ id: 'pub_a', address: 'has/a/path' }] } },
      { access: { public: [{ id: '', address: 'home.example.com' }] } },
      /* A valid `port` beside an invalid `access` must not be applied either. */
      { port: 4000, access: { mode: 'sideload' } },
    ]
    for (const body of invalid) {
      const res = await send({
        port: host.port,
        method: 'POST',
        path: `${ADMIN_API_PREFIX}/settings`,
        headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(res.status, 400, JSON.stringify(body))
      const payload = JSON.parse(res.body)
      assert.equal(payload.error.code, 'admin/invalid-access', JSON.stringify(body))
      /* Renderable: the panel shows this sentence, so it must not be empty and must
         not quote internals. */
      assert.ok(payload.error.message.length > 0)
      assert.ok(!payload.error.message.includes(runtime.dir), 'no file paths in the message')
    }

    assert.equal(readFileSync(settingsPath, 'utf8'), before, 'not one byte may change on a refused write')
    assert.deepEqual(runtime.store.getSettings(), { enabled: false, port: 3090, access: DEFAULT_ACCESS })
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('an access write is live immediately, so it does not ask for a reload', async () => {
  /* `requiresReload` narrowed (`design.md` §2.3): it now answers "did the
     LISTENER configuration change", not "did a settings write happen". Telling a
     user to restart dsh after editing an address sends them to restart a process
     for a string. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  const post = (body) => send({
    port: host.port,
    method: 'POST',
    path: `${ADMIN_API_PREFIX}/settings`,
    headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    const access = {
      mode: 'public',
      lanAddress: '192.168.1.5',
      public: [
        { id: 'pub_a', label: '家里 DDNS', address: 'home.example.com:3090' },
        { id: 'pub_b', label: '隧道', address: 'https://dsh.example.net' },
        { id: 'pub_c', label: '', address: '10.1.2.3:4000' },
      ],
      selectedPublicId: 'pub_b',
    }

    const onlyAccess = await post({ access })
    assert.equal(onlyAccess.status, 200)
    const accessData = JSON.parse(onlyAccess.body).data
    assert.equal(accessData.requiresReload, false, 'addresses never re-bind the listener')
    assert.deepEqual(accessData.settings.access, access)
    /* Three rows coexist, which is `prd.md` acceptance 4. */
    assert.equal(accessData.settings.access.public.length, 3)

    /* Re-sending the SAME values is still not a listener change. */
    assert.equal(JSON.parse((await post({ enabled: false })).body).data.requiresReload, false)

    /* The port really does need a restart. */
    const portChange = await post({ port: 4000 })
    const portData = JSON.parse(portChange.body).data
    assert.equal(portData.requiresReload, true)

    /* And so does the switch. */
    const enabled = await post({ enabled: true })
    assert.equal(JSON.parse(enabled.body).data.requiresReload, true)

    /* Re-saving the same port is not a change: the flag answers "differs", not
       "was written". */
    assert.equal(JSON.parse((await post({ port: 4000 })).body).data.requiresReload, false)

    /* The address block survived every one of those writes. */
    assert.deepEqual(runtime.store.getSettings().access, access)
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('the state read never invents an address when the host has no NICs', async () => {
  /* The container/CI case, and the case the panel's `pair.loopbackHint` exists for:
     an empty list must come back as an empty list, not as a fabricated loopback. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime, listLanAddresses: () => [] })
  try {
    const res = await send({
      port: host.port,
      path: `${ADMIN_API_PREFIX}/state`,
      headers: { host: loopbackHost(host.port) },
    })
    assert.deepEqual(JSON.parse(res.body).data.addresses, { lan: [] })
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('the state read reports the listener truth, not the setting', async () => {
  /* `prd.md`'s failure mode to avoid: a panel saying "enabled" while nothing is
     listening. `gateway: null` is the honest answer when remote access is off. */
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const idle = await send({
      port: host.port,
      path: `${ADMIN_API_PREFIX}/state`,
      headers: { host: loopbackHost(host.port) },
    })
    const idleData = JSON.parse(idle.body).data
    assert.equal(idleData.gateway, null, 'no listener, no gateway state')
    assert.deepEqual(idleData.devices, { active: 1, total: 1 })
    assert.equal(idleData.pairing.pending, 0)
    assert.equal(idleData.audit.retentionDays, 30)

    /* `/remote-control/api` on its own is the same read. */
    const bare = await send({
      port: host.port,
      path: ADMIN_API_PREFIX,
      headers: { host: loopbackHost(host.port) },
    })
    assert.equal(JSON.parse(bare.body).data.devices.active, 1)
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

/* ------------------------------------------------------------------ *
 * The audit export — loopback only, and well formed
 * ------------------------------------------------------------------ */

test('the audit export is loopback-only', async () => {
  const runtime = makeRuntime()
  runtime.audit.record({ event: 'pair', deviceId: 'dev_1', ip: '192.168.1.7' })
  const host = await startAdminHost({ runtime })
  try {
    /* Remote: refused, and the body carries no audit data. */
    for (const hostHeader of [`192.168.1.7:${String(host.port)}`, 'evil.example']) {
      const refused = await send({
        port: host.port,
        path: `${ADMIN_API_PREFIX}/audit/export`,
        headers: { host: hostHeader },
      })
      assert.equal(refused.status, 403, hostHeader)
      assert.ok(!refused.body.includes('192.168.1.7'), 'no audit data in a refusal')
      assert.ok(!refused.body.includes('dev_1'))
    }
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('the audit export is one well-formed JSONL download', async () => {
  const runtime = makeRuntime()
  /* Two days of trail, so the export has to concatenate in order. */
  runtime.audit.record({ event: 'pair', deviceId: 'dev_1', ip: '192.168.1.7' })
  runtime.clock.now = AT + 86_400_000
  runtime.audit.record({ event: 'connect', deviceId: 'dev_1', ip: '192.168.1.7' })
  runtime.clock.now = AT

  const host = await startAdminHost({ runtime })
  try {
    const res = await send({
      port: host.port,
      path: `${ADMIN_API_PREFIX}/audit/export`,
      headers: { host: loopbackHost(host.port) },
    })

    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /application\/x-ndjson/)
    assert.match(res.headers['content-disposition'], /attachment; filename="dsh-remote-control-audit-\d{4}-\d{2}-\d{2}\.jsonl"/)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.match(res.headers['x-content-type-options'], /nosniff/)

    const lines = res.body.split('\n').filter((line) => line !== '')
    assert.equal(lines.length, 2)
    /* Every line is a valid JSON object with the documented fields only. */
    for (const line of lines) {
      const parsed = JSON.parse(line)
      for (const key of Object.keys(parsed)) {
        assert.ok(['ts', 'event', 'deviceId', 'ip', 'meta'].includes(key), key)
      }
    }
    assert.deepEqual(lines.map((line) => JSON.parse(line).event), ['pair', 'connect'])
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('the audit summary is counts, with no events in it', async () => {
  const runtime = makeRuntime()
  runtime.audit.record({ event: 'pair', deviceId: 'dev_1', ip: '192.168.1.7' })
  runtime.audit.record({ event: 'connect', deviceId: 'dev_1', ip: '192.168.1.7' })
  const host = await startAdminHost({ runtime })
  try {
    const res = await send({
      port: host.port,
      path: `${ADMIN_API_PREFIX}/audit`,
      headers: { host: loopbackHost(host.port) },
    })
    assert.equal(res.status, 200)
    const data = JSON.parse(res.body).data
    assert.equal(data.lines, 2)
    assert.equal(data.counts.pair, 1)
    assert.equal(data.counts.connect, 1)
    assert.equal(data.retentionDays, 30)
    assert.ok(!res.body.includes('192.168.1.7'), 'the addresses are not in the summary')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

/* ------------------------------------------------------------------ *
 * Envelope discipline, method handling, and never-throw
 * ------------------------------------------------------------------ */

test('every response uses the documented ok/data or ok/error envelope', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const cases = [
      { method: 'GET', path: `${ADMIN_API_PREFIX}/devices`, status: 200 },
      { method: 'GET', path: `${ADMIN_API_PREFIX}/settings`, status: 200 },
      { method: 'GET', path: `${ADMIN_API_PREFIX}/audit`, status: 200 },
      { method: 'GET', path: `${ADMIN_API_PREFIX}/state`, status: 200 },
      { method: 'GET', path: `${ADMIN_API_PREFIX}/nope`, status: 404 },
      { method: 'GET', path: `${ADMIN_API_PREFIX}/devices/dev_1/revoke`, status: 405 },
      { method: 'POST', path: `${ADMIN_API_PREFIX}/devices`, status: 405 },
    ]
    for (const entry of cases) {
      const res = await send({
        port: host.port,
        method: entry.method,
        path: entry.path,
        headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin' },
        body: entry.method === 'POST' ? '' : undefined,
      })
      assert.equal(res.status, entry.status, `${entry.method} ${entry.path}`)
      assert.match(res.headers['content-type'], /application\/json/)
      assert.equal(res.headers['cache-control'], 'no-store')
      const body = JSON.parse(res.body)
      assert.equal(body.ok, entry.status < 400, `${entry.method} ${entry.path}`)
      if (body.ok) assert.ok('data' in body && !('error' in body))
      else assert.ok('error' in body && !('data' in body) && typeof body.error.code === 'string')
    }
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('a malformed JSON body is a 400, and the message quotes nothing', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const secret = 'this-is-the-users-prompt'
    for (const body of ['{not json', `{"name": ${secret}`, '[]', 'null', '42']) {
      const res = await send({
        port: host.port,
        method: 'POST',
        path: `${ADMIN_API_PREFIX}/pairing`,
        headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body,
      })
      assert.equal(res.status, 400, body)
      const parsed = JSON.parse(res.body)
      assert.equal(parsed.error.code, 'admin/invalid-json', body)
      /* The parse error would quote the input; the message must not. */
      assert.ok(!res.body.includes(secret), 'the body content is not echoed')
    }
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('an oversized body is refused with 413 instead of buffered', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const res = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/devices/dev_1/rename`,
      headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: `{"padding":"${'x'.repeat(70_000)}"}`,
    })
    assert.equal(res.status, 413)
    assert.equal(JSON.parse(res.body).error.code, 'admin/body-too-large')
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('rename trims, validates and persists', async () => {
  const runtime = makeRuntime()
  const host = await startAdminHost({ runtime })
  try {
    const ok = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/devices/dev_1/rename`,
      headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  kitchen tablet  ' }),
    })
    assert.equal(ok.status, 200)
    assert.equal(JSON.parse(ok.body).data.device.name, 'kitchen tablet')
    assert.equal(runtime.store.listDevices()[0].name, 'kitchen tablet')

    for (const body of [JSON.stringify({ name: '' }), JSON.stringify({ name: '   ' }), '{}', JSON.stringify({ name: 'x'.repeat(200) })]) {
      const bad = await send({
        port: host.port,
        method: 'POST',
        path: `${ADMIN_API_PREFIX}/devices/dev_1/rename`,
        headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body,
      })
      assert.equal(bad.status, 400, body)
      assert.equal(JSON.parse(bad.body).error.code, 'admin/invalid-name', body)
    }
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('clearing a pairing source lets a mistyping user back in', async () => {
  const runtime = makeRuntime()
  /* Spend the per-source budget. */
  for (let index = 0; index < 20; index += 1) {
    assert.throws(() => runtime.pairing.redeem(`pair_${String(index)}`, 'AAAAAAAA', { source: '192.168.1.9' }))
  }
  assert.throws(
    () => runtime.pairing.redeem('pair_x', 'AAAAAAAA', { source: '192.168.1.9' }),
    (error) => error.code === 'pairing/source-locked',
  )

  const host = await startAdminHost({ runtime })
  try {
    const res = await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/pairing/reset`,
      headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ source: '192.168.1.9' }),
    })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).data.cleared, true)
    /* The budget is gone, so a fresh pair is redeemable again. */
    const pair = runtime.pairing.create()
    assert.doesNotThrow(() => runtime.pairing.redeem(pair.pairId, pair.code, { source: '192.168.1.9' }))
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('a handler that throws becomes a 500 envelope, never a reset connection', async () => {
  /* `error-handling.md`: an exception escaping to the official server's listener
     becomes a bare connection reset with no diagnosable cause. Every handler here
     answers instead. Driven through a store that throws on read. */
  const runtime = makeRuntime()
  const broken = {
    ...runtime.store,
    listDevices: () => { throw Object.assign(new Error('boom'), { code: 'store/corrupt' }) },
  }
  const host = await startAdminHost({
    runtime: { ...runtime, store: broken },
  })
  try {
    const res = await send({
      port: host.port,
      path: `${ADMIN_API_PREFIX}/devices`,
      headers: { host: loopbackHost(host.port) },
    })
    assert.equal(res.status, 500)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'admin/internal')
    /* No internals: not the store code, not a path, not the message. */
    assert.ok(!res.body.includes('store/corrupt'))
    assert.ok(!res.body.includes('devices.json'))
    assert.ok(!res.body.includes('boom'))
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})

test('a host with no webServer.register degrades visibly, once, and still works', () => {
  const runtime = makeRuntime()
  const log = []
  const api = startAdminApi({
    ctx: null,
    webServer: {},
    store: runtime.store,
    pairing: runtime.pairing,
    audit: runtime.audit,
    logger: { debug: () => {}, info: () => {}, error: () => {}, warn: (message) => log.push(message) },
  })
  try {
    assert.equal(api.available, false)
    assert.equal(log.length, 1, 'exactly one warning, not zero and not one per request')
    assert.match(log[0], /register is unavailable/)
    /* The handle still exposes its parts, so an embedder can serve them itself. */
    assert.equal(typeof api.handle, 'function')
    assert.equal(typeof api.guard, 'function')
    assert.doesNotThrow(() => api.dispose())
  } finally {
    cleanupDir(runtime.dir)
  }
})

/**
 * The registration branches, split on whether `ctx.effect` exists.
 *
 * These two are the reason the module needs a DECLARED disposer: the no-context
 * branch assigns it, and an assignment to an undeclared binding is a
 * `ReferenceError` in an ES module. The assertion that matters is therefore not
 * "dispose does not throw" but "startAdminApi did not throw", because the throw
 * happened during MOUNT — before `available` was set — so the failure surfaced as
 * a plugin that silently had no admin API at all.
 */
test('mounting without a Cordis context registers the route and hands back a real disposer', () => {
  const runtime = makeRuntime()
  const registered = []
  let removed = 0
  const webServer = {
    register: (route) => {
      registered.push(route.path)
      return () => { removed += 1 }
    },
  }

  let api
  assert.doesNotThrow(() => {
    api = startAdminApi({ ctx: null, webServer, store: runtime.store, pairing: runtime.pairing, audit: runtime.audit })
  }, 'the embedder/test-harness branch must not throw at mount')

  try {
    assert.equal(api.available, true, 'a host that CAN register reports it, even without a context')
    assert.deepEqual(registered, [ADMIN_API_PREFIX], 'the prefix route was registered directly')

    api.dispose()
    assert.equal(removed, 1, 'dispose removes the route it registered directly')
  } finally {
    cleanupDir(runtime.dir)
  }
})

test('with a Cordis context the disposer belongs to ctx.effect, so API dispose is a no-op', () => {
  /* Two owners for one route would remove it twice, and `webServer.register`'s
     disposer deletes by key — a second call is harmless but it means the effect
     and the handle disagree about who cleans up. The effect owns it; the handle
     stays silent. */
  const runtime = makeRuntime()
  const effects = []
  let removed = 0
  const ctx = {
    effect: (acquire, label) => {
      effects.push({ release: acquire(), label })
      return () => {}
    },
  }
  const webServer = {
    register: () => () => { removed += 1 },
  }

  const api = startAdminApi({ ctx, webServer, store: runtime.store, pairing: runtime.pairing, audit: runtime.audit })
  try {
    assert.equal(api.available, true)
    assert.equal(effects.length, 1, 'one effect, one registration')
    assert.match(effects[0].label, /admin API/)

    api.dispose()
    assert.equal(removed, 0, 'the handle does not double-free the effect-owned route')

    effects[0].release()
    assert.equal(removed, 1, 'the effect disposer is what removes the route')
  } finally {
    cleanupDir(runtime.dir)
  }
})

test('the admin API paths are not device actions, so classify never labels them', () => {
  /* The API runs on the official port; the gateway never proxies it. If these
     paths were classified as actions, a probe would be attributed to whatever
     device sent it. */
  assert.equal(classify('POST', `${ADMIN_API_PREFIX}/devices/dev_1/revoke`), 'unknown')
  assert.equal(classify('GET', `${ADMIN_API_PREFIX}/devices`), null)
})

test('the audit file the admin API writes is inside the runtime directory', async () => {
  /* One place for everything (`design.md` §5/§6), and the retention sweep only
     ever looks there. */
  const runtime = makeRuntime()
  runtime.audit.record({ event: 'pair', deviceId: 'dev_1', ip: '192.168.1.7' })
  const host = await startAdminHost({ runtime })
  try {
    await send({
      port: host.port,
      method: 'POST',
      path: `${ADMIN_API_PREFIX}/devices/dev_1/revoke`,
      headers: { host: loopbackHost(host.port), 'sec-fetch-site': 'same-origin' },
      body: '',
    })
    const file = path.join(runtime.dir, `audit-${dayKeyOf(AT)}.jsonl`)
    assert.ok(readFileSync(file, 'utf8').includes('"revoke"'))
  } finally {
    await host.stop()
    cleanupDir(runtime.dir)
  }
})
