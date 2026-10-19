/**
 * Origin / Sec-Fetch-Site fence.
 *
 * `design.md` §3.2 step 3 and the parent's measured matrix. Four arms, and each
 * one gets its own case because the whole point is that they are distinguishable:
 *
 *   cross-site (any method)                       -> reject
 *   write + Origin mismatching Host               -> reject
 *   write + no Origin + same-origin/same-site     -> allow
 *   write + no Origin + no Sec-Fetch-Site         -> reject
 *
 * A read is never asked for an origin, which is what keeps a top-level navigation
 * and the stage-2 `curl` acceptance step working.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  authorityOf,
  checkOrigin,
  isWriteMethod,
} from '../src/host/gateway/origin.js'
import * as gatewayFence from '../src/host/gateway/origin.js'
import { checkAdminOrigin } from '../src/host/origin.js'
import { PANEL_MARKER_HEADER, PANEL_MARKER_VALUE } from '../src/host/constants.js'

/**
 * A request-shaped object carrying only the headers the fence reads.
 *
 * @param {string} method
 * @param {Record<string, string>} [headers]
 */
function request(method, headers = {}) {
  return { method, headers }
}

test('isWriteMethod treats GET, HEAD and OPTIONS as reads', () => {
  for (const method of ['GET', 'get', 'HEAD', 'OPTIONS']) {
    assert.equal(isWriteMethod(method), false, `${method} must not need an origin assertion`)
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE']) {
    assert.equal(isWriteMethod(method), true, `${method} mutates and must be fenced`)
  }
  /* A request with no method at all is not something to be lenient about. */
  assert.equal(isWriteMethod(undefined), true)
})

test('authorityOf normalizes through WHATWG parsing', () => {
  assert.equal(authorityOf('http://192.168.1.7:3090'), '192.168.1.7:3090')
  assert.equal(authorityOf('http://LAN.local:3090'), 'lan.local:3090', 'hostname is lower-cased')
  assert.equal(authorityOf('http://example.com:80'), 'example.com', 'a default port is dropped')
  assert.equal(authorityOf('not a url'), undefined)
  assert.equal(authorityOf(''), undefined)
  assert.equal(authorityOf(undefined), undefined)
  assert.equal(authorityOf(42), undefined)
})

/* ------------------------------------------------------------------ *
 * Arm 1: cross-site is rejected outright
 * ------------------------------------------------------------------ */

test('Sec-Fetch-Site: cross-site is rejected even on a read', () => {
  const verdict = checkOrigin(request('GET', { host: 'lan:3090', 'sec-fetch-site': 'cross-site' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-site')
})

test('Sec-Fetch-Site: cross-site is rejected even when Origin matches Host', () => {
  /* The stronger signal wins: a page cannot forge Sec-Fetch-Site, so it is
     believed over a matching Origin (which a non-browser client can set freely). */
  const verdict = checkOrigin(request('POST', {
    host: 'lan:3090',
    origin: 'http://lan:3090',
    'sec-fetch-site': 'cross-site',
  }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-site')
})

test('the cross-site comparison is case-insensitive', () => {
  assert.equal(checkOrigin(request('GET', { host: 'lan:3090', 'sec-fetch-site': 'CROSS-SITE' })).ok, false)
})

/* ------------------------------------------------------------------ *
 * Arm 2: a write carrying Origin must match Host
 * ------------------------------------------------------------------ */

test('a same-origin write passes', () => {
  const verdict = checkOrigin(request('POST', { host: '192.168.1.7:3090', origin: 'http://192.168.1.7:3090' }))
  assert.equal(verdict.ok, true)
})

test('a same-origin write passes regardless of hostname case and a default port', () => {
  assert.equal(checkOrigin(request('POST', {
    host: 'Lan.Local:3090',
    origin: 'http://lan.local:3090',
  })).ok, true)
  assert.equal(checkOrigin(request('POST', {
    host: 'lan.local:80',
    origin: 'http://lan.local',
  })).ok, true, 'the default port is stripped on both sides, so they still match')
})

test('a cross-origin write is rejected', () => {
  const verdict = checkOrigin(request('POST', { host: '192.168.1.7:3090', origin: 'http://evil.example' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-origin')
})

test('a forged Origin on a different PORT of the same host is rejected', () => {
  /* A different port is a different origin, and the gateway port is the only one
     that should be able to drive it. */
  const verdict = checkOrigin(request('POST', { host: '192.168.1.7:3090', origin: 'http://192.168.1.7:8080' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-origin')
})

test('a malformed Origin on a write is rejected instead of throwing', () => {
  const verdict = checkOrigin(request('POST', { host: 'lan:3090', origin: 'null' }))
  /* `null` is what a sandboxed iframe sends; it is not an origin we can trust. */
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'bad-origin')
})

test('a missing Host on a write with an Origin is rejected', () => {
  const verdict = checkOrigin(request('POST', { origin: 'http://lan:3090' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'bad-host')
})

/* ------------------------------------------------------------------ *
 * Arm 3: a write without Origin but with a same-site declaration passes
 * ------------------------------------------------------------------ */

test('a write with no Origin but Sec-Fetch-Site: same-origin passes', () => {
  /* This is the arm that keeps a same-origin browser POST working. Some
     same-origin fetch implementations omit Origin; rejecting those would break a
     perfectly legitimate request, which is why the unconditional reading of
     `design.md` §3.2's "no Origin -> 403" is a CSRF rule, not a header rule. */
  const verdict = checkOrigin(request('POST', { host: '192.168.1.7:3090', 'sec-fetch-site': 'same-origin' }))
  assert.equal(verdict.ok, true)
})

test('a write with no Origin but Sec-Fetch-Site: same-site passes', () => {
  const verdict = checkOrigin(request('DELETE', { host: '192.168.1.7:3090', 'sec-fetch-site': 'same-site' }))
  assert.equal(verdict.ok, true)
})

test('Sec-Fetch-Site: none does not excuse a missing Origin on a write', () => {
  /* `none` means a user-initiated navigation (typed URL, bookmark). A write is not
     a navigation, so this is not the same-site assertion it looks like. */
  const verdict = checkOrigin(request('POST', { host: 'lan:3090', 'sec-fetch-site': 'none' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'no-origin')
})

/* ------------------------------------------------------------------ *
 * Arm 4: a write with neither Origin nor Sec-Fetch-Site is rejected
 * ------------------------------------------------------------------ */

test('a write with no Origin and no Sec-Fetch-Site is rejected', () => {
  /* The CSRF shape: a non-browser agent forging a cookie-bearing write. This is
     the arm that honours design.md §3.2. */
  const verdict = checkOrigin(request('POST', { host: '192.168.1.7:3090' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'no-origin')
})

/* ------------------------------------------------------------------ *
 * Referer fallback: real same-origin writes that carry neither marker
 * ------------------------------------------------------------------ */

test('a same-origin write with no Origin and no Sec-Fetch-Site but a same-origin Referer passes', () => {
  /* Measured against the running GUI: the device panel's Save and Generate-code
     buttons issue `POST /remote-control/api/settings` with no `Origin` and no
     `Sec-Fetch-Site`. Before this arm existed the panel answered 403
     `admin/cross-origin` and both buttons failed — the feature looked broken
     while the fence was "working". */
  const verdict = checkOrigin(request('POST', {
    host: '127.0.0.1:19387',
    referer: 'http://127.0.0.1:19387/',
  }))
  assert.equal(verdict.ok, true)
})

test('a cross-site Referer is rejected, so the fallback cannot be borrowed by an attacker', () => {
  /* A page on evil.example cannot produce a same-origin Referer: the browser owns
     that header and fills it with the ATTACKER's origin. */
  const verdict = checkOrigin(request('POST', {
    host: '127.0.0.1:19387',
    referer: 'http://evil.example/attack.html',
  }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-origin')
})

test('Sec-Fetch-Site: cross-site still wins even when the Referer happens to match', () => {
  /* Arm 1 runs before the fallback and must not be bypassed by a header a proxy
     or an unusual client could echo back. */
  const verdict = checkOrigin(request('POST', {
    host: '127.0.0.1:19387',
    'sec-fetch-site': 'cross-site',
    referer: 'http://127.0.0.1:19387/',
  }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-site')
})

test('an unparsable Referer does not become a pass', () => {
  const verdict = checkOrigin(request('POST', { host: '127.0.0.1:19387', referer: 'not a url' }))
  assert.equal(verdict.ok, false)
})

test('a bare curl POST with no headers at all is rejected', () => {
  const verdict = checkOrigin(request('POST', {}))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'no-origin')
})

/* ------------------------------------------------------------------ *
 * Reads need no origin at all
 * ------------------------------------------------------------------ */

test('a read with no Origin and no Sec-Fetch-Site passes', () => {
  /* A top-level navigation and a plain `curl GET`: both must work, and both are
     how the stage-2 curl acceptance step exercises the gateway. */
  assert.equal(checkOrigin(request('GET', { host: '192.168.1.7:3090' })).ok, true)
  assert.equal(checkOrigin(request('HEAD', { host: '192.168.1.7:3090' })).ok, true)
  assert.equal(checkOrigin(request('OPTIONS', { host: '192.168.1.7:3090' })).ok, true)
})

test('a read carrying a matching Origin passes', () => {
  assert.equal(checkOrigin(request('GET', {
    host: 'lan:3090',
    origin: 'http://lan:3090',
  })).ok, true)
})

test('a read carrying a mismatched Origin still passes', () => {
  /* Reads are not the CSRF risk; a read with a foreign Origin is a page that
     wants a cross-origin GET, which CORS decides (the proxy forwards it and the
     browser applies the policy). Rejecting here would break nothing we are
     protecting and would surprise a legitimate embedding. */
  assert.equal(checkOrigin(request('GET', { host: 'lan:3090', origin: 'http://evil.example' })).ok, true)
})

/* ------------------------------------------------------------------ *
 * Robustness
 * ------------------------------------------------------------------ */

test('repeated headers collapse to their first value', () => {
  const verdict = checkOrigin({
    method: 'POST',
    headers: { host: 'lan:3090', origin: ['http://lan:3090', 'http://evil.example'] },
  })
  assert.equal(verdict.ok, true, 'the first Origin value is the one considered')
})

test('a request with no headers object at all does not throw', () => {
  assert.doesNotThrow(() => checkOrigin({ method: 'GET' }))
  assert.equal(checkOrigin({ method: 'GET' }).ok, true)
  assert.equal(checkOrigin({ method: 'POST' }).ok, false)
})

/* ------------------------------------------------------------------ *
 * The admin API entry: one extra arm, for the dsh desktop app
 * ------------------------------------------------------------------ */

test('the desktop shell write is admitted by the panel marker, and only by it', () => {
  /* Measured shape of a write forwarded by the dsh desktop app: the Electron main
     process deletes `origin`, `sec-fetch-site`, `host` and `cookie`, so the
     request reaches the loopback port with no origin proof — arm 4's shape. The
     panel's own marker is what it can still carry. */
  const shellWrite = {
    host: '127.0.0.1:19387',
    referer: 'dsh-app://app/',
    cookie: 'dsh-auth-example=1',
    [PANEL_MARKER_HEADER]: PANEL_MARKER_VALUE,
  }
  assert.equal(checkAdminOrigin(request('POST', shellWrite)).ok, true)
  assert.equal(checkAdminOrigin(request('POST', { ...shellWrite, [PANEL_MARKER_HEADER]: 'yes' })).ok, false)
  assert.equal(checkAdminOrigin(request('POST', { host: '127.0.0.1:19387', referer: 'dsh-app://app/' })).ok, false)
  /* The Referer alone is NOT a pass: `dsh-app://` names a non-HTTP authority that
     can never equal the loopback Host, and treating a foreign Referer as a pass
     would reopen exactly what the Referer arm closes. */
  assert.equal(checkAdminOrigin(request('POST', { host: '127.0.0.1:19387', referer: 'dsh-app://app/' })).reason, 'cross-origin')
})

test('the marker is ignored whenever an Origin is present, and by a cross-site declaration', () => {
  /* Arm 2 of the base fence still decides a browser-shaped request: a cross-site
     page always sends `Origin`, so the marker can never be a way around it. */
  const withMarker = (headers) => request('POST', { [PANEL_MARKER_HEADER]: PANEL_MARKER_VALUE, ...headers })

  assert.equal(checkAdminOrigin(withMarker({ host: '127.0.0.1:19387', origin: 'https://evil.example' })).ok, false)
  assert.equal(checkAdminOrigin(withMarker({ host: '127.0.0.1:19387', origin: 'https://evil.example' })).reason, 'cross-origin')
  assert.equal(checkAdminOrigin(withMarker({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })).ok, false)
  assert.equal(checkAdminOrigin(withMarker({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })).reason, 'cross-site')
  /* And a same-origin browser write is still admitted by arm 2, marker or not. */
  assert.equal(checkAdminOrigin(request('POST', { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' })).ok, true)
  assert.equal(checkAdminOrigin(withMarker({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' })).ok, true)
})

test('the admin entry differs from the gateway fence ONLY by the marker arm', () => {
  /* The gateway is reachable from a LAN page and answers preflights through the
     proxy, so the marker must never widen it. This is the assertion that keeps the
     two entries from drifting into one. */
  const shellWrite = request('POST', {
    host: '127.0.0.1:19387',
    referer: 'dsh-app://app/',
    [PANEL_MARKER_HEADER]: PANEL_MARKER_VALUE,
  })
  assert.equal(checkOrigin(shellWrite).ok, false, 'the gateway fence ignores the marker')
  assert.equal(checkAdminOrigin(shellWrite).ok, true, 'the admin fence accepts it')

  /* Every other shape agrees between the two entries. */
  for (const headers of [
    { host: 'lan:3090', origin: 'http://lan:3090' },
    { host: 'lan:3090', origin: 'http://evil.example' },
    { host: 'lan:3090', 'sec-fetch-site': 'same-origin' },
    { host: 'lan:3090', 'sec-fetch-site': 'cross-site' },
    { host: 'lan:3090' },
    { host: '127.0.0.1:19387', referer: 'http://127.0.0.1:19387/' },
  ]) {
    assert.deepEqual(
      checkAdminOrigin(request('POST', headers)),
      checkOrigin(request('POST', headers)),
      `same verdict for ${JSON.stringify(headers)}`,
    )
  }
})

test('gateway/origin.js does not re-export the admin entry', () => {
  /* `gateway/auth.js` imports the module namespace, so an accidental re-export
     would silently widen the LAN-facing fence. */
  assert.equal(typeof gatewayFence.checkOrigin, 'function')
  assert.equal(gatewayFence.checkAdminOrigin, undefined)
})
