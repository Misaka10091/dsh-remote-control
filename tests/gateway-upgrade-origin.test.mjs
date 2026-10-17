/**
 * The upgrade fence (`origin.js` `checkUpgradeOrigin`).
 *
 * A WebSocket upgrade is a `GET`, but the read arms of `checkOrigin` are the wrong
 * question to ask of it. Measured on a real handshake against this host, the
 * request arrives as:
 *
 *     url    = /api/remote.mux
 *     host   = "127.0.0.1:65485"
 *     origin = "http://evil.com"     <- the attacker's Origin arrives intact
 *     sfs    = undefined             <- and Sec-Fetch-Site is simply absent
 *
 * `checkOrigin` only consults `Sec-Fetch-Site` on a read, so that request came
 * back `{ ok: true }`. Every row of the decision table therefore gets its own case
 * here, with the "Origin present, different origin, no Sec-Fetch-Site" row — the
 * CSWSH shape — called out explicitly.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkOrigin, checkUpgradeOrigin } from '../src/host/gateway/origin.js'

/**
 * An upgrade-request-shaped object carrying only the headers the fence reads.
 *
 * @param {Record<string, string>} [headers]
 */
function upgrade(headers = {}) {
  return { method: 'GET', headers }
}

/* ------------------------------------------------------------------ *
 * The CSWSH row: an Origin that does not match, with no Sec-Fetch-Site
 * ------------------------------------------------------------------ */

test('an upgrade with a foreign Origin and NO Sec-Fetch-Site is refused', () => {
  /* The measured shape. This is the whole reason `checkUpgradeOrigin` exists: the
     browser always sends Origin on a WebSocket handshake and is not obliged to
     send Sec-Fetch-Site, and there is no CORS preflight to fail first. */
  const verdict = checkUpgradeOrigin(upgrade({ host: '127.0.0.1:65485', origin: 'http://evil.com' }))
  assert.equal(verdict.ok, false, 'a live foreign Origin must be refused on an upgrade')
  assert.equal(verdict.reason, 'cross-origin')
})

test('checkOrigin alone would have admitted that exact request', () => {
  /* Pinned as documentation: the read arms return true for this shape, which is
     why the upgrade path must not call them. If `checkOrigin` is ever tightened to
     also refuse it, this assertion fails and the comment above should be revisited
     — that is the point of asserting the current behaviour. */
  const request = upgrade({ host: '127.0.0.1:65485', origin: 'http://evil.com' })
  assert.equal(checkOrigin(request).ok, true, 'the HTTP read fence is deliberately lenient here')
  assert.equal(checkUpgradeOrigin(request).ok, false, 'the upgrade fence is not')
})

test('an upgrade with a foreign Origin and same-origin Sec-Fetch-Site is still refused', () => {
  /* `Sec-Fetch-Site` cannot rescue a mismatched Origin on this path: the Origin
     arm is absolute. A non-browser client can set both headers freely, so a
     matching statement about "site" is not evidence about "origin". */
  const verdict = checkUpgradeOrigin(upgrade({
    host: '127.0.0.1:65485',
    origin: 'http://evil.com',
    'sec-fetch-site': 'same-origin',
  }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-origin')
})

test('an upgrade to a different PORT of the same host is refused', () => {
  /* A LAN deployment is reached by `ip:port`, so the port is part of the origin a
     browser will report. A page served from another port on the same machine is a
     different origin and must not open the socket. */
  const verdict = checkUpgradeOrigin(upgrade({ host: '192.168.1.7:3090', origin: 'http://192.168.1.7:8080' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-origin')
})

/* ------------------------------------------------------------------ *
 * Cross-site is refused unconditionally
 * ------------------------------------------------------------------ */

test('Sec-Fetch-Site: cross-site is refused on an upgrade even with no Origin', () => {
  const verdict = checkUpgradeOrigin(upgrade({ host: '127.0.0.1:65485', 'sec-fetch-site': 'cross-site' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-site')
})

test('Sec-Fetch-Site: cross-site beats a matching Origin', () => {
  /* The browser sets Sec-Fetch-Site itself and a page cannot forge it, so it is
     believed over an Origin, which a script can set freely. */
  const verdict = checkUpgradeOrigin(upgrade({
    host: '127.0.0.1:65485',
    origin: 'http://127.0.0.1:65485',
    'sec-fetch-site': 'cross-site',
  }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-site')
})

test('the cross-site comparison is case-insensitive on an upgrade too', () => {
  assert.equal(checkUpgradeOrigin(upgrade({ host: 'lan:3090', 'sec-fetch-site': 'CROSS-SITE' })).ok, false)
})

/* ------------------------------------------------------------------ *
 * The allowed rows
 * ------------------------------------------------------------------ */

test('a same-origin upgrade passes', () => {
  /* What the paired phone's browser sends when its page is the gateway's own
     origin: the whole point of the path. */
  const verdict = checkUpgradeOrigin(upgrade({ host: '192.168.1.7:3090', origin: 'http://192.168.1.7:3090' }))
  assert.equal(verdict.ok, true)
})

test('a same-origin upgrade passes despite hostname case and a default port', () => {
  assert.equal(checkUpgradeOrigin(upgrade({ host: 'Lan.Local:3090', origin: 'http://lan.local:3090' })).ok, true)
  assert.equal(checkUpgradeOrigin(upgrade({ host: 'lan.local:80', origin: 'http://lan.local' })).ok, true)
})

test('an upgrade with no Origin at all passes', () => {
  /* A browser cannot produce this handshake: RFC 6455 §4.1 requires the
     WebSocket constructor to send `Origin`. So a missing one means a CLI client,
     a script or a test — none of which carries a page's cookies by itself. */
  assert.equal(checkUpgradeOrigin(upgrade({ host: '192.168.1.7:3090' })).ok, true)
  assert.equal(checkUpgradeOrigin(upgrade({})).ok, true)
})

test('an upgrade with no Origin but a same-site Sec-Fetch-Site passes', () => {
  /* Allowed for the same reason as the row above: the Origin's absence already
     identifies a non-browser client, and a same-site statement is not a reason to
     refuse one. */
  for (const site of ['same-origin', 'same-site']) {
    assert.equal(
      checkUpgradeOrigin(upgrade({ host: '192.168.1.7:3090', 'sec-fetch-site': site })).ok,
      true,
      site,
    )
  }
})

test('an upgrade with no Origin and Sec-Fetch-Site: none passes', () => {
  /* `none` means a user-initiated navigation, which cannot open a WebSocket; the
     header is irrelevant here and must not be treated as a refusal reason. The
     no-Origin arm rests on the RFC guarantee, not on this header. */
  assert.equal(checkUpgradeOrigin(upgrade({ host: 'lan:3090', 'sec-fetch-site': 'none' })).ok, true)
})

/* ------------------------------------------------------------------ *
 * An origin that cannot be compared is refused
 * ------------------------------------------------------------------ */

test('a malformed Origin on an upgrade is refused instead of throwing', () => {
  /* `null` is what a sandboxed iframe sends. It cannot be compared to a Host, so
     it cannot prove a match. */
  for (const origin of ['null', 'not a url', '', 'http://']) {
    const verdict = checkUpgradeOrigin(upgrade({ host: 'lan:3090', origin }))
    assert.equal(verdict.ok, false, `Origin ${JSON.stringify(origin)} must not pass`)
  }
})

test('an unparsable Host with an Origin present on an upgrade is refused', () => {
  const verdict = checkUpgradeOrigin(upgrade({ origin: 'http://lan:3090' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'bad-host')
})

/* ------------------------------------------------------------------ *
 * Robustness
 * ------------------------------------------------------------------ */

test('a repeated Origin collapses to its first value on an upgrade', () => {
  const verdict = checkUpgradeOrigin({
    method: 'GET',
    headers: { host: 'lan:3090', origin: ['http://lan:3090', 'http://evil.example'] },
  })
  assert.equal(verdict.ok, true, 'the first (matching) value is the one considered')
})

test('a request with no headers object at all does not throw', () => {
  assert.doesNotThrow(() => checkUpgradeOrigin({ method: 'GET' }))
  assert.equal(checkUpgradeOrigin(undefined).ok, true, 'no headers means no Origin, which is allowed')
})
