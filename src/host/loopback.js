/**
 * dsh-remote-control — "did this request come from this machine?".
 *
 * One question, asked by two transports that must never disagree about it:
 *
 *   - the gateway (`gateway/auth.js`) uses it to decide whether `prd.md`'s
 *     "本机回环访问全程不需要配对" exemption applies;
 *   - the admin API (`api.js`) uses it as its **only** admission test, because
 *     `design.md` §7 makes device management loopback-only — a paired phone may
 *     drive a session but may never manage devices.
 *
 * It lives here, in the domain half, rather than in `gateway/auth.js` where it
 * was first written. `quality-guidelines.md` §7 makes the dependency one-way
 * (`api.js` → domain modules, never → `gateway/*`), and two copies of a security
 * predicate is precisely how the two arms end up disagreeing. `gateway/auth.js`
 * re-exports these four functions, so it remains the single decision point for
 * the gateway while this module is the single *definition*.
 *
 * ## Both halves, always
 *
 * A bare socket check is not enough. `Host` is attacker-controlled: a page on a
 * public site can resolve a name to `127.0.0.1` (DNS rebinding), so the socket
 * really is loopback while the request was never meant for us. The official
 * fence defends against exactly this with its own Host check
 * (`research/official-connection-fence.md` §2.1). Requiring BOTH signals means a
 * rebound request is treated as remote — where it must present a device cookie —
 * instead of being handed the local exemption.
 *
 * The mirror case matters too: a *remote* device whose request happens to carry
 * `Host: localhost` (some HTTP clients rewrite it) must not be exempted either,
 * which is what the socket half prevents.
 *
 * `quality-guidelines.md` §8: an exemption is only ever allowed to waive the
 * thing it names. Here it waives the credential; it never waives the origin
 * fence, which both callers run separately.
 */

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
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  /* An IPv6 zone index (`fe80::1%eth0`) is not loopback, and `::1%x` must not be
     accepted by the prefix test below. */
  if (hostname.includes(':')) return false
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
 * Read one request header as a string.
 *
 * Duplicated headers arrive as arrays. For the fields checked here a repeated
 * value is not meaningful, so the first is used.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name Lower-case header name.
 * @returns {string | undefined}
 */
export function headerValue(req, name) {
  if (req === null || typeof req !== 'object') return undefined
  const headers = req.headers
  if (headers === null || typeof headers !== 'object') return undefined
  const value = headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/**
 * Whether the SOCKET end of this request came from loopback.
 *
 * Only half of the loopback test — see {@link isLoopback}. Exported on its own
 * because the socket half is the part a caller may want to assert separately
 * (a test cannot make a real non-loopback socket, but it can hand this a fake).
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
 * Pure: reads the request, returns a boolean, never throws.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isLoopback(req) {
  if (!isLoopbackSocket(req)) return false
  const host = headerValue(req, 'host')
  if (typeof host !== 'string' || host === '') return false
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}
