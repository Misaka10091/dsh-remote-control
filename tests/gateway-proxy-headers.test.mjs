/**
 * The proxy's header translation, in isolation.
 *
 * The three rewrites of `design.md` §4.4 are the whole reason a naive proxy gets
 * a 401/403 from the official port. Testing them through a live server is not
 * enough, and the `Host` rewrite makes the point: Node's `http.request` supplies a
 * `Host` from `hostname:port` when the header is absent, so an end-to-end test
 * cannot tell an explicit rewrite from an accidental default — it passes either
 * way. Asserting on the built header set can, and that is what this file does.
 *
 * It also covers the response side, where the inner credential must never travel
 * toward a client.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { downstreamHeaders, upstreamHeaders } from '../src/host/gateway/proxy.js'

/** A request stub with only what the header builder reads. */
function request(headers = {}, method = 'GET') {
  return { method, headers }
}

const UPSTREAM = { upstreamHost: '127.0.0.1:19387', innerCookie: 'dsh-auth-x=v1.s' }

/* ------------------------------------------------------------------ *
 * (A) Host is rewritten to the upstream authority
 * ------------------------------------------------------------------ */

test('the client Host is replaced by the upstream authority', () => {
  /* Asserted on the built headers, not on the wire: see the file note. */
  const headers = upstreamHeaders(
    request({ host: '192.168.1.7:3090' }),
    { ...UPSTREAM, peer: '192.168.1.7' },
  )
  assert.equal(headers.host, '127.0.0.1:19387')
})

test('a loopback client Host is replaced too, not passed through', () => {
  const headers = upstreamHeaders(
    request({ host: '127.0.0.1:3090' }),
    { ...UPSTREAM, peer: '127.0.0.1' },
  )
  /* The client's loopback port is the GATEWAY's port, not the official one. Forwarding
     it verbatim points the fence at the wrong authority. */
  assert.equal(headers.host, '127.0.0.1:19387')
})

test('a rebound public Host is replaced, not trusted', () => {
  const headers = upstreamHeaders(
    request({ host: 'rebind.evil.example:3090' }),
    { ...UPSTREAM, peer: '127.0.0.1' },
  )
  assert.equal(headers.host, '127.0.0.1:19387')
})

/* ------------------------------------------------------------------ *
 * (B) Origin and Sec-Fetch-* are stripped
 * ------------------------------------------------------------------ */

test('Origin is stripped and never forwarded', () => {
  /* The measured failure: `isTrustedApiRequest` compares `origin.host` against the
     rewritten Host, so a surviving Origin from the LAN authority is an
     unconditional 403. */
  const headers = upstreamHeaders(
    request({ host: '192.168.1.7:3090', origin: 'http://192.168.1.7:3090' }),
    { ...UPSTREAM, peer: '192.168.1.7' },
  )
  assert.equal(headers.origin, undefined)
})

test('every Sec-Fetch-* header is stripped', () => {
  const headers = upstreamHeaders(
    request({
      host: '192.168.1.7:3090',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'sec-fetch-user': '?1',
    }),
    { ...UPSTREAM, peer: '192.168.1.7' },
  )
  for (const name of ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) {
    assert.equal(headers[name], undefined, `${name} must not survive the hop`)
  }
})

test('stripping Origin happens in the same pass as rewriting Host', () => {
  /* The pair is the point. A future edit that reintroduces one without the other
     produces an unexplainable 403, so they are asserted together on one input. */
  const headers = upstreamHeaders(
    request({ host: 'lan:3090', origin: 'http://lan:3090', 'sec-fetch-site': 'cross-site' }),
    { ...UPSTREAM, peer: 'lan' },
  )
  assert.equal(headers.host, '127.0.0.1:19387', '(A) applied')
  assert.equal(headers.origin, undefined, '(B) applied')
  assert.equal(headers['sec-fetch-site'], undefined, '(B) applied')
})

/* ------------------------------------------------------------------ *
 * (C) The inner credential is attached, and client credentials are replaced
 * ------------------------------------------------------------------ */

test('the inner credential is attached even when the client sent no cookie', () => {
  const headers = upstreamHeaders(request({ host: 'lan:3090' }), { ...UPSTREAM, peer: 'lan' })
  assert.equal(headers.cookie, 'dsh-auth-x=v1.s')
})

test('the inner credential is attached ahead of the device cookie', () => {
  const headers = upstreamHeaders(
    request({ host: 'lan:3090', cookie: 'dsh-rc-device=device-token' }),
    { ...UPSTREAM, peer: 'lan' },
  )
  assert.equal(headers.cookie, 'dsh-auth-x=v1.s; dsh-rc-device=device-token')
})

test('with no inner credential available the client cookie is forwarded unchanged', () => {
  /* The degraded path: no `ctx.connection`, so no credential is minted. The request
     proceeds and the upstream 401 is relayed — that is the documented behaviour, so
     the device cookie must still be forwarded rather than dropped. */
  const headers = upstreamHeaders(
    request({ host: 'lan:3090', cookie: 'dsh-rc-device=device-token' }),
    { upstreamHost: '127.0.0.1:19387', innerCookie: undefined, peer: 'lan' },
  )
  assert.equal(headers.cookie, 'dsh-rc-device=device-token')
})

test('with neither kind of cookie the header is absent rather than empty', () => {
  const headers = upstreamHeaders(
    request({ host: 'lan:3090' }),
    { upstreamHost: '127.0.0.1:19387', innerCookie: undefined, peer: 'lan' },
  )
  assert.equal(headers.cookie, undefined)
})

/* ------------------------------------------------------------------ *
 * Hop-by-hop and framing headers
 * ------------------------------------------------------------------ */

test('hop-by-hop request headers do not cross the hop', () => {
  const headers = upstreamHeaders(
    request({
      host: 'lan:3090',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      te: 'trailers',
      trailer: 'x',
      upgrade: 'websocket',
      expect: '100-continue',
      'proxy-connection': 'keep-alive',
    }),
    { ...UPSTREAM, peer: 'lan' },
  )
  for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect', 'proxy-connection']) {
    assert.equal(headers[name], undefined, `${name} is hop-by-hop and must be dropped`)
  }
})

test('end-to-end request headers survive', () => {
  const headers = upstreamHeaders(
    request({
      host: 'lan:3090',
      accept: 'text/event-stream',
      'accept-encoding': 'gzip, deflate',
      'content-type': 'application/json',
      'content-length': '12',
      'user-agent': 'UA/1',
      'if-none-match': 'W/"abc"',
      'x-custom': 'kept',
    }),
    { ...UPSTREAM, peer: 'lan' },
  )
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal(headers['accept-encoding'], 'gzip, deflate', 'the proxy does not force identity')
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['content-length'], '12')
  assert.equal(headers['user-agent'], 'UA/1')
  assert.equal(headers['if-none-match'], 'W/"abc"')
  assert.equal(headers['x-custom'], 'kept')
})

test('forwarding headers describe the real hop', () => {
  const headers = upstreamHeaders(
    request({ host: 'lan:3090' }),
    { ...UPSTREAM, peer: '192.168.1.7' },
  )
  assert.equal(headers['x-forwarded-for'], '192.168.1.7')
  assert.equal(headers['x-forwarded-host'], 'lan:3090')
  assert.equal(headers['x-forwarded-proto'], 'http')
  assert.equal(headers['x-dsh-remote-control'], 'gateway')
})

test('a client-supplied X-Forwarded-For is discarded, not appended to', () => {
  /* Appending is correct behind a trusted CDN and a spoofing vector behind
     nothing. The gateway is the first hop by construction. */
  const headers = upstreamHeaders(
    request({ host: 'lan:3090', 'x-forwarded-for': '203.0.113.250, 10.0.0.1' }),
    { ...UPSTREAM, peer: '192.168.1.7' },
  )
  assert.equal(headers['x-forwarded-for'], '192.168.1.7')
})

test('a duplicated header value survives as-is', () => {
  /* Node hands repeated headers back as arrays; forwarding the array is what lets
     `cookie` and `x-forwarded-*` chain correctly. Nothing here inspects them. */
  const headers = upstreamHeaders(
    request({ host: 'lan:3090', 'accept-language': ['en', 'zh'] }),
    { ...UPSTREAM, peer: 'lan' },
  )
  assert.deepEqual(headers['accept-language'], ['en', 'zh'])
})

/* ------------------------------------------------------------------ *
 * Response headers
 * ------------------------------------------------------------------ */

test('an upstream set-cookie carrying an inner credential is dropped', () => {
  /* The security red line: the inner cookie is instance-wide access and must never
     reach a client, not even one that already holds a device token. */
  const { headers, droppedCookies } = downstreamHeaders({
    headers: {
      'content-type': 'text/plain',
      'set-cookie': [
        'dsh-auth-abc=v1.payload.signature; Path=/; HttpOnly',
        'harmless=1; Path=/',
      ],
    },
  })

  assert.equal(droppedCookies, 1)
  assert.deepEqual(headers['set-cookie'], ['harmless=1; Path=/'])
})

test('the whole set-cookie header disappears when every entry is an inner credential', () => {
  const { headers, droppedCookies } = downstreamHeaders({
    headers: { 'set-cookie': ['dsh-auth-a=v1.x.y', 'dsh-auth-b=v1.z.w'] },
  })
  assert.equal(droppedCookies, 2)
  assert.equal(headers['set-cookie'], undefined)
})

test('a single-string set-cookie carrying an inner credential is dropped', () => {
  const { headers, droppedCookies } = downstreamHeaders({
    headers: { 'set-cookie': 'dsh-auth-a=v1.x.y; Path=/' },
  })
  assert.equal(droppedCookies, 1)
  assert.equal(headers['set-cookie'], undefined)
})

test('a device cookie set by upstream passes through', () => {
  const { headers, droppedCookies } = downstreamHeaders({
    headers: { 'set-cookie': 'dsh-rc-device=tok; Path=/; HttpOnly' },
  })
  assert.equal(droppedCookies, 0)
  assert.deepEqual(headers['set-cookie'], ['dsh-rc-device=tok; Path=/; HttpOnly'])
})

test('hop-by-hop response headers are dropped and end-to-end ones survive', () => {
  const { headers } = downstreamHeaders({
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'content-encoding': 'gzip',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      trailer: 'x',
      upgrade: 'h2c',
    },
  })

  for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'trailer', 'upgrade']) {
    assert.equal(headers[name], undefined, `${name} is hop-by-hop`)
  }
  assert.equal(headers['content-type'], 'text/event-stream')
  assert.equal(headers['cache-control'], 'no-store')
  /* `content-encoding: gzip` is preserved: the proxy never decodes the body, so
     the header stays truthful end to end (`design.md` §4.1). */
  assert.equal(headers['content-encoding'], 'gzip')
})

test('a response with an absent headers object does not throw', () => {
  assert.deepEqual(downstreamHeaders({}).headers, {})
  assert.deepEqual(downstreamHeaders(undefined).headers, {})
})

test('undefined header values are skipped rather than forwarded', () => {
  const headers = upstreamHeaders(
    request({ host: 'lan:3090', 'x-missing': undefined }),
    { ...UPSTREAM, peer: 'lan' },
  )
  assert.equal('x-missing' in headers, false)
})
