/**
 * The single authorization decision (`design.md` §3.2).
 *
 * These tests drive the four arms of the decision directly, with a real device
 * table in a temp directory and a request stub, so no socket is involved. That is
 * deliberate: the decision is where the security lives, and a test that needs an
 * HTTP server to exercise it would be a test nobody writes the fifth case for.
 *
 * The ordering assertions matter as much as the outcomes. `design.md` §3.2 fixes
 * loopback → cookie → origin → revocation, and two of those orders are
 * security-relevant:
 *
 *   - origin before revocation, so a forged write is refused as a forgery rather
 *     than reported as an auth failure;
 *   - revocation last, so a client with a valid-but-revoked cookie is told to
 *     clear it rather than being lumped in with an unpaired stranger.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEVICE_COOKIE_NAME } from '../src/host/constants.js'
import { createDeviceToken } from '../src/host/tokens.js'
import {
  DECISION,
  authorize,
  codeFor,
  isLoopback,
  isLoopbackHostname,
  isLoopbackSocket,
  peerAddress,
  readCookie,
  statusFor,
} from '../src/host/gateway/auth.js'
import { cleanupDir, makeStore, makeTempDir } from './helpers.mjs'

/**
 * Build a request stub.
 *
 * @param {object} spec
 * @param {string} [spec.method] HTTP method.
 * @param {Record<string, string>} [spec.headers] Request headers.
 * @param {string} [spec.remoteAddress] Socket peer address.
 */
function request({ method = 'GET', headers = {}, remoteAddress = '192.168.1.7' } = {}) {
  return { method, headers, socket: { remoteAddress } }
}

/** A device table in a temp dir, with one paired device. Returns its clear token too. */
function withDevice(fn) {
  const dir = makeTempDir()
  const { store, clock } = makeStore(dir)
  const { token, tokenHash } = createDeviceToken()
  store.addDevice({ id: 'dev_1', name: 'iPhone · Safari', tokenHash, ua: 'UA/1' })
  try {
    return fn({ store, clock, token, dir })
  } finally {
    cleanupDir(dir)
  }
}

/** The `Cookie` header a paired device would send. */
function deviceCookie(token) {
  return `${DEVICE_COOKIE_NAME}=${token}`
}

/* ------------------------------------------------------------------ *
 * Loopback detection requires BOTH halves
 * ------------------------------------------------------------------ */

test('isLoopbackHostname recognizes localhost, IPv6 loopback and 127/8', () => {
  for (const host of ['localhost', '[::1]', '::1', '127.0.0.1', '127.1.2.3', '127.255.255.254']) {
    assert.equal(isLoopbackHostname(host), true, host)
  }
  for (const host of ['192.168.1.7', '0.0.0.0', '10.0.0.1', '128.0.0.1', 'localhost.evil.example', '127.0.0.256', '']) {
    assert.equal(isLoopbackHostname(host), false, host)
  }
  /* A zone index is not loopback, and must not be waved through a `::1` prefix test. */
  for (const host of ['::1%eth0', '::1.evil.example', 'fe80::1', '::2']) {
    assert.equal(isLoopbackHostname(host), false, host)
  }
  assert.equal(isLoopbackHostname(undefined), false)
})

test('a bare ::1 socket peer counts as loopback', () => {
  /* `socket.remoteAddress` is `::1` (no brackets) for a request over IPv6
     loopback; the bracketed form is what a WHATWG Host carries. Handling only the
     bracketed spelling meant a local request on such a listener was asked for a
     cookie — the "本机回环访问不需要配对" guarantee failing on a common config. */
  assert.equal(isLoopbackSocket({ socket: { remoteAddress: '::1' } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:3090' } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' }, headers: { host: '192.168.1.7:3090' } }), false)
})

test('peerAddress unwraps IPv4-mapped IPv6 so one address has one spelling', () => {
  /* A dual-stack `0.0.0.0` listener on Windows reports `::ffff:192.168.1.7`. Left
     wrapped, the loopback test would fail for a genuinely local request. */
  assert.equal(peerAddress({ remoteAddress: '::ffff:127.0.0.1' }), '127.0.0.1')
  assert.equal(peerAddress({ remoteAddress: '::ffff:192.168.1.7' }), '192.168.1.7')
  assert.equal(peerAddress({ remoteAddress: '127.0.0.1' }), '127.0.0.1')
  assert.equal(peerAddress({ remoteAddress: '::1' }), '::1')
  assert.equal(peerAddress({}), undefined)
  assert.equal(peerAddress(undefined), undefined)
})

test('isLoopbackSocket looks only at the socket', () => {
  assert.equal(isLoopbackSocket(request({ remoteAddress: '127.0.0.1' })), true)
  assert.equal(isLoopbackSocket(request({ remoteAddress: '::ffff:127.0.0.1' })), true)
  assert.equal(isLoopbackSocket(request({ remoteAddress: '192.168.1.7' })), false)
})

test('isLoopback requires a loopback socket AND a loopback Host', () => {
  /* Both halves, because either alone is forgeable in the direction that matters:
     a rebound DNS name reaches a loopback socket with an attacker Host, and a
     remote client can send a loopback Host over a remote socket. */
  assert.equal(isLoopback(request({ remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3090' } })), true)
  assert.equal(isLoopback(request({ remoteAddress: '127.0.0.1', headers: { host: 'localhost:3090' } })), true)

  /* Loopback socket, attacker Host: DNS rebinding. */
  assert.equal(
    isLoopback(request({ remoteAddress: '127.0.0.1', headers: { host: 'evil.example:3090' } })),
    false,
    'a loopback socket alone must not earn the exemption',
  )

  /* Loopback Host, remote socket: a client rewriting its Host header. */
  assert.equal(
    isLoopback(request({ remoteAddress: '192.168.1.7', headers: { host: '127.0.0.1:3090' } })),
    false,
    'a loopback Host alone must not earn the exemption',
  )

  /* Neither a missing Host nor an unparsable one may earn it. */
  assert.equal(isLoopback(request({ remoteAddress: '127.0.0.1', headers: {} })), false)
  assert.equal(isLoopback(request({ remoteAddress: '127.0.0.1', headers: { host: 'not a host' } })), false)
})

/* ------------------------------------------------------------------ *
 * Step 1: loopback is allowed without a cookie
 * ------------------------------------------------------------------ */

test('a loopback request is allowed with no cookie at all', () => {
  /* `prd.md`: 本机回环访问全程不需要配对. */
  withDevice(({ store }) => {
    const verdict = authorize({
      req: request({ remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3090' } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.ALLOW)
    assert.equal(verdict.device, null, 'the loopback exemption carries no device')
    assert.equal(verdict.loopback, true)
  })
})

test('a loopback request is allowed even with a garbage cookie', () => {
  withDevice(({ store }) => {
    const verdict = authorize({
      req: request({
        remoteAddress: '127.0.0.1',
        headers: { host: '127.0.0.1:3090', cookie: `${DEVICE_COOKIE_NAME}=nonsense` },
      }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.ALLOW)
  })
})

test('a loopback socket with a NON-loopback Host is treated as remote (DNS rebinding)', () => {
  /* The decision itself must use both halves, not just the socket. This is the
     case that proves it: a public page resolving a name to 127.0.0.1 reaches a
     loopback socket with the attacker's Host, and if `authorize` consulted only
     `isLoopbackSocket` it would hand that request the local exemption and skip
     authentication entirely. */
  withDevice(({ store }) => {
    const verdict = authorize({
      req: request({ remoteAddress: '127.0.0.1', headers: { host: 'rebind.evil.example:3090' } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.UNAUTHENTICATED)
    assert.equal(verdict.loopback, false)
  })
})

/* ------------------------------------------------------------------ *
 * The loopback exemption does NOT waive the origin fence
 *
 * Measured on the stage-2 build before this was fixed: a page on
 * `https://evil.example` issuing a no-preflight `POST` to
 * `http://127.0.0.1:<gatewayPort>/api/…` got a **200 that executed against DSH**.
 * The browser sets `Host` from the URL, so it is loopback for such a request and
 * the exemption fired and returned before the fence; the gateway then did what it
 * is built to do — stripped `Origin`/`Sec-Fetch-*` and attached the instance-wide
 * `dsh-auth-*` credential — converting a request the official fence refuses into
 * an authenticated write. `SameSite=Lax` is no defence because the exemption
 * means no cookie is required.
 *
 * The exemption must keep waiving the CREDENTIAL (that is `prd.md` R3) and must
 * never waive the origin proof.
 * ------------------------------------------------------------------ */

test('a cross-site write over a loopback socket is refused, not laundered', () => {
  withDevice(({ store }) => {
    const verdict = authorize({
      req: request({
        method: 'POST',
        remoteAddress: '127.0.0.1',
        headers: {
          host: '127.0.0.1:3090',
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
          'content-type': 'text/plain',
        },
      }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN, 'a cross-site write must never be laundered by the exemption')
    assert.equal(verdict.reason, 'cross-site')
    assert.equal(verdict.loopback, true, 'it is still recognised as a local request; it is just not allowed to write')
    assert.equal(statusFor(verdict.decision), 403)
  })
})

test('a cross-site form POST without Sec-Fetch-Site is refused over a loopback socket', () => {
  /* The shape an older browser sends for a cross-site form post: an Origin, no
     Sec-Fetch-Site, and a content type no preflight is required for. */
  withDevice(({ store }) => {
    const verdict = authorize({
      req: request({
        method: 'POST',
        remoteAddress: '127.0.0.1',
        headers: {
          host: '127.0.0.1:3090',
          origin: 'https://evil.example',
          'content-type': 'application/x-www-form-urlencoded',
        },
      }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN)
    assert.equal(verdict.reason, 'cross-origin')
  })
})

test('an unmarked local write is refused, but a local browser write still passes', () => {
  /* The two sides of the trade. A local write that proves nothing is refused (the
     CSRF shape); a local write a real browser makes carries `Sec-Fetch-Site:
     same-origin` or a matching `Origin`, and both pass. */
  withDevice(({ store }) => {
    const unmarked = authorize({
      req: request({
        method: 'POST',
        remoteAddress: '127.0.0.1',
        headers: { host: '127.0.0.1:3090' },
      }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(unmarked.decision, DECISION.FORBIDDEN)
    assert.equal(unmarked.reason, 'no-origin')

    for (const headers of [
      { host: '127.0.0.1:3090', 'sec-fetch-site': 'same-origin' },
      { host: '127.0.0.1:3090', origin: 'http://127.0.0.1:3090' },
    ]) {
      const allowed = authorize({
        req: request({ method: 'POST', remoteAddress: '127.0.0.1', headers }),
        store,
        cookieName: DEVICE_COOKIE_NAME,
      })
      assert.equal(allowed.decision, DECISION.ALLOW, `${JSON.stringify(headers)} must still work locally`)
      assert.equal(allowed.device, null, 'and it still needs no device')
    }
  })
})

test('a local READ is never asked for an origin, even a cross-site one', () => {
  /* `prd.md` acceptance "本机回环访问全程不需要配对" and the local-tool guarantee are
     about reads as much as anything: opening the URL in a local browser, or a
     local script fetching it, must keep working with no headers at all. */
  withDevice(({ store }) => {
    for (const headers of [
      { host: '127.0.0.1:3090' },
      { host: 'localhost:3090' },
      { host: '127.0.0.1:3090', origin: 'http://127.0.0.1:3090' },
    ]) {
      const verdict = authorize({
        req: request({ remoteAddress: '127.0.0.1', headers }),
        store,
        cookieName: DEVICE_COOKIE_NAME,
      })
      assert.equal(verdict.decision, DECISION.ALLOW, `${JSON.stringify(headers)} must be allowed`)
      assert.equal(verdict.device, null)
    }
  })
})

test('a remote socket with a loopback Host is treated as remote', () => {
  /* The mirror case: a device rewriting its Host header must not earn the
     exemption either. */
  withDevice(({ store }) => {
    const verdict = authorize({
      req: request({ remoteAddress: '192.168.1.7', headers: { host: '127.0.0.1:3090' } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.UNAUTHENTICATED)
  })
})

/* ------------------------------------------------------------------ *
 * Step 2: no cookie → 401
 * ------------------------------------------------------------------ */

test('a remote request with no cookie is 401', () => {
  withDevice(({ store }) => {
    const verdict = authorize({
      req: request({ headers: { host: '192.168.1.7:3090' } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.UNAUTHENTICATED)
    assert.equal(verdict.reason, 'no-cookie')
    assert.equal(statusFor(verdict.decision), 401)
    assert.equal(codeFor(verdict.decision, verdict.reason), 'gateway/unauthenticated')
  })
})

test('a remote request with an unknown cookie is 401', () => {
  withDevice(({ store }) => {
    const verdict = authorize({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie('not-a-real-token') } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.UNAUTHENTICATED)
    assert.equal(verdict.reason, 'unknown-token')
  })
})

/* ------------------------------------------------------------------ *
 * Step 3: forged Origin → 403
 * ------------------------------------------------------------------ */

test('a forged Origin is 403 even with a perfectly valid cookie', () => {
  /* The whole point: holding a real credential must not let a foreign page drive
     the gateway on the device's behalf. */
  withDevice(({ store, token }) => {
    const verdict = authorize({
      req: request({
        method: 'POST',
        headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token), origin: 'https://evil.example' },
      }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN)
    assert.equal(verdict.reason, 'cross-origin')
    assert.equal(statusFor(verdict.decision), 403)
    assert.equal(codeFor(verdict.decision, verdict.reason), 'gateway/cross-origin')
  })
})

test('a cross-site write with a valid cookie is 403', () => {
  withDevice(({ store, token }) => {
    const verdict = authorize({
      req: request({
        method: 'POST',
        headers: {
          host: '192.168.1.7:3090',
          cookie: deviceCookie(token),
          'sec-fetch-site': 'cross-site',
        },
      }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN)
    assert.equal(verdict.reason, 'cross-site')
  })
})

test('a write with no Origin and no Sec-Fetch-Site is 403 even with a valid cookie', () => {
  withDevice(({ store, token }) => {
    const verdict = authorize({
      req: request({
        method: 'POST',
        headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) },
      }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN)
    assert.equal(verdict.reason, 'no-origin')
    assert.equal(statusFor(verdict.decision), 403)
  })
})

test('the origin fence runs BEFORE the revocation check', () => {
  /* Order assertion. A forged cross-site write from a revoked device must be
     reported as a forgery (403), not as a revocation (401): an operator reading
     the logs needs to know that something is forging requests, and "revoked" would
     send them to the device panel instead of the network. */
  withDevice(({ store, token }) => {
    store.revokeDevice('dev_1')
    const verdict = authorize({
      req: request({
        method: 'POST',
        headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token), origin: 'https://evil.example' },
      }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN)
  })
})

/* ------------------------------------------------------------------ *
 * Step 4: valid cookie → allow; revoked → 401
 * ------------------------------------------------------------------ */

test('a valid device cookie on a same-origin write passes', () => {
  withDevice(({ store, token }) => {
    const verdict = authorize({
      req: request({
        method: 'POST',
        headers: {
          host: '192.168.1.7:3090',
          cookie: deviceCookie(token),
          origin: 'http://192.168.1.7:3090',
        },
      }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.ALLOW)
    assert.equal(verdict.device.id, 'dev_1')
    assert.equal(verdict.device.name, 'iPhone · Safari')
    assert.equal(verdict.loopback, false)
  })
})

test('a valid cookie on a plain read passes with no Origin at all', () => {
  /* The stage-2 `curl` acceptance step: `curl -H 'Cookie: …' http://lan:3090/`. */
  withDevice(({ store, token }) => {
    const verdict = authorize({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.ALLOW)
  })
})

test('a revoked device is 401, not 403, and the reason is identifiable', () => {
  withDevice(({ store, token }) => {
    store.revokeDevice('dev_1')
    const verdict = authorize({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.REVOKED)
    assert.equal(verdict.reason, 'revoked')
    assert.equal(statusFor(verdict.decision), 401)
    assert.equal(codeFor(verdict.decision, 'revoked'), 'gateway/device-revoked')
    assert.equal(verdict.device, null, 'a revoked device is never handed to the caller')
  })
})

test('a revoked device on a write with no Origin is forbidden, not revoked', () => {
  /* Order again, from the other side: the origin check precedes revocation, so
     this is 403. Pinned because it is the arm most likely to be "simplified"
     into the wrong order later. */
  withDevice(({ store, token }) => {
    store.revokeDevice('dev_1')
    const verdict = authorize({
      req: request({ method: 'DELETE', headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN)
  })
})

test('revocation takes effect on the very next request', () => {
  /* `prd.md` constraint 5: 吊销必须即时生效. There is no cache in this path — the
     table is read per request — so this is really an assertion that no cache was
     introduced. */
  withDevice(({ store, token }) => {
    const before = authorize({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(before.decision, DECISION.ALLOW)

    store.revokeDevice('dev_1')

    const after = authorize({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(after.decision, DECISION.REVOKED)
  })
})

test('one device token does not authenticate a different device', () => {
  withDevice(({ store, token }) => {
    const other = createDeviceToken()
    store.addDevice({ id: 'dev_2', name: 'tablet', tokenHash: other.tokenHash })

    store.revokeDevice('dev_2')
    const verdict = authorize({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(verdict.decision, DECISION.ALLOW, 'the first device is unaffected by a sibling revocation')

    const wrong = authorize({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(`${other.token}x`) } }),
      store,
      cookieName: DEVICE_COOKIE_NAME,
    })
    assert.equal(wrong.decision, DECISION.UNAUTHENTICATED)
  })
})

/* ------------------------------------------------------------------ *
 * Cookie parsing
 * ------------------------------------------------------------------ */

test('readCookie finds the named cookie among others', () => {
  assert.equal(readCookie(`a=1; ${DEVICE_COOKIE_NAME}=abc; b=2`, DEVICE_COOKIE_NAME), 'abc')
  assert.equal(readCookie(`${DEVICE_COOKIE_NAME}=abc`, DEVICE_COOKIE_NAME), 'abc')
  assert.equal(readCookie(`=${DEVICE_COOKIE_NAME};x=1`, 'x'), '1')
  assert.equal(readCookie('a=1', DEVICE_COOKIE_NAME), undefined)
  assert.equal(readCookie(undefined, DEVICE_COOKIE_NAME), undefined)
  assert.equal(readCookie('', DEVICE_COOKIE_NAME), undefined)
  /* An empty value is not a credential. */
  assert.equal(readCookie(`${DEVICE_COOKIE_NAME}=; x=1`, DEVICE_COOKIE_NAME), undefined)
  /* A cookie whose name merely ends with ours must not match. */
  assert.equal(readCookie(`not-${DEVICE_COOKIE_NAME}=abc`, DEVICE_COOKIE_NAME), undefined)
})

test('a cookie value containing base64url punctuation is read intact', () => {
  const value = 'aB3-_xYz09-_.QW'
  assert.equal(readCookie(`${DEVICE_COOKIE_NAME}=${value}; Path=/`, DEVICE_COOKIE_NAME), value)
})

/* ------------------------------------------------------------------ *
 * Status mapping is total
 * ------------------------------------------------------------------ */

test('statusFor and codeFor answer for an unknown decision without throwing', () => {
  /* Deny closed: an unrecognised decision must not become a 200, and must not
     become a 500 that tells an attacker they got further than they should. */
  assert.equal(statusFor('nonsense'), 403)
  assert.equal(statusFor(undefined), 403)
  assert.equal(codeFor('nonsense', null), 'gateway/denied')
  assert.equal(codeFor(undefined, undefined), 'gateway/denied')
})
