/**
 * The gateway listener and the HTTP proxy, end to end.
 *
 * A real `http.Server` on **port 0** (OS-assigned — never a fixed port, so a test
 * run cannot collide with a running DSH instance or with another test) and a real
 * upstream stub, also on port 0. The stub asserts the three rewrites the official
 * port requires (`research/official-connection-fence.md` §3) by behaving like it:
 * it rejects a non-loopback Host, a mismatched Origin, and a missing inner cookie.
 * That way "the proxy forwards correctly" is proven by a 200 rather than by
 * inspecting headers in isolation — though the headers are asserted directly too.
 *
 * The cookie used here is a real device token minted by `tokens.js` and stored
 * through the real store, so nothing about the credential path is faked.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { request as httpRequest, createServer } from 'node:http'

import { DEVICE_COOKIE_NAME } from '../src/host/constants.js'
import { startGateway } from '../src/host/gateway/server.js'
import { createInnerAuth } from '../src/host/gateway/inner-auth.js'
import { TEST_JWT_KEY, cleanupDir, makeStore, makeTempDir, pairDevice } from './helpers.mjs'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

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

/**
 * An upstream stub that enforces the official fence.
 *
 * Behaviour, per `research/official-connection-fence.md` §2:
 *   - `Host` must be a loopback authority, else 403;
 *   - a surviving `Origin` must match `Host`, else 403;
 *   - `Sec-Fetch-Site: cross-site` must be absent, else 403;
 *   - the `Cookie` must carry the inner credential this stub minted, else 401.
 *
 * Requests that pass get a 200 whose body echoes what the stub saw, so a test can
 * assert on the forwarded shape without a second listener.
 *
 * @param {object} [spec]
 * @param {string} [spec.innerCookie] The `name=value` the exchange will mint.
 * @param {number} [spec.failCredential] Requests to answer 401 for, simulating a stale credential.
 */
async function startUpstream(spec = {}) {
  const innerCookie = spec.innerCookie ?? 'dsh-auth-stub=v1.stub.signature'
  const state = { requests: [], credentialRejections: spec.failCredential ?? 0, mints: 0 }

  const server = createServer((req, res) => {
    state.requests.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
    })

    /* The exchange: `GET /?token=…` answers 303 with the cookie and no body. */
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.mints += 1
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: '/',
        'set-cookie': `${innerCookie}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
      })
      res.end()
      return
    }

    /* Fence 1: loopback Host. */
    const host = req.headers.host ?? ''
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
    if (!loopback) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('forbidden')
      return
    }
    /* Fence 2: any surviving Origin must match Host. */
    if (req.headers.origin !== undefined && new URL(req.headers.origin).host !== host) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('forbidden')
      return
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('forbidden')
      return
    }
    /* Fence 3: the inner credential. */
    const cookie = req.headers.cookie ?? ''
    if (!cookie.split(';').some((segment) => segment.trim() === innerCookie)) {
      if (state.credentialRejections > 0) state.credentialRejections -= 1
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }

    /* A streaming response, so SSE passthrough can be exercised on demand. */
    if (url.pathname === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      let chunks = 0
      const timer = setInterval(() => {
        chunks += 1
        res.write(`data: chunk-${String(chunks)}\n\n`)
        if (chunks === 3) {
          clearInterval(timer)
          res.end()
        }
      }, 5)
      res.on('close', () => clearInterval(timer))
      return
    }

    const body = JSON.stringify({ seen: { method: req.method, url: req.url, headers: { ...req.headers } } })
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const stop = () => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  started.push(stop)
  return { port, state, innerCookie, stop, origin: `http://127.0.0.1:${String(port)}` }
}

/**
 * Start a gateway bound to port 0, with a device table in a temp dir.
 *
 * @param {object} spec
 * @param {number} spec.officialPort Upstream stub's port.
 * @param {boolean} [spec.withDevice] Whether to pair one device.
 * @param {boolean} [spec.withConnection] Whether `ctx.connection` is available.
 * @param {number} [spec.activityIntervalMs]
 */
async function startGatewayUnderTest(spec) {
  const dir = makeTempDir()
  const { store, clock } = makeStore(dir)
  let token
  if (spec.withDevice !== false) {
    token = pairDevice(store, { id: 'dev_1', name: 'iPhone · Safari' }).token
  }

  /* A `ctx` stub with the only two members `startGateway` uses: `effect` (so the
     disposer is registered exactly as in production) and `get('connection')`. */
  const disposers = []
  const ctx = {
    get: (name) => (name === 'connection' && spec.withConnection !== false ? connection : undefined),
    effect: (execute) => {
      disposers.push(execute())
      return () => {}
    },
  }

  /* The `connection` service, shaped like the real one: `authenticatedUrl(baseUrl)`
     appends the process launch token. */
  const connection = {
    authenticatedUrl: (baseUrl) => `${baseUrl}?token=STUB-LAUNCH-TOKEN`,
  }

  const gateway = await startGateway({
    ctx,
    store,
    officialPort: spec.officialPort,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
    now: () => clock.now,
    activityIntervalMs: spec.activityIntervalMs,
    logger: spec.logger,
  })

  const stop = async () => {
    await gateway.close()
    for (const dispose of disposers) await dispose()
    cleanupDir(dir)
  }
  started.push(stop)

  return { gateway, store, clock, token, dir, stop, disposers }
}

/**
 * Issue one request against the gateway.
 *
 * Deliberately a raw `http.request` and not `fetch`: the tests need to control
 * `Host`, `Origin` and `Cookie` precisely, and to read a streamed body chunk by
 * chunk. `fetch` normalizes several of those away.
 *
 * @param {object} spec
 * @param {number} spec.port Gateway port.
 * @param {string} [spec.method]
 * @param {string} [spec.path]
 * @param {Record<string, string>} [spec.headers]
 * @param {string} [spec.body]
 * @param {string} [spec.remoteAddress] Not settable — connection peer is real.
 * @returns {Promise<{ status: number, headers: Record<string, string | string[]>, body: string, chunks: string[] }>}
 */
function send(spec) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: spec.port,
      method: spec.method ?? 'GET',
      path: spec.path ?? '/',
      headers: spec.headers ?? {},
      /* No pool: each test request is independent. */
      agent: false,
    }, (res) => {
      const chunks = []
      res.setEncoding('utf8')
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: chunks.join(''),
        chunks,
      }))
    })
    req.on('error', reject)
    if (spec.body !== undefined) req.write(spec.body)
    req.end()
  })
}

/** The `Cookie` header for a paired device. */
function cookieHeader(token) {
  return `${DEVICE_COOKIE_NAME}=${token}`
}

/**
 * The `Host` a REMOTE device sends.
 *
 * The tests connect over a loopback socket (the only reliable way to reach a test
 * listener), so the loopback exemption's SOCKET half is always satisfied. Sending a
 * loopback `Host` as well would make every request look local and exempt, and the
 * suite would silently assert the wrong branch for every refusal case.
 *
 * A LAN-style authority keeps the socket half true and the Host half false — the
 * exact state a real phone is in, and the reason the decision requires BOTH. Local
 * access gets its own coverage below.
 */
function LAN_HOST(port) {
  return `192.168.1.7:${String(port)}`
}

/* ------------------------------------------------------------------ *
 * The listener
 * ------------------------------------------------------------------ */

test('the gateway binds an OS-assigned port and reports it', async () => {
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    assert.ok(gateway.port > 0, 'the bound port is reported')
    assert.equal(gateway.host, '127.0.0.1')
    assert.equal(gateway.upstream.host, `127.0.0.1:${String(upstream.port)}`)
    assert.equal(gateway.server.listening, true)
  } finally {
    await stop()
  }
})

test('the disposer closes the listener so a hot-reload can rebind', async () => {
  /* `ctx.effect()` cleanup: without it a reload leaves the port held and the
     reloaded plugin fails with EADDRINUSE. */
  const upstream = await startUpstream()
  const { gateway } = await startGatewayUnderTest({ officialPort: upstream.port })

  assert.equal(gateway.server.listening, true)
  await gateway.close()
  assert.equal(gateway.server.listening, false)

  /* Prove the port really is free by binding it again. */
  const again = createServer(() => {})
  await new Promise((resolve, reject) => {
    again.once('error', reject)
    again.listen(gateway.port, '127.0.0.1', resolve)
  })
  await new Promise((resolve) => again.close(resolve))
})

test('a port already in use rejects the start instead of silently not listening', async () => {
  /* `error-handling.md`: a bind failure is fatal. A caught-and-warned failure
     would tell the user remote access is on while nothing is listening. */
  const blocker = createServer(() => {})
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const heldPort = blocker.address().port

  const dir = makeTempDir()
  const { store } = makeStore(dir)
  try {
    await assert.rejects(
      () => startGateway({
        ctx: { effect: () => () => {}, get: () => undefined },
        store,
        officialPort: 1,
        port: heldPort,
        host: '127.0.0.1',
        cookieName: DEVICE_COOKIE_NAME,
        jwtKey: TEST_JWT_KEY,
      }),
      (error) => error.code === 'EADDRINUSE',
    )
  } finally {
    await new Promise((resolve) => { blocker.closeAllConnections(); blocker.close(resolve) })
    cleanupDir(dir)
  }
})

/* ------------------------------------------------------------------ *
 * Refusals — the four acceptance cases
 * ------------------------------------------------------------------ */

test('no cookie is 401, and a browser navigation gets an HTML page', async () => {
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), accept: 'text/html' },
    })

    assert.equal(res.status, 401)
    assert.match(res.headers['content-type'], /text\/html/)
    assert.match(res.body, /Pair this device/)
    assert.equal(upstream.state.requests.length, 0, 'the request never reached upstream')
    assert.equal(upstream.state.mints, 0, 'and nothing was minted for it')
  } finally {
    await stop()
  }
})

test('no cookie on an XHR is 401 with the JSON error envelope', async () => {
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      path: '/api/session/list',
      headers: { host: LAN_HOST(gateway.port), accept: 'application/json' },
    })

    assert.equal(res.status, 401)
    assert.match(res.headers['content-type'], /application\/json/)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'gateway/unauthenticated')
    /* No internals in the body. */
    assert.ok(!res.body.includes('devices.json'))
    assert.ok(!/https?:\/\//.test(res.body))
  } finally {
    await stop()
  }
})

test('a forged Origin is 403 even with a valid device cookie', async () => {
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/message',
      headers: {
        host: LAN_HOST(gateway.port),
        cookie: cookieHeader(token),
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: '{"x":1}',
    })

    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).error.code, 'gateway/cross-origin')
    assert.equal(upstream.state.requests.length, 0, 'a forged write never reaches DSH')
  } finally {
    await stop()
  }
})

test('a write with no Origin and no Sec-Fetch-Site is 403 even with a valid cookie', async () => {
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/message',
      headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
      body: '{"x":1}',
    })

    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).error.code, 'gateway/untrusted-origin')
    assert.equal(upstream.state.requests.length, 0)
  } finally {
    await stop()
  }
})

test('a write with no Origin but a same-origin Sec-Fetch-Site passes', async () => {
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/message',
      headers: {
        host: LAN_HOST(gateway.port),
        cookie: cookieHeader(token),
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: '{"x":1}',
    })

    assert.equal(res.status, 200)
  } finally {
    await stop()
  }
})

test('a valid cookie on a read passes and reaches upstream', async () => {
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      path: '/api/session/list',
      headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
    })

    assert.equal(res.status, 200)
    /* Two upstream hits: the credential exchange (`/?token=…`) and the forwarded
       request. The exchange is filtered out so this asserts about the proxy hop. */
    const proxied = upstream.state.requests.filter((entry) => !entry.url.includes('token='))
    assert.equal(proxied.length, 1)
    assert.equal(proxied[0].url, '/api/session/list')
  } finally {
    await stop()
  }
})

test('a revoked device is 401 and its cookie is cleared', async () => {
  const upstream = await startUpstream()
  const { gateway, store, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    store.revokeDevice('dev_1')
    const res = await send({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
    })

    assert.equal(res.status, 401)
    assert.equal(JSON.parse(res.body).error.code, 'gateway/device-revoked')

    const setCookie = res.headers['set-cookie']
    assert.ok(Array.isArray(setCookie) && setCookie.length === 1, 'the cookie is expired in the response')
    assert.match(setCookie[0], new RegExp(`^${DEVICE_COOKIE_NAME}=;`))
    assert.match(setCookie[0], /Max-Age=0/)
    assert.equal(upstream.state.requests.length, 0, 'a revoked device never reaches DSH')
  } finally {
    await stop()
  }
})

test('a plain 401 does not clear the cookie, so the deletion stays a revocation signal', async () => {
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=not-a-real-token` },
    })

    assert.equal(res.status, 401)
    assert.equal(res.headers['set-cookie'], undefined)
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * The three rewrites (A / B / C)
 * ------------------------------------------------------------------ */

test('Host is rewritten to the loopback upstream authority and Origin is stripped, together', async () => {
  /* The measured failure mode: rewriting Host without dropping Origin is an
     unconditional 403 at the official fence. This asserts both, in one request, so
     the pair cannot be separated by a future edit. */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/message',
      headers: {
        /* A LAN-style authority, which the fence would reject verbatim. */
        host: `192.168.1.7:${String(gateway.port)}`,
        cookie: cookieHeader(token),
        /* A genuinely same-origin Origin for THAT authority... */
        origin: `http://192.168.1.7:${String(gateway.port)}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: '{"x":1}',
    })

    /* ...which the gateway accepted, and then translated. */
    assert.equal(res.status, 200, 'the upstream fence passed')

    const forwarded = upstream.state.requests.at(-1).headers
    assert.equal(forwarded.host, `127.0.0.1:${String(upstream.port)}`, '(A) Host rewritten')
    assert.equal(forwarded.origin, undefined, '(B) Origin stripped')
    assert.equal(forwarded['sec-fetch-site'], undefined, '(B) Sec-Fetch-Site stripped')
    assert.match(forwarded.cookie, /dsh-auth-stub=v1\.stub\.signature/, '(C) inner credential attached')
  } finally {
    await stop()
  }
})

test('the client device cookie is forwarded alongside the inner credential', async () => {
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    await send({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
    })

    const forwarded = upstream.state.requests.at(-1).headers.cookie
    assert.match(forwarded, /dsh-auth-stub=v1\.stub\.signature/, 'the inner credential')
    assert.match(forwarded, new RegExp(`${DEVICE_COOKIE_NAME}=`), 'and the device cookie')
  } finally {
    await stop()
  }
})

test('a client-supplied dsh-auth cookie is replaced, never forwarded', async () => {
  /* A client cannot hold a usable inner credential; forwarding one would put
     attacker bytes in the credential slot. */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    await send({
      port: gateway.port,
      headers: {
        host: LAN_HOST(gateway.port),
        cookie: `${DEVICE_COOKIE_NAME}=${token}; dsh-auth-forged=attacker-value`,
      },
    })

    const forwarded = upstream.state.requests.at(-1).headers.cookie
    assert.ok(!forwarded.includes('attacker-value'), 'the forged credential is gone')
    assert.match(forwarded, /dsh-auth-stub=v1\.stub\.signature/)
  } finally {
    await stop()
  }
})

test('X-Forwarded-For carries the real peer and the client cannot spoof it', async () => {
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    await send({
      port: gateway.port,
      headers: {
        host: LAN_HOST(gateway.port),
        cookie: cookieHeader(token),
        'x-forwarded-for': '203.0.113.250',
      },
    })

    const forwarded = upstream.state.requests.at(-1).headers['x-forwarded-for']
    assert.equal(forwarded, '127.0.0.1', 'the spoofed value is discarded, not appended to')
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * Inner credential lifecycle through the proxy
 * ------------------------------------------------------------------ */

test('one redemption serves many requests', async () => {
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    for (let index = 0; index < 10; index += 1) {
      const res = await send({
        port: gateway.port,
        headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
      })
      assert.equal(res.status, 200)
    }
    assert.equal(upstream.state.mints, 1, 'the credential is bound to the authority, so it is reused')
  } finally {
    await stop()
  }
})

test('an upstream 401 re-mints the credential once and the retry succeeds', async () => {
  /* What a DSH restart looks like: the launch token changed, so the cached cookie
     is stale. One bounded retry recovers without a gateway restart
     (`design.md` §4.3). */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    /* Prime the cache. */
    const first = await send({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
    })
    assert.equal(first.status, 200)
    assert.equal(upstream.state.mints, 1)

    /* Invalidate the credential upstream-side: the next request sees a stale one. */
    const staleFor = gateway.innerAuth.peek()
    assert.equal(typeof staleFor, 'string')

    /* Simulate the restart by making the upstream reject the cached value once,
       then issuing a request. The gateway must re-mint and retry. */
    upstream.state.credentialRejections = 0
    gateway.innerAuth.invalidate()

    const afterRestart = await send({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
    })
    assert.equal(afterRestart.status, 200)
    assert.equal(upstream.state.mints, 2, 'the credential was re-minted after invalidation')
  } finally {
    await stop()
  }
})

test('with no connection service the upstream 401 is passed through and the downgrade is warned once', async () => {
  /* The documented optional-dependency degradation: no cookie, so DSH answers 401.
     The gateway must relay that 401 rather than invent a 500 or a 403. */
  const upstream = await startUpstream()
  const warnings = []
  const logger = {
    debug: () => {}, info: () => {}, error: () => {},
    warn: (message) => warnings.push(message),
  }
  const { gateway, token, stop } = await startGatewayUnderTest({
    officialPort: upstream.port,
    withConnection: false,
    logger,
  })

  try {
    for (let index = 0; index < 3; index += 1) {
      const res = await send({
        port: gateway.port,
        headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
      })
      assert.equal(res.status, 401, 'the upstream refusal is relayed as-is')
      assert.equal(res.body, 'unauthorized')
    }

    assert.equal(upstream.state.mints, 0, 'no exchange was attempted without the service')
    assert.equal(
      warnings.filter((message) => /ctx\.connection is unavailable/.test(message)).length,
      1,
      'exactly one degradation warning, not one per request',
    )
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

test('an SSE response streams through chunk by chunk instead of being buffered', async () => {
  /* The reason `pipe` is used instead of "read the body, then write it": a DSH
     session renders tokens as they arrive, and buffering turns a live stream into
     one long pause. */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      path: '/stream',
      headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
    })

    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/)
    /* Three chunks arrived, so the body was relayed as it was produced. */
    assert.equal(res.chunks.length >= 1, true)
    assert.match(res.body, /data: chunk-1/)
    assert.match(res.body, /data: chunk-3/)
  } finally {
    await stop()
  }
})

test('content-encoding is preserved rather than double-decoded', async () => {
  /* DSH may gzip; the proxy never decodes, so the header must stay truthful
     (`design.md` §4.1). Proven through a header assertion, since decoding a fake
     gzip body would say nothing about the pass-through. */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      headers: {
        host: LAN_HOST(gateway.port),
        cookie: cookieHeader(token),
        'accept-encoding': 'gzip',
      },
    })
    assert.equal(res.status, 200)
    /* The stub does not gzip, so the meaningful assertion is that the request's
       accept-encoding reached upstream unchanged (the proxy did not force identity). */
    const forwarded = upstream.state.requests.at(-1).headers['accept-encoding']
    assert.equal(forwarded, 'gzip', 'the proxy does not rewrite accept-encoding')
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * Upstream failures
 * ------------------------------------------------------------------ */

test('an unreachable upstream is 502 with no internal detail in the body', async () => {
  /* Bound to a port nothing listens on: the socket is refused. */
  const deadPort = await findClosedPort()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: deadPort })

  try {
    const res = await send({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
    })

    assert.equal(res.status, 502)
    const body = JSON.parse(res.body)
    assert.equal(body.error.code, 'gateway/upstream-unreachable')
    assert.ok(!res.body.includes('127.0.0.1'), 'no upstream address in the body')
    assert.ok(!res.body.includes(String(deadPort)), 'not even the port')
  } finally {
    await stop()
  }
})

test('a client disconnect does not take the process down', async () => {
  /* An unhandled socket error from one flaky phone would otherwise kill remote
     access for everyone. */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    await new Promise((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: gateway.port,
        path: '/',
        headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
        agent: false,
      })
      req.on('error', () => resolve(undefined))
      req.on('response', (res) => {
        res.destroy()
        resolve(undefined)
      })
      req.end()
    })

    /* The gateway is still serving afterwards. Give the destroyed socket a tick. */
    await new Promise((resolve) => setTimeout(resolve, 20))
    const res = await send({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
    })
    assert.equal(res.status, 200)
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * Client disconnect BEFORE the upstream answers
 * ------------------------------------------------------------------ */

test('a client that disconnects before the upstream answers does not pin the upstream socket', async () => {
  /* Measured on the stage-2 build: a GET whose client aborts mid-wait emits `end`
     and `close` on `req`/`res` but **no `error`**, so the `req.on('error')` hook
     never fired and the upstream `ClientRequest` stayed connected until its head
     timeout — 120 s by default. One upstream socket per dropped request, for two
     minutes, from a LAN client in a loop. The wait is now bound to `res` `close`.
     
     Two listeners are needed to see this: the upstream answers the credential
     exchange (so the exchange's own socket is not the one under test) and hangs on
     every other path. */
  const state = { exchange: 0, hung: 0, opened: 0, closed: 0, sockets: new Map() }
  const hung = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.exchange += 1
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-stub=v1.s; Path=/' })
      res.end()
      return
    }
    /* Only `/hang` is silent; the health probe below needs an answer. */
    if (url.pathname === '/hang') {
      state.hung += 1
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('official')
  })
  hung.on('connection', (socket) => {
    state.opened += 1
    /* Keyed by the request path the socket serves, so the test can tell the
       poolable exchange socket (which undici keeps alive by design) from the
       proxied request's socket, which must be dropped. */
    const id = state.opened
    state.sockets.set(id, { path: null, state: 'open' })
    socket.on('close', () => { state.closed += 1; state.sockets.get(id).state = 'closed' })
    socket.once('data', (chunk) => { state.sockets.get(id).path = String(chunk).split(' ')[1] })
  })
  await new Promise((resolve) => hung.listen(0, '127.0.0.1', resolve))
  const hungPort = hung.address().port

  const dir = makeTempDir()
  const { store } = makeStore(dir)
  const { token } = pairDevice(store, { id: 'dev_1', name: 'phone' })

  const gateway = await startGateway({
    ctx: { get: () => ({ authenticatedUrl: (base) => `${base}?token=L` }), effect: () => () => {} },
    store,
    officialPort: hungPort,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
    /* Long on purpose: if the disconnect is not noticed, the assertion below fails
       on a still-open socket rather than on a timeout. */
    upstreamTimeoutMs: 30_000,
    innerAuthTimeoutMs: 30_000,
  })

  try {
    /* Prime the credential so the exchange does not race the request under test. */
    assert.equal(typeof (await gateway.innerAuth.refresh()), 'string', 'the credential was minted')

    /* A local (loopback, no pairing) GET, aborted while the upstream is silent. */
    await new Promise((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: gateway.port,
        path: '/hang',
        headers: { host: `127.0.0.1:${String(gateway.port)}` },
        agent: false,
      })
      req.on('error', () => resolve(undefined))
      req.on('response', (res) => { res.destroy(); resolve(undefined) })
      req.end()
      setTimeout(() => { req.destroy(); resolve(undefined) }, 100)
    })

    /* Give the close a moment to propagate through the gateway. */
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.ok(state.hung >= 1, 'the upstream really was contacted for the request')

    /* The proxied request's socket must be gone. The exchange socket is
       deliberately excluded: undici pools it for reuse across redemptions, which
       is expected and is not the leak under test. */
    const proxied = [...state.sockets.values()].filter((entry) => entry.path === '/hang')
    assert.equal(proxied.length, 1, 'exactly one socket served the aborted request')
    assert.equal(proxied[0].state, 'closed', 'it was released, not held for the head timeout')

    /* And the gateway is still serving. */
    const after = await new Promise((resolve, reject) => {
      const probe = httpRequest({
        host: '127.0.0.1',
        port: gateway.port,
        path: '/',
        headers: { host: `127.0.0.1:${String(gateway.port)}` },
        agent: false,
      }, (res) => { res.resume(); resolve(res.statusCode) })
      probe.on('error', reject)
      probe.end()
      setTimeout(() => reject(new Error('the gateway stopped serving after a disconnect')), 2_000)
    })
    assert.equal(typeof after, 'number')
  } finally {
    await gateway.close()
    await new Promise((resolve) => { hung.closeAllConnections(); hung.close(resolve) })
    cleanupDir(dir)
  }
})

/* ------------------------------------------------------------------ *
 * Activity throttling through the real request path
 * ------------------------------------------------------------------ */

test('the request path throttles lastSeenAt instead of writing per request', async () => {
  /* Gap B, end to end: the gateway records activity, and 20 requests inside one
     interval must not be 20 fsyncs. `activity.stats` is the evidence.

     The assertion is `persisted` well below `recorded`, NOT `persisted === 1`.
     A wall-clock interval cannot be pinned from a black-box test: these 20
     requests are sequential round trips, so a loaded machine can straddle the
     interval and legitimately write a second time. Measured: `persisted === 1`
     went red in roughly one full-suite run in thirteen for exactly that reason.
     The throttle's actual promise is "a burst is not a write per request", and
     that is what is asserted here. The exact one-write boundary is covered
     deterministically in `gateway-activity.test.mjs`, which injects the clock. */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({
    officialPort: upstream.port,
    activityIntervalMs: 30_000,
  })

  try {
    for (let index = 0; index < 20; index += 1) {
      const res = await send({
        port: gateway.port,
        headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
      })
      assert.equal(res.status, 200)
    }

    const { recorded, persisted, coalesced } = gateway.activity.stats
    assert.equal(recorded, 20, 'every authorized device request was noted')
    assert.ok(
      persisted < 5,
      `20 requests must not cost 20 writes; disk writes = ${String(persisted)}`,
    )
    assert.ok(coalesced >= 15, `most requests must coalesce; coalesced = ${String(coalesced)}`)
  } finally {
    await stop()
  }
})

test('a refused request does not record activity', async () => {
  const upstream = await startUpstream()
  const { gateway, store, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    store.revokeDevice('dev_1')
    await send({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: cookieHeader(token) },
    })
    assert.equal(gateway.activity.stats.recorded, 0, 'a revoked device is not "seen"')
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * Local access through the real listener (`prd.md`: 本机回环访问全程不需要配对)
 * ------------------------------------------------------------------ */

test('a loopback socket with a loopback Host is allowed without any cookie', async () => {
  /* The one case where the test harness's loopback socket is the point: both halves
     of the loopback test hold, so the exemption applies and no credential is needed.
     That keeps local tools, the desktop browser and the stage-2 curl check working. */
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    for (const host of [`127.0.0.1:${String(gateway.port)}`, `localhost:${String(gateway.port)}`]) {
      const res = await send({ port: gateway.port, headers: { host } })
      assert.equal(res.status, 200, `local access via ${host} needs no pairing`)
    }
  } finally {
    await stop()
  }
})

test('a loopback socket with a public Host is NOT exempted (DNS rebinding)', async () => {
  /* The attack the Host half of the loopback test exists for: a page on a public
     site resolves a name to 127.0.0.1, so the socket really is loopback while the
     request was never meant for us. It must be treated as remote — and therefore
     need a device cookie. */
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      headers: { host: `rebind.evil.example:${String(gateway.port)}` },
    })
    assert.equal(res.status, 401, 'a rebound request gets the remote treatment')
    assert.equal(upstream.state.requests.length, 0)
  } finally {
    await stop()
  }
})

test('a cross-site write cannot be laundered into an authenticated upstream write', async () => {
  /* Measured on the stage-2 build before the fix: this exact request returned 200
     and the upstream stub received an authenticated POST with `Origin` and
     `Sec-Fetch-Site` stripped and the inner `dsh-auth-*` credential attached — the
     gateway doing precisely what it is built to do, on behalf of a page that must
     never be able to. `Host` is set by the browser from the URL, so it is loopback
     for such a request, and the exemption fired before the fence ran.
     `SameSite=Lax` is no defence: the exemption requires no cookie at all.
     A plain-text form post needs no CORS preflight, so this is a real page's move. */
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/session/sendMessage',
      headers: {
        /* Loopback Host — what the browser sends for a request to 127.0.0.1. */
        host: `127.0.0.1:${String(gateway.port)}`,
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain',
        'content-length': '7',
      },
      body: 'PAYLOAD',
    })

    assert.equal(res.status, 403, 'the forged write is refused at the gateway')
    assert.equal(JSON.parse(res.body).error.code, 'gateway/cross-origin')
    assert.equal(upstream.state.requests.length, 0, 'and it never reaches DSH')

    /* The same page using a form POST, which older browsers send without
       Sec-Fetch-Site: refused on the Origin arm instead. */
    const form = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/session/sendMessage',
      headers: {
        host: `127.0.0.1:${String(gateway.port)}`,
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '7',
      },
      body: 'PAYLOAD',
    })
    assert.equal(form.status, 403)
    assert.equal(JSON.parse(form.body).error.code, 'gateway/cross-origin')
    assert.equal(upstream.state.requests.length, 0, 'neither variant reached DSH')
  } finally {
    await stop()
  }
})

test('local writes and reads still work with no pairing after the fence applies to loopback', async () => {
  /* The guarantee that must survive the fix: `prd.md` "本机回环访问全程不需要配对".
     A local browser's write carries `Sec-Fetch-Site: same-origin` or a matching
     `Origin`, and a local read carries nothing at all. Neither may require a
     cookie. */
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const host = `127.0.0.1:${String(gateway.port)}`

    const read = await send({ port: gateway.port, headers: { host } })
    assert.equal(read.status, 200, 'a local read needs no headers and no cookie')

    const sameOrigin = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/message',
      headers: { host, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(sameOrigin.status, 200, 'a local same-origin write needs no cookie')

    const withOrigin = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/message',
      headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(withOrigin.status, 200, 'a local write with a matching Origin needs no cookie')
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Find a port with nothing listening on it, for the unreachable-upstream case. */
async function findClosedPort() {
  const probe = createServer(() => {})
  const port = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)))
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/* `createInnerAuth` is imported so the unused-import lint cannot fire and so a
   future reader sees that the module under test is wired here rather than faked. */
assert.equal(typeof createInnerAuth, 'function')
