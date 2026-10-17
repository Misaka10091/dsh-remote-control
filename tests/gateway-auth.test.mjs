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
import {
  TEST_JWT_KEY,
  cleanupDir,
  deviceJwt,
  makeStore,
  makeTempDir,
  pairDevice,
} from './helpers.mjs'

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

/** A device table in a temp dir, with one paired device. Returns its JWT too. */
function withDevice(fn) {
  const dir = makeTempDir()
  const { store, clock } = makeStore(dir)
  const { token } = pairDevice(store, { id: 'dev_1', name: 'iPhone · Safari', ua: 'UA/1' })
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

/**
 * `authorize` with the shared test key and no revocations.
 *
 * Every call site in this suite goes through here rather than through the raw
 * function, so a suite that forgot the key could not silently "pass" by having
 * every token fail verification for the wrong reason.
 *
 * The key is defaulted with `in` on the argument object rather than by a parameter
 * default, so a test can deliberately pass `key: undefined` and get a refusal
 * instead of the shared key.
 */
function decide(input) {
  const key = 'key' in input ? input.key : TEST_JWT_KEY
  return authorize({
    req: input.req,
    store: input.store,
    cookieName: DEVICE_COOKIE_NAME,
    key,
    isRevoked: input.isRevoked,
    upgrade: input.upgrade === true,
  })
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
    const verdict = decide({ req: request({ remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3090' } }),
      store,
    })
    assert.equal(verdict.decision, DECISION.ALLOW)
    assert.equal(verdict.device, null, 'the loopback exemption carries no device')
    assert.equal(verdict.loopback, true)
  })
})

test('a loopback request is allowed even with a garbage cookie', () => {
  withDevice(({ store }) => {
    const verdict = decide({ req: request({
        remoteAddress: '127.0.0.1',
        headers: { host: '127.0.0.1:3090', cookie: `${DEVICE_COOKIE_NAME}=nonsense` },
      }),
      store,
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
    const verdict = decide({ req: request({ remoteAddress: '127.0.0.1', headers: { host: 'rebind.evil.example:3090' } }),
      store,
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
    const verdict = decide({ req: request({
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
    const verdict = decide({ req: request({
        method: 'POST',
        remoteAddress: '127.0.0.1',
        headers: {
          host: '127.0.0.1:3090',
          origin: 'https://evil.example',
          'content-type': 'application/x-www-form-urlencoded',
        },
      }),
      store,
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
    const unmarked = decide({ req: request({
        method: 'POST',
        remoteAddress: '127.0.0.1',
        headers: { host: '127.0.0.1:3090' },
      }),
      store,
    })
    assert.equal(unmarked.decision, DECISION.FORBIDDEN)
    assert.equal(unmarked.reason, 'no-origin')

    for (const headers of [
      { host: '127.0.0.1:3090', 'sec-fetch-site': 'same-origin' },
      { host: '127.0.0.1:3090', origin: 'http://127.0.0.1:3090' },
    ]) {
      const allowed = decide({ req: request({ method: 'POST', remoteAddress: '127.0.0.1', headers }),
        store,
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
      const verdict = decide({ req: request({ remoteAddress: '127.0.0.1', headers }),
        store,
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
    const verdict = decide({ req: request({ remoteAddress: '192.168.1.7', headers: { host: '127.0.0.1:3090' } }),
      store,
    })
    assert.equal(verdict.decision, DECISION.UNAUTHENTICATED)
  })
})

/* ------------------------------------------------------------------ *
 * Step 2: no cookie → 401
 * ------------------------------------------------------------------ */

test('a remote request with no cookie is 401', () => {
  withDevice(({ store }) => {
    const verdict = decide({ req: request({ headers: { host: '192.168.1.7:3090' } }), store })
    assert.equal(verdict.decision, DECISION.UNAUTHENTICATED)
    assert.equal(verdict.reason, 'no-cookie')
    assert.equal(statusFor(verdict.decision), 401)
    assert.equal(codeFor(verdict.decision, verdict.reason), 'gateway/unauthenticated')
  })
})

test('a remote request with an unknown cookie is 401', () => {
  withDevice(({ store }) => {
    const verdict = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie('not-a-real-token') } }),
      store,
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
    const verdict = decide({ req: request({
        method: 'POST',
        headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token), origin: 'https://evil.example' },
      }),
      store,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN)
    assert.equal(verdict.reason, 'cross-origin')
    assert.equal(statusFor(verdict.decision), 403)
    assert.equal(codeFor(verdict.decision, verdict.reason), 'gateway/cross-origin')
  })
})

test('a cross-site write with a valid cookie is 403', () => {
  withDevice(({ store, token }) => {
    const verdict = decide({ req: request({
        method: 'POST',
        headers: {
          host: '192.168.1.7:3090',
          cookie: deviceCookie(token),
          'sec-fetch-site': 'cross-site',
        },
      }),
      store,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN)
    assert.equal(verdict.reason, 'cross-site')
  })
})

test('a write with no Origin and no Sec-Fetch-Site is 403 even with a valid cookie', () => {
  withDevice(({ store, token }) => {
    const verdict = decide({ req: request({
        method: 'POST',
        headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) },
      }),
      store,
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
    const verdict = decide({ req: request({
        method: 'POST',
        headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token), origin: 'https://evil.example' },
      }),
      store,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN)
  })
})

/* ------------------------------------------------------------------ *
 * Step 4: valid cookie → allow; revoked → 401
 * ------------------------------------------------------------------ */

test('a valid device cookie on a same-origin write passes', () => {
  withDevice(({ store, token }) => {
    const verdict = decide({ req: request({
        method: 'POST',
        headers: {
          host: '192.168.1.7:3090',
          cookie: deviceCookie(token),
          origin: 'http://192.168.1.7:3090',
        },
      }),
      store,
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
    const verdict = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
    })
    assert.equal(verdict.decision, DECISION.ALLOW)
  })
})

test('a revoked device is 401, not 403, and the reason is identifiable', () => {
  withDevice(({ store, token }) => {
    store.revokeDevice('dev_1')
    const verdict = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
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
    const verdict = decide({ req: request({ method: 'DELETE', headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
    })
    assert.equal(verdict.decision, DECISION.FORBIDDEN)
  })
})

test('revocation takes effect on the very next request', () => {
  /* `prd.md` constraint 5: 吊销必须即时生效. There is no cache in this path — the
     table is read per request — so this is really an assertion that no cache was
     introduced. */
  withDevice(({ store, token }) => {
    const before = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
    })
    assert.equal(before.decision, DECISION.ALLOW)

    store.revokeDevice('dev_1')

    const after = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
    })
    assert.equal(after.decision, DECISION.REVOKED)
  })
})

test('one device token does not authenticate a different device', () => {
  withDevice(({ store, token }) => {
    /* The second device gets its OWN signed token. What is being asserted is that a
       token's authority is its `sub`, so presenting device A's credential never
       resolves to device B — the whole point of a claim-backed credential. */
    const other = pairDevice(store, { id: 'dev_2', name: 'tablet' })

    const both = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(other.token) } }), store })
    assert.equal(both.decision, DECISION.ALLOW)
    assert.equal(both.device.id, 'dev_2', 'each token names its own device')

    store.revokeDevice('dev_2')
    const verdict = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }), store })
    assert.equal(verdict.decision, DECISION.ALLOW, 'the first device is unaffected by a sibling revocation')

    /* A token whose signature was mangled is not a credential for anybody. */
    const wrong = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(`${other.token}x`) } }), store })
    assert.equal(wrong.decision, DECISION.UNAUTHENTICATED)
  })
})

/* ------------------------------------------------------------------ *
 * The credential is a JWT: verification, revocation, and the name source
 * ------------------------------------------------------------------ */

test('a token signed by a different key is 401', () => {
  /* The signature is what makes the cookie a credential. A well-formed JWT with a
     plausible `sub` — which is what an attacker can write — must not authenticate. */
  withDevice(({ store }) => {
    const forged = deviceJwt('dev_1', { key: Buffer.alloc(32, 0x11) })
    const verdict = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(forged) } }), store })
    assert.equal(verdict.decision, DECISION.UNAUTHENTICATED)
    assert.equal(verdict.reason, 'unknown-token')
  })
})

test('an expired token is 401 even with a perfect signature', () => {
  withDevice(({ store }) => {
    const stale = deviceJwt('dev_1', { exp: Math.floor(Date.now() / 1000) - 3600 })
    const verdict = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(stale) } }), store })
    assert.equal(verdict.decision, DECISION.UNAUTHENTICATED)
  })
})

test('a token for a device that does not exist is 401, not a 500', () => {
  /* The signature is good, so verification succeeds — and then the `sub` names no
     row. This is the case an operator creates by deleting a row from devices.json
     by hand, and it must stop working on the very next request rather than being
     turned into a phantom device. */
  withDevice(({ store }) => {
    const orphan = deviceJwt('dev_deleted')
    const verdict = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(orphan) } }), store })
    assert.equal(verdict.decision, DECISION.UNAUTHENTICATED)
    assert.equal(verdict.reason, 'unknown-device')
    assert.equal(statusFor(verdict.decision), 401)
  })
})

test('a revoked `sub` is 401 on the very next request with the SAME still-valid JWT', () => {
  /* `prd.md` constraint 5, and the entire reason the design is "JWT + a server-side
     revocation table" rather than a pure stateless token: the JWT here is NOT
     edited and NOT expired — its signature still verifies — and only the
     in-memory set says no. A stateless design could not pass this test. */
  withDevice(({ store, token }) => {
    const revoked = new Set()

    const before = decide({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      isRevoked: (id) => revoked.has(id),
    })
    assert.equal(before.decision, DECISION.ALLOW)

    /* What `gateway.revokeDevice` does: write the store AND the set. */
    store.revokeDevice('dev_1')
    revoked.add('dev_1')

    const after = decide({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      isRevoked: (id) => revoked.has(id),
    })
    assert.equal(after.decision, DECISION.REVOKED)
    assert.equal(after.device, null, 'a revoked device is never handed to the caller')
    assert.equal(codeFor(after.decision, after.reason), 'gateway/device-revoked')
  })
})

test('the revocation set alone is enough, without the store being written', () => {
  /* The Set is consulted before the row, so a revoke whose store write failed
     still refuses the credential. Half a revocation must never mean "still works":
     the store write is the durable half and the Set is the immediate half, and the
     immediate half is the one a live request hits. */
  withDevice(({ store, token }) => {
    const verdict = decide({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      isRevoked: () => true,
    })
    assert.equal(verdict.decision, DECISION.REVOKED)
  })
})

test('a revoked device whose row was deleted still gets 401 with the cookie cleared', () => {
  /* The Set is checked before the row, so "revoked" survives a hand-deleted record.
     Answering "unknown" instead would drop the cookie deletion — the signal that
     tells the user their device was revoked rather than never paired. */
  withDevice(({ store, token }) => {
    const verdict = decide({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      isRevoked: (id) => id === 'dev_1',
    })
    assert.equal(verdict.decision, DECISION.REVOKED)
  })
})

test('the device name comes from the STORE, never from the token', () => {
  /* A JWT is a snapshot: it carries whatever the name was at pairing time. If the
     gateway trusted `claims.name`, a device the user renamed in the panel would keep
     announcing its old label in the audit trail and the log until it re-paired.
     `design.md` §3.2 / the research note both require the store as the source. */
  withDevice(({ store }) => {
    const renamedInPanel = store.renameDevice('dev_1', '客厅 iPad')
    assert.equal(renamedInPanel.name, '客厅 iPad')

    /* A token whose `name` claim is stale — and wrong — but is otherwise valid. */
    const staleClaim = deviceJwt('dev_1', { name: 'iPhone · Safari' })
    const verdict = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(staleClaim) } }), store })

    assert.equal(verdict.decision, DECISION.ALLOW)
    assert.equal(verdict.device.name, '客厅 iPad', 'the store wins over the claim')
    assert.notEqual(verdict.device.name, 'iPhone · Safari', 'the stale claim must not be displayed')
  })
})

test('a credential in the OLD cookie name is refused', () => {
  /* `research/jwt-device-credential.md` §3.5 offers a transition window; this build
     deliberately does not take it. A second accepted cookie name would be a second
     code path through the one authorization decision, and the old name carries a
     value (`sha256` digest verifier) this verifier cannot check anyway. Old devices
     must re-pair — documented in the README. */
  withDevice(({ store, token }) => {
    const oldName = decide({ req: request({ headers: { host: '192.168.1.7:3090', cookie: `dsh-rc-device=${token}` } }), store })
    assert.equal(oldName.decision, DECISION.UNAUTHENTICATED)
    assert.equal(oldName.reason, 'no-cookie')
  })
})

test('no token at all, an empty token and a garbage token are all one 401', () => {
  /* One reason for every credential failure: telling a caller which check it failed
     would confirm whether a device id exists and which half of a guess was right. */
  withDevice(({ store }) => {
    for (const cookie of [undefined, `${DEVICE_COOKIE_NAME}=`, `${DEVICE_COOKIE_NAME}=%20`, `${DEVICE_COOKIE_NAME}=a.b.c`]) {
      const verdict = decide({
        req: request({ headers: { host: '192.168.1.7:3090', ...(cookie === undefined ? {} : { cookie }) } }),
        store,
      })
      assert.equal(verdict.decision, DECISION.UNAUTHENTICATED, String(cookie))
      assert.equal(codeFor(verdict.decision, verdict.reason), 'gateway/unauthenticated', String(cookie))
    }
  })
})

test('a request with no key configured cannot authenticate anybody', () => {
  /* Fail closed. A gateway that lost its signing key must refuse every remote
     request, not skip verification — the `undefined` key makes `verifyDeviceToken`
     answer undefined, which is the 401 arm. */
  withDevice(({ store, token }) => {
    const verdict = decide({
      req: request({ headers: { host: '192.168.1.7:3090', cookie: deviceCookie(token) } }),
      store,
      key: undefined,
    })
    assert.equal(verdict.decision, DECISION.UNAUTHENTICATED)
  })
})

test('the loopback exemption still needs no credential at all, JWT or otherwise', () => {
  /* The JWT switch must not have made local access depend on a cookie. */
  withDevice(({ store }) => {
    const verdict = decide({ req: request({ remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3090' } }), store })
    assert.equal(verdict.decision, DECISION.ALLOW)
    assert.equal(verdict.device, null)
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
