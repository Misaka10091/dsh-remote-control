/**
 * dsh-remote-control — the gateway's single authorization decision.
 *
 * `.trellis/spec/backend/quality-guidelines.md` §8 requires the fixed order to
 * live in exactly one place, and this is it. No handler anywhere else may look at
 * a cookie, compare a token, or decide that a request is local; they call
 * {@link authorize} and act on the verdict. Splitting the decision across
 * handlers is how two of them end up disagreeing about a revoked device.
 *
 * The order is `design.md` §3.2's, and it is not arbitrary:
 *
 *   1. **Loopback source → allow, but only past the origin fence.** A request
 *      that BOTH arrived over a loopback socket AND names a loopback authority in
 *      `Host` came from this machine, and `prd.md` requires the local experience
 *      to be untouched: **no cookie is ever required here**. The fence still runs,
 *      for the reason spelled out under "Why loopback is not exempt from the
 *      origin fence" below — the exemption waives the credential, never the
 *      origin proof.
 *   2. **Device cookie → else 401.** The credential. Everything below exists for
 *      a request that has already proven it holds one.
 *   3. **Origin fence → else 403.** Checked only after the credential, so a
 *      cross-site request without a cookie learns nothing about which check it
 *      failed; and checked before the revocation lookup, because a forged
 *      cross-site write should be refused regardless of the device's state.
 *   4. **Not revoked → allow; revoked → 401 + clear the cookie.** Revocation is
 *      checked LAST so that a client holding a perfectly valid cookie is told
 *      exactly the truth: the credential is no longer accepted.
 *
 * ## Why loopback is not exempt from the origin fence
 *
 * The loopback exemption originally returned ALLOW before the fence ran. That is
 * a complete CSRF bypass, because the gateway is the one hop that *adds* the
 * instance-wide `dsh-auth-*` credential and *strips* `Origin`/`Sec-Fetch-*`
 * (`proxy.js`). The official fence denies a cross-site write; laundering it
 * through the gateway turns that denial into a 200 that executes against DSH.
 *
 * Measured on the stage-2 build: a page on `https://evil.example` issuing a
 * no-preflight `POST http://127.0.0.1:<gatewayPort>/api/…` — a plain-text form
 * post, which no CORS preflight stops — reached upstream as an authenticated
 * write with `Origin` and `Sec-Fetch-Site` removed. `Host` is set by the browser
 * from the URL, so it *is* loopback for such a request and the exemption fired.
 * `SameSite=Lax` does not help either: the exemption means no cookie is needed.
 *
 * So the fence runs on this arm too. What the exemption still buys is exactly
 * what `prd.md` asks for and nothing more: **no pairing, no cookie, no device**
 * for local access. Local reads are unaffected (the fence asks nothing of a
 * read), a local browser's writes carry `Sec-Fetch-Site: same-origin` or a
 * matching `Origin` and pass, and only an unmarked local write — the shape a
 * forged cross-site request takes — is refused. That is `design.md` §3.2.1 arm
 * 4's intent applied consistently.
 *
 * ## Why loopback needs both signals
 *
 * A bare socket check is not enough. `Host` is attacker-controlled: a page on a
 * public site can resolve a name to `127.0.0.1` (DNS rebinding) and the socket
 * really will be loopback while the request was never meant for us. The official
 * fence defends against exactly this with its Host check
 * (`research/official-connection-fence.md` §2.1), and requiring BOTH means a
 * rebound request is treated as remote — where it must present a device cookie —
 * instead of being handed the loopback exemption.
 *
 * The mirror case matters too: a *remote* device whose request happens to carry
 * `Host: localhost` (some HTTP clients rewrite it) must not be exempted either,
 * which is what the socket half of the check prevents.
 *
 * The predicate itself is defined in `../loopback.js` (domain half) and
 * re-exported below, unchanged. Stage 4's admin API needs the same test but may
 * not import `gateway/*` (`quality-guidelines.md` §7 — one-way dependency), so
 * the single DEFINITION moved down a layer while the single DECISION stayed
 * here. Behaviour is byte-for-byte identical: same rules, same export shape.
 *
 * ## What this module does NOT do
 *
 * It does not touch `lastSeenAt`. Recording activity costs an fsync per call
 * (`research/official-connection-fence.md` §7.2), so that belongs to
 * `activity.js`, which the caller invokes after a successful decision — keeping
 * this function pure enough to reason about in isolation.
 */
import { hashToken, sameTokenHash } from '../tokens.js'
import {
  headerValue,
  isLoopback,
  isLoopbackHostname,
  isLoopbackSocket,
  peerAddress,
} from '../loopback.js'
import { checkOrigin, checkUpgradeOrigin, isWriteMethod } from './origin.js'

/* The loopback predicate is DEFINED in `../loopback.js` and RE-EXPORTED here, so
   the gateway keeps exporting what it always did (`isLoopback`, `isLoopbackSocket`,
   `isLoopbackHostname`, `peerAddress`) and every existing caller — including the
   tests that assert the DNS-rebinding arms — keeps working unchanged. What moved
   is only where the code lives; the decision about when it applies is still in
   `authorize()` below and nowhere else. */
export { isLoopback, isLoopbackHostname, isLoopbackSocket, peerAddress }

/**
 * Pull a named cookie out of a `Cookie` header.
 *
 * Deliberately not a general RFC 6265 parser. The only cookies consulted are the
 * one device cookie (whose name this package chose, and whose value is
 * base64url) and the inner-credential prefix filter; both are handled correctly
 * by splitting on `;` and trimming. A full parser would be more code with more
 * edge cases and no additional safety here.
 *
 * @param {string | undefined} header
 * @param {string} name Exact cookie name.
 * @returns {string | undefined}
 */
export function readCookie(header, name) {
  if (typeof header !== 'string' || header === '') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    const value = segment.slice(at + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/** Outcomes of {@link authorize}. `allow` is the only one that carries a device. */
export const DECISION = {
  /** Admitted. `device` is null for the loopback exemption. */
  ALLOW: 'allow',
  /** No (or unusable) device cookie — 401. */
  UNAUTHENTICATED: 'unauthenticated',
  /** Origin fence refused — 403. */
  FORBIDDEN: 'forbidden',
  /** The device exists but was revoked — 401, and the cookie must be cleared. */
  REVOKED: 'revoked',
}

/**
 * Run the fence that matches the transport.
 *
 * One line, and it is the reason the two fences cannot drift apart at the call
 * sites: an upgrade request never reaches `checkOrigin`'s read arms, and an HTTP
 * request never reaches the upgrade fence. Which fence applies is decided HERE and
 * nowhere else, so `authorize` keeps its "one decision point" property
 * (`quality-guidelines.md` §8) even though there are now two fences.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} upgrade
 * @returns {{ ok: true } | { ok: false, reason: string, detail: string }}
 */
function fenceFor(req, upgrade) {
  return upgrade === true ? checkUpgradeOrigin(req) : checkOrigin(req)
}

/**
 * Decide one request.
 *
 * Returns a verdict; it never writes a response and never throws. The caller
 * maps `reason` onto a status (see `server.js`), which keeps the "errors are
 * responses" rule in one place and makes the decision unit-testable without an
 * HTTP server.
 *
 * @param {object} input
 * @param {import('node:http').IncomingMessage} input.req
 * @param {ReturnType<typeof import('../store.js').createStore>} input.store Device table.
 * @param {string} input.cookieName Name of the device cookie.
 * @param {boolean} [input.upgrade] Whether this is a WebSocket upgrade handshake.
 * @returns {{
 *   decision: string,
 *   device: { id: string, name: string, revokedAt: string | null } | null,
 *   loopback: boolean,
 *   reason: string | null,
 * }}
 */
export function authorize({ req, store, cookieName, upgrade = false }) {
  const loopback = isLoopback(req)

  /* 1. Local access needs no credential (`prd.md` R3, acceptance "本机回环访问全程
        不需要配对"), but it does not get to skip the origin fence: the gateway is
        the hop that injects the instance-wide inner credential and removes
        `Origin`/`Sec-Fetch-*`, so letting a cross-site write through here would
        hand DSH an authenticated request the official fence would have refused.
        See "Why loopback is not exempt from the origin fence" above.

        On the upgrade path the fence is the STRICTER one (`origin.js`
        {@link checkUpgradeOrigin}): a WebSocket handshake is a GET, so the read
        arms would wave through a live `Origin: http://evil.example` with no
        `Sec-Fetch-Site`, which is exactly what a page opening a socket looks
        like — measured. Same order, same exemption for the CREDENTIAL, harder
        fence for the origin proof. */
  if (loopback) {
    const origin = fenceFor(req, upgrade)
    if (!origin.ok) {
      return { decision: DECISION.FORBIDDEN, device: null, loopback: true, reason: origin.reason }
    }
    return { decision: DECISION.ALLOW, device: null, loopback: true, reason: null }
  }

  /* 2. The device credential. */
  const presented = readCookie(headerValue(req, 'cookie'), cookieName)
  if (presented === undefined) {
    return { decision: DECISION.UNAUTHENTICATED, device: null, loopback: false, reason: 'no-cookie' }
  }

  /* Step 2's only work: hash the presented value. */
  const tokenHash = hashToken(presented)

  /* The scan compares digests in constant time inside the store. A revoked device
     is NOT returned by it, so the revoked case needs its own lookup below — see
     the note there for why the two lookups are not redundant. */
  const active = store.findActiveDeviceByTokenHash(tokenHash)

  /* 3. Origin fence (`design.md` §3.2 step 3, `origin.js` for the four arms).
        Runs before revocation is reported: a forged cross-site write is refused
        as a forgery, not as an authentication failure, because the two lead an
        operator to completely different conclusions. */
  const origin = fenceFor(req, upgrade)
  if (!origin.ok) {
    return { decision: DECISION.FORBIDDEN, device: null, loopback: false, reason: origin.reason }
  }

  /* 4. Revocation. `findActiveDeviceByTokenHash` filters revoked rows out, so a
        null result means either "no such device" or "revoked device" and the two
        must be told apart: an unpaired caller gets 401 with no cookie action, a
        revoked one gets 401 AND a cookie deletion. Re-scanning only when the
        first lookup missed keeps the common path at one pass over the table, and
        the re-scan is only reached by a caller who already holds a real token. */
  if (active === null) {
    const known = store.listDevices().find(
      (device) => device.revokedAt !== null && sameTokenHash(device.tokenHash, tokenHash),
    )
    if (known !== undefined) {
      return { decision: DECISION.REVOKED, device: null, loopback: false, reason: 'revoked' }
    }
    return { decision: DECISION.UNAUTHENTICATED, device: null, loopback: false, reason: 'unknown-token' }
  }

  return {
    decision: DECISION.ALLOW,
    device: { id: active.id, name: active.name, revokedAt: active.revokedAt },
    loopback: false,
    reason: null,
  }
}

/**
 * Map a decision onto the HTTP status the gateway answers with.
 *
 * `design.md` §3.2: unauthenticated → 401, origin refusal → 403, revoked → 401.
 * Kept beside the decision so the two cannot drift.
 *
 * @param {string} decision
 * @returns {number}
 */
export function statusFor(decision) {
  switch (decision) {
    case DECISION.ALLOW: return 200
    case DECISION.UNAUTHENTICATED: return 401
    case DECISION.REVOKED: return 401
    case DECISION.FORBIDDEN: return 403
    /* An unknown decision is a programming error, and answering 500 would tell an
       attacker their request reached deeper than it should. Deny closed. */
    default: return 403
  }
}

/**
 * Stable error code for a decision, for the response body and the log line.
 *
 * @param {string} decision
 * @param {string | null} reason
 * @returns {string}
 */
export function codeFor(decision, reason) {
  if (decision === DECISION.REVOKED) return 'gateway/device-revoked'
  if (decision === DECISION.FORBIDDEN) {
    return reason === 'cross-site' || reason === 'cross-origin' ? 'gateway/cross-origin' : 'gateway/untrusted-origin'
  }
  if (decision === DECISION.UNAUTHENTICATED) {
    return reason === 'malformed-token' ? 'gateway/malformed-token' : 'gateway/unauthenticated'
  }
  return 'gateway/denied'
}

/**
 * The decision's human-readable sentence, safe to show a client.
 *
 * No path, no URL, no digest, no cookie value: the body may only ever say what
 * kind of refusal happened (`.trellis/spec/backend/error-handling.md`).
 *
 * @param {string} decision
 * @param {string | null} reason
 * @returns {string}
 */
export function messageFor(decision, reason) {
  if (decision === DECISION.REVOKED) return 'This device has been revoked. Pair it again from the dsh remote control panel.'
  if (decision === DECISION.FORBIDDEN) {
    return reason === 'cross-site' || reason === 'cross-origin'
      ? 'Cross-site requests are not accepted by the remote gateway.'
      : 'This write request did not prove its origin and was refused.'
  }
  if (decision === DECISION.UNAUTHENTICATED) return 'Pair this device from the dsh remote control panel to continue.'
  return 'Request refused.'
}

/**
 * Whether a verdict permits the request to be proxied.
 *
 * @param {{ decision: string }} verdict
 * @returns {boolean}
 */
export function isAllowed(verdict) {
  return verdict !== null && typeof verdict === 'object' && verdict.decision === DECISION.ALLOW
}

/** Re-exported so callers do not need to import `origin.js` to ask. */
export { isWriteMethod }
