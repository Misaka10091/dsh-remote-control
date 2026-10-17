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
 *   1. **Loopback source → allow.** A request that BOTH arrived over a loopback
 *      socket AND names a loopback authority in `Host` came from this machine,
 *      and `prd.md` requires the local experience to be untouched. Requiring a
 *      cookie here would break every local tool.
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
 * ## What this module does NOT do
 *
 * It does not touch `lastSeenAt`. Recording activity costs an fsync per call
 * (`research/official-connection-fence.md` §7.2), so that belongs to
 * `activity.js`, which the caller invokes after a successful decision — keeping
 * this function pure enough to reason about in isolation.
 */
import { hashToken, sameTokenHash } from '../tokens.js'
import { checkOrigin, isWriteMethod } from './origin.js'

/**
 * Whether a hostname names loopback.
 *
 * Reimplemented rather than imported: the official predicate is package-internal
 * (`dsh-client-connection` does not export `isLoopbackHostname`), and the rules
 * are fixed and small. Identical semantics so the two agree: `localhost`, IPv6
 * `::1`, and any address in `127/8`.
 *
 * @param {string} hostname Already-normalized WHATWG hostname (IPv6 keeps its brackets).
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string') return false
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * The peer address of a request, normalized, or `undefined` when unknowable.
 *
 * `remoteAddress` may be an IPv4-mapped IPv6 literal (`::ffff:127.0.0.1`) on a
 * dual-stack listener, which is exactly what `0.0.0.0` produces on Windows. Left
 * unmapped, that literal would fail {@link isLoopbackHostname} and a genuinely
 * local request would be asked for a cookie.
 *
 * @param {import('node:net').Socket | null | undefined} socket
 * @returns {string | undefined}
 */
export function peerAddress(socket) {
  const address = socket !== null && typeof socket === 'object' ? socket.remoteAddress : undefined
  if (typeof address !== 'string' || address === '') return undefined
  /* Unwrap IPv4-mapped IPv6 so one address has one spelling. */
  if (address.startsWith('::ffff:') && address.includes('.')) return address.slice('::ffff:'.length)
  return address
}

/**
 * Whether the SOCKET end of this request came from loopback.
 *
 * Only half of the loopback test — see {@link isLoopback}. Exported because the
 * admin API (stage 4) will need the socket half on its own.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isLoopbackSocket(req) {
  return isLoopbackHostname(peerAddress(req?.socket))
}

/**
 * Whether this request is a local, non-browser-originated access.
 *
 * BOTH halves are required (`design.md` §3.2 note):
 *
 *   - the socket peer is loopback — proves the bytes came from this machine;
 *   - the `Host` header names a loopback authority — proves the request was
 *     addressed to this machine rather than delivered here by DNS rebinding.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isLoopback(req) {
  if (!isLoopbackSocket(req)) return false
  const host = readHeader(req, 'host')
  if (typeof host !== 'string' || host === '') return false
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

/**
 * Read one request header as a string.
 *
 * Kept local so this module has no dependency on `origin.js`'s internals beyond
 * the single exported decision; repeated headers collapse to their first value.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 * @returns {string | undefined}
 */
function readHeader(req, name) {
  if (req === null || typeof req !== 'object') return undefined
  const headers = req.headers
  if (headers === null || typeof headers !== 'object') return undefined
  const value = headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

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
 * @returns {{
 *   decision: string,
 *   device: { id: string, name: string, revokedAt: string | null } | null,
 *   loopback: boolean,
 *   reason: string | null,
 * }}
 */
export function authorize({ req, store, cookieName }) {
  const loopback = isLoopback(req)

  /* 1. Local access needs no credential (`prd.md` R3, acceptance "本机回环访问全程
       不需要配对"). Recorded as ALLOW with no device so audit can distinguish it. */
  if (loopback) return { decision: DECISION.ALLOW, device: null, loopback: true, reason: null }

  /* 2. The device credential. */
  const presented = readCookie(readHeader(req, 'cookie'), cookieName)
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
  const origin = checkOrigin(req)
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
