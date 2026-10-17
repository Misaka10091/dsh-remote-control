/**
 * The stale-inner-credential recovery path, end to end.
 *
 * `design.md` §4.3: DSH's launch token changes on restart, so the cached inner
 * cookie is dead. The symptom is an upstream 401 that looks identical to a proxy
 * bug, and the fix is to re-mint and retry **exactly once** — no loop, no
 * permanent degradation.
 *
 * The scenario is staged honestly: the upstream stub starts by accepting only the
 * FIRST credential it mints, then rotates its accepted value so the cached one goes
 * stale, exactly as a restart does. Getting this right requires the retry path to
 * be exercised for real rather than by calling `invalidate()` by hand, which would
 * test the mechanism and skip the trigger.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'

import { DEVICE_COOKIE_NAME } from '../src/host/constants.js'
import { startGateway } from '../src/host/gateway/server.js'
import { TEST_JWT_KEY, cleanupDir, makeStore, makeTempDir, pairDevice } from './helpers.mjs'

/** Issue one request against a gateway. */
function send(port, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      headers,
      agent: false,
    }, (res) => {
      const chunks = []
      res.setEncoding('utf8')
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: chunks.join('') }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('an upstream 401 re-mints the inner credential once and the retry succeeds', async () => {
  const state = { mints: 0, accepted: null, proxied: 0 }

  /* Behaves like the official port through a restart: the exchange always mints a
     NEW credential and the previous one immediately stops working. */
  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.mints += 1
      state.accepted = `dsh-auth-gen${String(state.mints)}=v1.mint${String(state.mints)}.sig`
      res.writeHead(303, { location: '/', 'set-cookie': `${state.accepted}; Path=/; HttpOnly` })
      res.end()
      return
    }

    state.proxied += 1
    const cookie = req.headers.cookie ?? ''
    if (!cookie.split(';').some((segment) => segment.trim() === state.accepted)) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const dir = makeTempDir()
  const { store } = makeStore(dir)
  /* The device whose token this test presents. */
  const { token } = pairDevice(store, { id: 'dev_1', name: 'phone' })

  const gateway = await startGateway({
    ctx: {
      get: () => ({ authenticatedUrl: (baseUrl) => `${baseUrl}?token=LAUNCH` }),
      effect: () => () => {},
    },
    store,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
  })

  const headers = {
    host: `127.0.0.1:${String(gateway.port)}`,
    cookie: `${DEVICE_COOKIE_NAME}=${token}`,
  }

  try {
    /* First request: one mint, accepted. */
    const first = await send(gateway.port, headers)
    assert.equal(first.status, 200)
    assert.equal(state.mints, 1)
    assert.equal(gateway.innerAuth.peek(), 'dsh-auth-gen1=v1.mint1.sig')

    /* Simulate the restart: the upstream has already rotated to a credential the
       gateway has never seen, so the cached one is stale. */
    state.accepted = 'dsh-auth-gen-after-restart=v1.new.sig'

    const second = await send(gateway.port, headers)
    assert.equal(second.status, 200, 'the retry recovered instead of surfacing the 401')
    assert.equal(state.mints, 2, 'exactly one re-mint, not a loop')
    assert.equal(gateway.innerAuth.peek(), 'dsh-auth-gen2=v1.mint2.sig', 'the new credential is cached')

    /* And the recovered credential is reused, not re-minted per request. */
    const third = await send(gateway.port, headers)
    assert.equal(third.status, 200)
    assert.equal(state.mints, 2, 'the recovered credential is cached like any other')
  } finally {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
    cleanupDir(dir)
  }
})

test('a permanently failing credential does not loop: one retry, then the 401 is relayed', async () => {
  /* The bound, proven: an upstream that always rejects must produce at most ONE
     re-mint per request and then hand the client the real 401. Anything else would
     turn a broken credential into an infinite upstream hammer. */
  const state = { mints: 0, proxied: 0 }

  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.mints += 1
      res.writeHead(303, { location: '/', 'set-cookie': `dsh-auth-never=v1.${String(state.mints)}.sig; Path=/` })
      res.end()
      return
    }
    state.proxied += 1
    /* Always refuse, whatever credential arrives. */
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
  })

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const dir = makeTempDir()
  const { store } = makeStore(dir)
  const { token } = pairDevice(store, { id: 'dev_1', name: 'phone' })

  const gateway = await startGateway({
    ctx: {
      get: () => ({ authenticatedUrl: (baseUrl) => `${baseUrl}?token=LAUNCH` }),
      effect: () => () => {},
    },
    store,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
  })

  try {
    const res = await send(gateway.port, {
      host: `127.0.0.1:${String(gateway.port)}`,
      cookie: `${DEVICE_COOKIE_NAME}=${token}`,
    })

    assert.equal(res.status, 401, 'the upstream refusal is relayed rather than invented into a 500')
    assert.equal(res.body, 'unauthorized', 'the body is relayed unchanged')
    assert.equal(state.proxied, 2, 'the original attempt plus exactly one retry')
    assert.equal(state.mints, 2, 'exactly one re-mint')
  } finally {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
    cleanupDir(dir)
  }
})

test('the inner credential never appears in a relayed response', async () => {  /* An upstream that (wrongly) tries to re-issue the credential in a response must
     not be able to leak it through the gateway. */
  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-secret=v1.SECRET.sig; Path=/' })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/plain',
      /* Deliberately hostile: the upstream hands the credential back. */
      'set-cookie': ['dsh-auth-secret=v1.SECRET.sig; Path=/', 'harmless=1; Path=/'],
    })
    res.end('ok')
  })

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const dir = makeTempDir()
  const { store } = makeStore(dir)
  const { token } = pairDevice(store, { id: 'dev_1', name: 'phone' })

  const gateway = await startGateway({
    ctx: {
      get: () => ({ authenticatedUrl: (baseUrl) => `${baseUrl}?token=LAUNCH` }),
      effect: () => () => {},
    },
    store,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
  })

  try {
    const raw = await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: gateway.port,
        path: '/',
        headers: {
          host: `127.0.0.1:${String(gateway.port)}`,
          cookie: `${DEVICE_COOKIE_NAME}=${token}`,
        },
        agent: false,
      }, (res) => {
        const chunks = []
        res.setEncoding('utf8')
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ headers: res.headers, body: chunks.join('') }))
      })
      req.on('error', reject)
      req.end()
    })

    const setCookie = raw.headers['set-cookie']
    assert.ok(Array.isArray(setCookie), 'the harmless cookie survives')
    assert.deepEqual(setCookie, ['harmless=1; Path=/'], 'the credential entry is gone')
    assert.ok(!raw.body.includes('SECRET'), 'and it is not in the body either')
  } finally {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
    cleanupDir(dir)
  }
})

test('a request with a body is not replayed after a re-mint, so no truncated upload reaches DSH', async () => {
  /* Replaying a consumed body would send DSH a partial payload — a corrupted write,
     far worse than the 401 the client can see and retry itself. The gateway must
     decline the retry when a body is provable. */
  const state = { mints: 0, proxied: 0, bodies: [] }

  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.mints += 1
      res.writeHead(303, { location: '/', 'set-cookie': `dsh-auth-gen${String(state.mints)}=v1.m${String(state.mints)}.sig; Path=/` })
      res.end()
      return
    }
    state.proxied += 1
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      state.bodies.push(Buffer.concat(chunks).toString('utf8'))
      /* Always refuse, so the retry path is entered on every request. */
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
    })
  })

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const dir = makeTempDir()
  const { store } = makeStore(dir)
  const { token } = pairDevice(store, { id: 'dev_1', name: 'phone' })

  const gateway = await startGateway({
    ctx: {
      get: () => ({ authenticatedUrl: (baseUrl) => `${baseUrl}?token=LAUNCH` }),
      effect: () => () => {},
    },
    store,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
  })

  const payload = '{"message":"a body that must arrive exactly once"}'

  try {
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: gateway.port,
        path: '/api/send',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${String(gateway.port)}`,
          cookie: `${DEVICE_COOKIE_NAME}=${token}`,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
        agent: false,
      }, (up) => {
        const chunks = []
        up.setEncoding('utf8')
        up.on('data', (chunk) => chunks.push(chunk))
        up.on('end', () => resolve({ status: up.statusCode, body: chunks.join('') }))
      })
      req.on('error', reject)
      req.end(payload)
    })

    assert.equal(res.status, 401, 'the honest upstream refusal is relayed')
    assert.equal(state.proxied, 1, 'ONE upstream attempt — the body was not replayed')
    assert.deepEqual(state.bodies, [payload], 'the body arrived exactly once and intact')
    assert.equal(state.mints, 1, 'and no pointless re-mint happened')
  } finally {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
    cleanupDir(dir)
  }
})

test('the head timeout does not sever a stream that then goes quiet', async () => {
  /* The timeout exists to bound the WAIT FOR A RESPONSE HEAD, not the life of the
     stream. DSH session streams can sit silent for a long time between events, and
     a socket-inactivity timeout would cut a perfectly healthy SSE connection. Staged
     with a 50 ms head timeout and a stream that idles for 300 ms. */
  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-s=v1.s.sig; Path=/' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    /* A long pause — far longer than the head timeout. */
    setTimeout(() => {
      res.write('data: second\n\n')
      res.end()
    }, 300)
  })

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const dir = makeTempDir()
  const { store } = makeStore(dir)
  const { token } = pairDevice(store, { id: 'dev_1', name: 'phone' })

  const gateway = await startGateway({
    ctx: {
      get: () => ({ authenticatedUrl: (baseUrl) => `${baseUrl}?token=LAUNCH` }),
      effect: () => () => {},
    },
    store,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
    upstreamTimeoutMs: 50,
  })

  try {
    /* A hard bound: the failure mode under test is a hung socket, so the test must
       fail fast rather than hang the suite. */
    const body = await new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('the stream was severed or hung')), 2_000)
      const req = httpRequest({
        host: '127.0.0.1',
        port: gateway.port,
        path: '/stream',
        headers: { host: `127.0.0.1:${String(gateway.port)}`, cookie: `${DEVICE_COOKIE_NAME}=${token}` },
        agent: false,
      }, (res) => {
        const chunks = []
        res.setEncoding('utf8')
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => { clearTimeout(guard); resolve(chunks.join('')) })
        res.on('error', (error) => { clearTimeout(guard); reject(error) })
      })
      req.on('error', (error) => { clearTimeout(guard); reject(error) })
      req.end()
    })

    assert.match(body, /data: first/, 'the first event arrived')
    assert.match(body, /data: second/, 'and the stream survived the idle gap')
  } finally {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
    cleanupDir(dir)
  }
})
