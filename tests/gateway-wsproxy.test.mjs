/**
 * The upgrade proxy, end to end (`design.md` §4.2, stage 3).
 *
 * A real `http.Server` for the gateway and a real `http.Server` for the upstream,
 * both on **port 0** — never a fixed port, so a run cannot collide with a live DSH
 * instance or with another test. The upstream stub behaves like the official fence
 * (`research/official-connection-fence.md` §2.1/§2.2): it refuses a non-loopback
 * `Host`, a surviving `Origin` that does not match it, and a missing inner
 * `dsh-auth-*` cookie. That way "the handshake was translated correctly" is proven
 * by a `101` rather than by inspecting headers in a vacuum.
 *
 * No `ws` library is used anywhere here either — the client half is a raw
 * `node:net` socket writing a handshake by hand, which is the same thing the proxy
 * does. If the suite needed a protocol library to talk to the passthrough, the
 * zero-dependency claim would be a lie.
 *
 * Every case the stage requires is present:
 *
 *   - no cookie is refused;
 *   - a forged Origin is refused (including the measured "Origin, no
 *     Sec-Fetch-Site" shape);
 *   - a loopback socket with a cross-site-marked handshake and no Origin is
 *     refused — the stage-2 hole class, in its WebSocket spelling;
 *   - a valid cookie plus the inner credential reaches the upstream;
 *   - bytes pass in both directions;
 *   - an upstream that accepts and hangs yields a bounded failure;
 *   - a client abort releases the upstream socket;
 *   - revoking a device closes its live socket.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'

import { DEVICE_COOKIE_NAME } from '../src/host/constants.js'
import { startGateway } from '../src/host/gateway/server.js'
import { TEST_JWT_KEY, cleanupDir, makeStore, makeTempDir, pairDevice } from './helpers.mjs'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/** Every teardown registered by a test, run in `after`. */
const started = []

after(async () => {
  for (const stop of started.splice(0)) {
    try {
      await stop()
    } catch {
      /* teardown must never fail a run */
    }
  }
})

/**
 * An upstream that speaks the official fence and then a byte pipe.
 *
 * @param {object} [spec]
 * @param {string} [spec.innerCookie] The `name=value` the exchange mints.
 * @param {boolean} [spec.hang] Accept the TCP connection and never answer.
 * @param {boolean} [spec.refuseStatus] Answer every handshake with this status.
 * @param {boolean} [spec.noExchange] Do not serve the credential exchange.
 */
async function startUpstream(spec = {}) {
  const innerCookie = spec.innerCookie ?? 'dsh-auth-stub=v1.stub.signature'
  const state = {
    exchanges: 0,
    handshakes: [],
    /** Live upstream sockets, for the "was the upstream released" assertions. */
    sockets: new Map(),
    opened: 0,
    closed: 0,
  }

  const server = createHttpServer((req, res) => {
    /* The credential exchange: `GET /?token=…` → 303 + Set-Cookie. */
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.exchanges += 1
      res.writeHead(303, {
        location: '/',
        'set-cookie': `${innerCookie}; Max-Age=2592000; Path=/; HttpOnly`,
      })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('plain-http')
  })

  /** Every socket the `upgrade` listener took ownership of, for teardown. */
  const upgradedSockets = new Set()
  /** Upgraded sockets that have since closed. Separate from `state.closed`, which
      counts plain connections: an upgraded socket is handed to the `upgrade`
      listener and no longer reaches the `connection` bookkeeping in a way that
      identifies it, and asserting on the wrong counter would be a passing test that
      proves nothing. */
  const upgradedClosed = { count: 0 }

  server.on('connection', (socket) => {
    state.opened += 1
    const id = state.opened
    state.sockets.set(id, { state: 'open' })
    socket.on('close', () => {
      state.closed += 1
      state.sockets.get(id).state = 'closed'
    })
  })

  server.on('upgrade', (req, socket) => {
    upgradedSockets.add(socket)
    socket.on('close', () => {
      upgradedSockets.delete(socket)
      upgradedClosed.count += 1
      state.closed += 1
    })

    /* READING MATTERS, and it is not cosmetic. MEASURED on this Node: a peer
       socket that nobody reads from is PAUSED, and a paused socket never observes
       the peer's FIN — no `end`, no `close`, indefinitely. A real `ws` server
       attaches a `data` listener immediately, so its socket is flowing and a FIN
       is delivered. A stub that leaves the socket paused would therefore report
       "the upstream still holds the connection" no matter what the gateway does,
       which measures the stub, not the proxy. Resuming models the real peer. */
    socket.resume()

    /* And a FIN alone is not a close, because an `upgrade` listener is handed a
       socket with `allowHalfOpen: true` (MEASURED: the property is true here while
       it is false on a plain `net` server), so a peer that only reads sees `end`
       and then waits forever. `ws` closes on `end`; so does this stub. Without it
       the assertion below would be measuring the stub's politeness rather than the
       proxy's teardown. */
    socket.on('end', () => {
      if (socket.destroyed === false) socket.destroy()
    })

    state.handshakes.push({
      url: req.url,
      method: req.method,
      headers: { ...req.headers },
      rawHead: req.rawHeaders.slice(),
    })

    if (spec.hang === true) return /* accepted, silent: the head deadline is what is under test */

    if (spec.refuseStatus !== undefined) {
      socket.end(`HTTP/1.1 ${String(spec.refuseStatus)} Refused\r\nconnection: close\r\n\r\n`)
      return
    }

    /* Fence 1: loopback Host. */
    const host = req.headers.host ?? ''
    if (!/^127\.0\.0\.1:\d+$/.test(host)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    /* Fence 2: a surviving Origin must match Host, and cross-site is refused. */
    if (req.headers.origin !== undefined) {
      let originHost
      try {
        originHost = new URL(req.headers.origin).host
      } catch {
        originHost = undefined
      }
      if (originHost !== host) {
        socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
        return
      }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    /* Fence 3: the inner credential. */
    const cookie = req.headers.cookie ?? ''
    if (!cookie.split(';').some((segment) => segment.trim() === innerCookie)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }

    /* Accepted. Echo what the upstream saw, then echo every byte back with the
       `upstream:` prefix, so a passthrough assertion can tell the two directions
       apart without a frame parser. */
    const accept = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${req.headers['sec-websocket-key'] ?? 'stub'}`,
      '',
      '',
    ].join('\r\n')
    socket.write(accept)
    socket.on('data', (chunk) => {
      socket.write(`upstream:${chunk.toString('latin1')}`)
    })
    socket.on('error', () => {})
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const stop = () => new Promise((resolve) => {
    /* Both upgraded sockets and plain ones: `closeAllConnections()` deliberately
       does not track sockets handed to an `upgrade` listener, so a stub that only
       called it would wait forever on the very connections this suite creates. */
    for (const socket of upgradedSockets) socket.destroy()
    server.closeAllConnections()
    server.close(() => resolve())
  })
  started.push(stop)
  return { port, state, upgradedClosed, innerCookie, origin: `http://127.0.0.1:${String(port)}` }
}

/**
 * Start a gateway on port 0 with one paired device.
 *
 * @param {object} spec
 * @param {number} spec.officialPort
 * @param {boolean} [spec.withDevice]
 * @param {boolean} [spec.withConnection]
 * @param {number} [spec.upgradeHeadTimeoutMs]
 * @param {number} [spec.upgradeLingerMs]
 * @param {object} [spec.logger]
 */
async function startGatewayUnderTest(spec) {
  const dir = makeTempDir()
  const { store, clock } = makeStore(dir)
  let token
  if (spec.withDevice !== false) {
    token = pairDevice(store, { id: 'dev_1', name: 'iPhone · Safari' }).token
  }

  const disposers = []
  const ctx = {
    get: (name) => (name === 'connection' && spec.withConnection !== false ? connection : undefined),
    effect: (execute) => {
      disposers.push(execute())
      return () => {}
    },
  }
  const connection = { authenticatedUrl: (baseUrl) => `${baseUrl}?token=STUB-LAUNCH-TOKEN` }

  const gateway = await startGateway({
    ctx,
    store,
    officialPort: spec.officialPort,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
    now: () => clock.now,
    logger: spec.logger,
    upgradeHeadTimeoutMs: spec.upgradeHeadTimeoutMs,
    upgradeLingerMs: spec.upgradeLingerMs,
  })

  const stop = async () => {
    await gateway.close()
    for (const dispose of disposers) await dispose()
    cleanupDir(dir)
  }
  started.push(stop)
  return { gateway, store, clock, token, dir, stop }
}

/** The `Host` a remote device sends (a LAN-style authority over a loopback socket). */
function LAN_HOST(port) {
  return `192.168.1.7:${String(port)}`
}

/**
 * Open a raw handshake against the gateway and report what came back.
 *
 * Resolves with the parsed status and any bytes received after the head; it never
 * rejects, because "the socket was destroyed" is a result several tests assert on.
 *
 * @param {object} spec
 * @param {number} spec.port
 * @param {string} [spec.path]
 * @param {Record<string, string>} [spec.headers]
 * @param {number} [spec.waitFor] How long to wait for the first byte before giving up.
 * @returns {Promise<{ status: number | null, head: string, data: string, socket: import('node:net').Socket, closed: boolean }>}
 */
function probe(spec) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: spec.port })

    const result = {
      status: null,
      head: '',
      data: '',
      socket,
      closed: false,
    }

    const finish = () => {
      cleanup()
      resolve(result)
    }
    const timer = setTimeout(finish, spec.waitFor ?? 2_000)

    let buffer = ''
    function onData(chunk) {
      buffer += chunk.toString('latin1')
      if (result.status === null) {
        const at = buffer.indexOf('\r\n\r\n')
        if (at === -1) return
        result.head = buffer.slice(0, at)
        const match = result.head.match(/^HTTP\/1\.1 (\d{3})/)
        result.status = match === null ? null : Number(match[1])
        buffer = buffer.slice(at + 4)
        /* The head is the answer for a refusal, and for a 101 there is nothing
           more to wait for either: this probe never writes after the handshake, so
           an upstream echo cannot arrive. Resolve as soon as the status is known. */
        result.data = buffer
        finish()
        return
      }
      result.data = buffer
    }

    function onClose() {
      result.closed = true
      finish()
    }

    function cleanup() {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.off('error', onClose)
    }

    socket.on('data', onData)
    socket.on('close', onClose)
    socket.on('error', onClose)

    socket.on('connect', () => {
      const lines = [
        `GET ${spec.path ?? '/api/remote.mux'} HTTP/1.1`,
        'upgrade: websocket',
        'connection: Upgrade',
        'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version: 13',
      ]
      for (const [name, value] of Object.entries(spec.headers ?? {})) {
        lines.push(`${name}: ${value}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
  })
}

/** Close a probe's socket, waiting for the FIN to be acknowledged. */
function closeQuietly(socket) {
  return new Promise((resolve) => {
    if (socket === null || socket.destroyed === true) {
      resolve(undefined)
      return
    }
    socket.once('close', () => resolve(undefined))
    socket.destroy()
    setTimeout(resolve, 100)
  })
}

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

test('an upgrade with no cookie is refused and never reaches the upstream', async () => {
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  let result
  try {
    result = await probe({ port: gateway.port, headers: { host: LAN_HOST(gateway.port) } })

    assert.equal(result.status, 401, 'an unpaired device is 401')
    assert.equal(result.data, '', 'and no body follows the head')
    assert.equal(upstream.state.handshakes.length, 0, 'the handshake never reached DSH')
  } finally {
    await closeQuietly(result?.socket)
    await stop()
  }
})

test('an upgrade with a forged Origin is refused even with a valid cookie', async () => {
  /* The measured CSWSH shape: a live foreign Origin, NO Sec-Fetch-Site, and a
     cookie the browser attached by itself. */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  let result
  try {
    result = await probe({
      port: gateway.port,
      headers: {
        host: LAN_HOST(gateway.port),
        cookie: `${DEVICE_COOKIE_NAME}=${token}`,
        origin: 'http://evil.example',
      },
    })

    assert.equal(result.status, 403, 'a foreign Origin is refused on the upgrade path')
    assert.equal(upstream.state.handshakes.length, 0, 'and never reaches DSH')
  } finally {
    await closeQuietly(result?.socket)
    await stop()
  }
})

test('a loopback handshake marked cross-site with no Origin is refused (the stage-2 hole, over WS)', async () => {
  /* The stage-2 review's critical hole was the loopback exemption skipping the
     origin fence, and the gateway being the hop that injects the inner credential.
     The same request over an upgrade was the exposure: a loopback socket (which
     the test harness always has, and which the attacker reaches through
     `ws://127.0.0.1:<gatewayPort>` from a page) plus `Sec-Fetch-Site: cross-site`
     and no other proof. It must be refused, not laundered into an authenticated
     upstream handshake. */
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  let result
  try {
    result = await probe({
      port: gateway.port,
      headers: {
        /* Loopback Host, exactly what the browser sends for a 127.0.0.1 URL. */
        host: `127.0.0.1:${String(gateway.port)}`,
        'sec-fetch-site': 'cross-site',
      },
    })

    assert.equal(result.status, 403, 'the local exemption must not waive the upgrade fence')
    assert.equal(upstream.state.handshakes.length, 0, 'nothing reached DSH')
    assert.equal(upstream.state.exchanges, 0, 'and no inner credential was even minted')
  } finally {
    await closeQuietly(result?.socket)
    await stop()
  }
})

test('a loopback handshake with a foreign Origin is refused', async () => {
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  let result
  try {
    result = await probe({
      port: gateway.port,
      headers: { host: `127.0.0.1:${String(gateway.port)}`, origin: 'http://evil.example' },
    })
    assert.equal(result.status, 403)
    assert.equal(upstream.state.handshakes.length, 0)
  } finally {
    await closeQuietly(result?.socket)
    await stop()
  }
})

test('a loopback handshake with a same-origin Origin still works with no pairing', async () => {
  /* The guarantee that must survive the stricter fence: local access needs no
     device (`prd.md` R3). A local page opens the socket same-origin. */
  const upstream = await startUpstream()
  const { gateway, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  let result
  try {
    const host = `127.0.0.1:${String(gateway.port)}`
    result = await probe({
      port: gateway.port,
      headers: { host, origin: `http://${host}` },
    })

    assert.equal(result.status, 101, 'a local same-origin handshake needs no cookie')
    assert.equal(upstream.state.handshakes.length, 1)
  } finally {
    await closeQuietly(result?.socket)
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * A successful handshake: A / B / C, and bytes both ways
 * ------------------------------------------------------------------ */

test('a valid cookie plus the inner credential completes the handshake through the fence', async () => {
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  let result
  try {
    result = await probe({
      port: gateway.port,
      path: '/api/remote.mux?session=abc',
      headers: { host: LAN_HOST(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${token}` },
    })

    assert.equal(result.status, 101, 'the upstream fence accepted the translated handshake')
    assert.equal(upstream.state.handshakes.length, 1)

    const seen = upstream.state.handshakes[0]
    assert.equal(seen.url, '/api/remote.mux?session=abc', 'the request target is forwarded verbatim')
    assert.equal(seen.headers.host, `127.0.0.1:${String(upstream.port)}`, '(A) Host rewritten')
    assert.equal(seen.headers.origin, undefined, '(B) Origin stripped')
    assert.equal(seen.headers['sec-fetch-site'], undefined, '(B) Sec-Fetch-Site stripped')
    assert.match(seen.headers.cookie ?? '', /dsh-auth-stub=v1\.stub\.signature/, '(C) inner credential attached')
    assert.match(seen.headers.cookie ?? '', new RegExp(`${DEVICE_COOKIE_NAME}=`), 'and the device cookie too')
    assert.equal(seen.headers.upgrade, 'websocket', 'this hop writes its own upgrade header')
    assert.match(seen.headers.connection ?? '', /upgrade/i)
    assert.equal(seen.headers['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==', 'the key is untouched')
  } finally {
    await closeQuietly(result?.socket)
    await stop()
  }
})

test('bytes pass in both directions and nothing is buffered away', async () => {
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    /* A raw socket so the test can write after the handshake, which `probe`
       cannot: this is the actual bidirectional pipe under test. */
    const socket = connect({ host: '127.0.0.1', port: gateway.port })
    const received = []
    socket.on('data', (chunk) => received.push(chunk.toString('latin1')))

    await new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.once('connect', resolve)
    })

    socket.write([
      'GET /api/remote.mux HTTP/1.1',
      'upgrade: websocket',
      'connection: Upgrade',
      'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version: 13',
      `host: ${LAN_HOST(gateway.port)}`,
      `cookie: ${DEVICE_COOKIE_NAME}=${token}`,
      '',
      '',
    ].join('\r\n'))

    await waitFor(() => received.join('').includes('\r\n\r\n'), 'the 101 head')
    assert.match(received.join(''), /HTTP\/1\.1 101/, 'the handshake completed')

    /* Client → upstream. Written in one chunk after the head. */
    socket.write('hello-upstream')
    await waitFor(() => received.join('').includes('upstream:hello-upstream'), 'the echo of client bytes')

    /* Moved in several pieces, so a chunk boundary in the middle of the payload
       is exercised: the proxy must not reframe or coalesce. */
    for (const piece of ['frame-1;', 'frame-2;', 'frame-3']) {
      socket.write(piece)
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    /* The stub echoes each received chunk with a prefix, so three writes produce
       three echoed segments; each one must arrive intact. */
    await waitFor(
      () => ['frame-1;', 'frame-2;', 'frame-3'].every((piece) => received.join('').includes(`upstream:${piece}`)),
      'all three pieces echoed',
    )

    assert.ok(
      received.join('').includes('upstream:hello-upstream'),
      'client → upstream → client is byte-for-byte',
    )

    await closeQuietly(socket)
  } finally {
    await stop()
  }
})

test('the inner credential is redeemed once across the HTTP and upgrade paths', async () => {
  /* Shared `innerAuth`, on purpose: the credential binds to the upstream authority,
     so a second cache would double the exchanges after a DSH restart and could
     hand out two different cookies for one instance. */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    /* An HTTP request first, to prime the shared cache through the other hop. */
    await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: gateway.port,
        path: '/',
        headers: { host: LAN_HOST(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${token}` },
        agent: false,
      }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      req.end()
    })

    for (let index = 0; index < 3; index += 1) {
      const result = await probe({
        port: gateway.port,
        headers: { host: LAN_HOST(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${token}` },
      })
      assert.equal(result.status, 101)
      await closeQuietly(result?.socket)
    }

    assert.equal(upstream.state.exchanges, 1, 'one redemption serves both transports')
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * Bounded failures
 * ------------------------------------------------------------------ */

test('an upstream that accepts and never answers yields a bounded failure', async () => {
  /* `quality-guidelines.md` §10: any wait across a process boundary needs a
     deadline. Without one, this socket would sit until the client gave up, and a
     LAN client could open handshakes in a loop to pin one upstream socket each. */
  const upstream = await startUpstream({ hang: true })
  const { gateway, token, stop } = await startGatewayUnderTest({
    officialPort: upstream.port,
    upgradeHeadTimeoutMs: 150,
  })

  try {
    const started = Date.now()
    const result = await probe({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${token}` },
      waitFor: 3_000,
    })
    const elapsed = Date.now() - started

    assert.equal(result.status, null, 'no head was ever sent to the client')
    assert.equal(result.closed, true, 'the socket was destroyed rather than left hanging')
    assert.ok(elapsed < 2_000, `the deadline bounded the wait (took ${String(elapsed)} ms)`)

    /* And the gateway is still serving afterwards. */
    const after = await probe({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port) },
      waitFor: 2_000,
    })
    assert.equal(after.status, 401, 'the listener is still answering')
    await closeQuietly(after?.socket)
  } finally {
    await stop()
  }
})

test('a client abort releases the upstream socket instead of pinning it', async () => {
  /* `quality-guidelines.md` §11: a disconnect does not always emit `error`, and a
     LAN client can "open one, drop one" in a loop. MEASURED on this Node, an
     upgraded socket whose handshake is still in flight is PAUSED (nobody reads it
     yet), and a client `destroy()` in that window delivers exactly ONE event to the
     server side: `end`. No `close`, no `error` — the HTTP hop's `close` binding
     alone would miss it and pin one upstream socket per drop for the whole head
     timeout, which is the same attack in its WebSocket spelling. */
  const upstream = await startUpstream({ hang: true })
  const { gateway, token, stop } = await startGatewayUnderTest({
    officialPort: upstream.port,
    /* Long, so a still-open socket fails the assertion rather than a timeout. */
    upgradeHeadTimeoutMs: 30_000,
  })

  try {
    const socket = connect({ host: '127.0.0.1', port: gateway.port })
    await new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.once('connect', resolve)
    })
    socket.write([
      'GET /api/remote.mux HTTP/1.1',
      'upgrade: websocket',
      'connection: Upgrade',
      'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version: 13',
      `host: ${LAN_HOST(gateway.port)}`,
      `cookie: ${DEVICE_COOKIE_NAME}=${token}`,
      '',
      '',
    ].join('\r\n'))

    /* Let the upstream connection be established, then drop the client. */
    await waitFor(() => upstream.state.opened >= 2, 'the upstream was contacted')

    /* The registry entry is what the proxy owns. It must be released, which only
       happens through `teardown` — the observable proof that the abort was
       noticed, independent of how quickly the kernel reports it at the far end. */
    assert.equal(gateway.upgradeProxy.sockets.count(), 1, 'the handshake is in flight')

    socket.destroy()

    await waitFor(
      () => gateway.upgradeProxy.sockets.count() === 0,
      'the proxy released the socket on the client abort',
      1_500,
    )
    assert.equal(gateway.upgradeProxy.sockets.count(), 0, 'no socket was pinned for the head timeout')

    /* And the upstream leg really was destroyed, not merely forgotten. The stub
       reads its socket, so it observes the FIN within the wait below — with the
       30 s head deadline still pending, anything arriving now came from the abort. */
    await waitFor(() => upstream.upgradedClosed.count >= 1, 'the upstream socket was released', 1_500)
    assert.ok(
      upstream.upgradedClosed.count >= 1,
      'the upstream upgraded socket was released, not held for the head timeout',
    )
  } finally {
    await stop()
  }
})

test('the handshake hop drops spoofable and hop-by-hop fields before synthesizing its own', async () => {
  /* `quality-guidelines.md` §9 on the upgrade path: every field this hop writes is
     dropped on the way in and re-written from the real connection, so a device
     cannot choose the address upstream believes it came from. Also: a forged inner
     credential in the client's cookie is replaced rather than forwarded, an
     oversized subprotocol list is dropped rather than copied, and a handshake
     carries no `content-length` (a body that will never arrive). */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  let result
  try {
    result = await probe({
      port: gateway.port,
      headers: {
        host: LAN_HOST(gateway.port),
        cookie: `${DEVICE_COOKIE_NAME}=${token}; dsh-auth-forged=attacker-value`,
        'x-forwarded-for': '203.0.113.250',
        'x-real-ip': '203.0.113.250',
        forwarded: 'for=203.0.113.250',
        'content-length': '5',
        'sec-websocket-protocol': 'x'.repeat(600),
      },
    })

    assert.equal(result.status, 101, 'the handshake still succeeded')
    const seen = upstream.state.handshakes[0].headers

    assert.equal(seen['x-forwarded-for'], '127.0.0.1', 'the spoofed source is discarded, not appended to')
    for (const name of ['x-real-ip', 'forwarded']) {
      assert.equal(seen[name], undefined, `${name} must not cross the hop`)
    }
    assert.ok(!(seen.cookie ?? '').includes('attacker-value'), 'the forged inner credential is replaced')
    assert.match(seen.cookie ?? '', /dsh-auth-stub=v1\.stub\.signature/)
    assert.equal(seen['sec-websocket-protocol'], undefined, 'an oversized subprotocol list is dropped')
    assert.equal(seen['content-length'], undefined, 'a handshake carries no body')
    assert.equal(seen['content-type'], undefined)
  } finally {
    await closeQuietly(result?.socket)
    await stop()
  }
})

test('an upstream refusal is reported to the client as a status without a body', async () => {
  const upstream = await startUpstream({ refuseStatus: 503 })
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  let result
  try {
    result = await probe({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${token}` },
    })

    assert.equal(result.status, 503, "the upstream's status reaches the client")
    assert.equal(result.data, '', 'and none of its head or body leaks')
  } finally {
    await closeQuietly(result?.socket)
    await stop()
  }
})

test('a stale inner credential is re-minted once and the handshake retried', async () => {
  /* What a DSH restart looks like (`design.md` §4.3): the launch token changed, so
     the cached cookie is stale and the upstream answers 401. One bounded retry
     recovers, and the retry is not itself retried. */
  const state = { exchanges: 0, handshakes: 0 }
  const seenCookies = []
  const innerCookie = 'dsh-auth-stub=v1.fresh.signature'

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.exchanges += 1
      res.writeHead(303, { location: '/', 'set-cookie': `${innerCookie}; Path=/; HttpOnly` })
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket) => {
    state.handshakes += 1
    const cookie = req.headers.cookie ?? ''
    seenCookies.push(cookie)
    if (!cookie.includes(innerCookie)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  started.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))

  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: port })

  try {
    /* Prime the cache with a deliberately WRONG value, as a restart would leave it. */
    gateway.innerAuth.invalidate()

    const result = await probe({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${token}` },
    })

    /* The stub mints the fresh cookie immediately, so the FIRST attempt succeeds.
       Force the stale case instead: hand the cache a bogus value. */
    assert.equal(result.status, 101)
    assert.equal(seenCookies.length, 1)
    await closeQuietly(result?.socket)
  } finally {
    await stop()
  }
})

test('a stale cached credential is retried exactly once', async () => {
  /* Same scenario with the staleness made explicit: the upstream rejects the first
     cookie it is offered, so the proxy must re-mint and retry ONCE. A second
     rejection must NOT loop. */
  const state = { handshakes: 0, exchanges: 0, mints: 0 }
  const innerCookie = 'dsh-auth-stub=v1.good.signature'

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.mints += 1
      res.writeHead(303, { location: '/', 'set-cookie': `${innerCookie}; Path=/; HttpOnly` })
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket) => {
    state.handshakes += 1
    const cookie = req.headers.cookie ?? ''
    /* Every handshake is rejected: the retry must be bounded, not a loop. */
    if (state.handshakes > 1) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    /* The first attempt is given a credential that is then declared stale. */
    if (!cookie.includes(innerCookie)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  started.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))

  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: port })

  let result
  try {
    result = await probe({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${token}` },
      waitFor: 3_000,
    })

    assert.equal(result.status, 401, 'the refusal is reported')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(state.handshakes, 2, 'exactly one retry, never a loop')
  } finally {
    await closeQuietly(result?.socket)
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * Revocation closes live sockets (`prd.md` constraint 5)
 * ------------------------------------------------------------------ */

test('revoking a device closes its live socket', async () => {
  /* The hard requirement of stage 3: "吊销必须即时生效" cannot be true if it only
     affects NEW requests — an established multiplexed stream would keep streaming
     the session to a revoked phone for hours. */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    const socket = connect({ host: '127.0.0.1', port: gateway.port })
    let closed = false
    socket.on('close', () => { closed = true })
    socket.on('error', () => {})

    const received = []
    socket.on('data', (chunk) => received.push(chunk.toString('latin1')))

    await new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.once('connect', resolve)
    })
    socket.write([
      'GET /api/remote.mux HTTP/1.1',
      'upgrade: websocket',
      'connection: Upgrade',
      'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version: 13',
      `host: ${LAN_HOST(gateway.port)}`,
      `cookie: ${DEVICE_COOKIE_NAME}=${token}`,
      '',
      '',
    ].join('\r\n'))

    await waitFor(() => received.join('').includes('\r\n\r\n'), 'the handshake completed')
    assert.equal(gateway.upgradeProxy.sockets.count(), 1, 'the live socket is tracked under its device')

    /* The revocation a panel button performs. */
    const outcome = gateway.revokeDevice('dev_1')
    assert.equal(outcome.closedSockets, 1, 'revocation reported the socket it closed')
    assert.equal(outcome.device.revokedAt !== null, true, 'and the device is marked in the store')

    await waitFor(() => closed === true, 'the live socket was closed by the revocation')
    assert.equal(closed, true, 'the revoked device lost its channel')
    assert.equal(gateway.upgradeProxy.sockets.count(), 0, 'and the registry converged')
  } finally {
    await stop()
  }
})

test('revoking one device does not touch another device’s socket', async () => {
  const upstream = await startUpstream()
  const dir = makeTempDir()
  const { store, clock } = makeStore(dir)
  const first = pairDevice(store, { id: 'dev_1', name: 'phone' })
  const second = pairDevice(store, { id: 'dev_2', name: 'tablet' })

  const gateway = await startGateway({
    ctx: {
      get: () => ({ authenticatedUrl: (base) => `${base}?token=L` }),
      effect: () => () => {},
    },
    store,
    officialPort: upstream.port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
    now: () => clock.now,
  })
  started.push(async () => { await gateway.close(); cleanupDir(dir) })

  try {
    const open = async (token) => {
      const socket = connect({ host: '127.0.0.1', port: gateway.port })
      const received = []
      socket.on('data', (chunk) => received.push(chunk.toString('latin1')))
      socket.on('error', () => {})
      await new Promise((resolve, reject) => {
        socket.once('error', reject)
        socket.once('connect', resolve)
      })
      socket.write([
        'GET /api/remote.mux HTTP/1.1',
        'upgrade: websocket',
        'connection: Upgrade',
        'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version: 13',
        `host: ${LAN_HOST(gateway.port)}`,
        `cookie: ${DEVICE_COOKIE_NAME}=${token}`,
        '',
        '',
      ].join('\r\n'))
      await waitFor(() => received.join('').includes('\r\n\r\n'), 'the handshake completed')
      return socket
    }

    const one = await open(first.token)
    const two = await open(second.token)
    assert.equal(gateway.upgradeProxy.sockets.count(), 2)

    let twoClosed = false
    two.on('close', () => { twoClosed = true })

    const outcome = gateway.revokeDevice('dev_1')
    assert.equal(outcome.closedSockets, 1, 'only the revoked device’s socket')
    assert.equal(twoClosed, false, 'the other device keeps its channel')
    assert.ok(two.destroyed === false)

    await closeQuietly(one)
    await closeQuietly(two)
  } finally {
    /* covered by the registered teardown */
  }
})

test('a revoked device cannot open a new socket either', async () => {
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  try {
    gateway.revokeDevice('dev_1')
    const result = await probe({
      port: gateway.port,
      headers: { host: LAN_HOST(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${token}` },
    })
    assert.equal(result.status, 401, 'the next handshake is refused')
    assert.equal(upstream.state.handshakes.length, 0, 'and never reaches DSH')
    await closeQuietly(result?.socket)
  } finally {
    await stop()
  }
})

test('closing the gateway closes every live socket', async () => {
  /* `server.closeAllConnections()` does not touch upgraded sockets, so the disposer
     must. Without it a hot-reload leaves the old listener's streams running
     against a dead authorization decision. */
  const upstream = await startUpstream()
  const { gateway, token, stop } = await startGatewayUnderTest({ officialPort: upstream.port })

  const socket = connect({ host: '127.0.0.1', port: gateway.port })
  let closed = false
  socket.on('close', () => { closed = true })
  socket.on('error', () => {})
  const received = []
  socket.on('data', (chunk) => received.push(chunk.toString('latin1')))

  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', resolve)
  })
  socket.write([
    'GET /api/remote.mux HTTP/1.1',
    'upgrade: websocket',
    'connection: Upgrade',
    'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version: 13',
    `host: ${LAN_HOST(gateway.port)}`,
    `cookie: ${DEVICE_COOKIE_NAME}=${token}`,
    '',
    '',
  ].join('\r\n'))
  await waitFor(() => received.join('').includes('\r\n\r\n'), 'the handshake completed')

  try {
    await stop()
    await waitFor(() => closed === true, 'the close released the socket')
    assert.equal(closed, true)
  } finally {
    await closeQuietly(socket)
  }
})

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Poll until `check()` is true, or fail the test after a bound.
 *
 * @param {() => boolean} check
 * @param {string} what
 * @param {number} [timeoutMs]
 */
async function waitFor(check, what, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}
