/**
 * dsh-remote-control — Origin / Sec-Fetch-Site validation.
 *
 * `design.md` §3.2 step 3 and `prd.md`'s architecture note: the official
 * WebServer performs no Origin check of its own, so this gateway is the only
 * thing standing between a page on `evil.example` and a paired device's cookie.
 * A browser attaches cookies to cross-site requests; `SameSite=Lax` stops that
 * for most methods but not for a top-level `POST` navigation, and the cookie is
 * the whole credential. Hence an explicit check here.
 *
 * ## The decision, and why it is not literally "no Origin ⇒ 403"
 *
 * `design.md` §3.2 says "a write request with no Origin is refused (403)". Read
 * as an unconditional rule that also rejects *same-origin* browser writes, it
 * breaks real traffic: not every same-origin write carries `Origin` (and
 * non-browser clients such as `curl` or a LAN script never send it at all, yet
 * `implement.md` stage 2's own acceptance step is literally `curl` with a valid
 * cookie). So the rule is implemented as the CSRF defence it is meant to be,
 * using the strongest signal available first:
 *
 *   1. `Sec-Fetch-Site: cross-site`  → **reject, unconditionally.** The browser
 *      sets this header itself and a page cannot forge it; it is the single most
 *      trustworthy statement about where a request came from.
 *   2. write request **with** `Origin` → accept only when `origin.host` equals
 *      the request's own `Host`. Mismatch (including a malformed `Origin`) is a
 *      cross-site write → reject.
 *   3. write request **without** `Origin`, but `Sec-Fetch-Site` is `same-origin`
 *      or `same-site` → **accept.** The browser has explicitly declared the
 *      request originates from this site; the missing `Origin` is a browser
 *      choice, not evidence of an attacker.
 *   4. write request **without** `Origin` and **without** `Sec-Fetch-Site` →
 *      **reject.** Nothing proves where it came from, and this is exactly the
 *      shape a CSRF forgery from a non-browser agent takes. This is the arm that
 *      honours `design.md` §3.2's intent: an unmarked write never gets through.
 *
 * `none` is rejected in arm 3 as well: `Sec-Fetch-Site: none` means a user-
 * initiated navigation (typing a URL, a bookmark), which for a write is not a
 * browser form submission at all. `same-site` is accepted because it still means
 * the same registrable domain, and LAN deployments are reached by a bare IP
 * where `same-origin` is what a normal fetch reports anyway.
 *
 * ## What a write is
 *
 * Everything except `GET` / `HEAD` / `OPTIONS`. `OPTIONS` is a CORS preflight:
 * it carries no cookie effect and is answered for browsers by the proxy, so
 * treating it as a read is both correct and the only way a cross-origin preflight
 * can be handled without a special case elsewhere.
 */

/** Methods a request may use without proving its origin. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** `Sec-Fetch-Site` values that positively assert a same-site browser request. */
const SAME_SITE_VALUES = new Set(['same-origin', 'same-site'])

/**
 * Whether a method mutates state and therefore needs an origin assertion.
 *
 * @param {string | undefined} method
 * @returns {boolean}
 */
export function isWriteMethod(method) {
  if (typeof method !== 'string') return true
  return !SAFE_METHODS.has(method.toUpperCase())
}

/**
 * Extract the authority (`host[:port]`) from a header value, or `undefined`.
 *
 * Goes through WHATWG parsing so `http://LAN:3090` and `http://lan:3090` compare
 * equal, a default port is dropped, and a malformed value yields `undefined`
 * rather than throwing. Mirrors the official fence's own `new URL(origin).host`
 * comparison (`research/official-connection-fence.md` §2.1) so the two agree on
 * what "same origin" means.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function authorityOf(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return new URL(value).host
  } catch {
    return undefined
  }
}

/**
 * Read one request header as a string, tolerating node's string[] shape.
 *
 * Duplicated headers arrive as arrays. For the fields checked here a repeated
 * value is not meaningful, so the first is used; a client sending `Origin` twice
 * is not going to be trusted on the second one either.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 * @returns {string | undefined}
 */
export function headerOf(req, name) {
  if (req === null || typeof req !== 'object') return undefined
  const headers = req.headers
  if (headers === null || typeof headers !== 'object') return undefined
  const value = headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/**
 * Decide whether a request passes the origin fence.
 *
 * Pure: it reads the request and returns a verdict. It never writes a response
 * and never throws, so the caller owns the status code (the single-place
 * contract in `quality-guidelines.md` §8 is `auth.js`, which calls this).
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: true } | { ok: false, reason: string, detail: string }}
 */
export function checkOrigin(req) {
  const site = headerOf(req, 'sec-fetch-site')
  const origin = headerOf(req, 'origin')
  const host = headerOf(req, 'host')
  const write = isWriteMethod(req?.method)

  /* Arm 1. Applies to reads as well: a cross-site read is still a request we
     have no reason to serve, and the official fence rejects it too — a request
     that reaches upstream carrying `sec-fetch-site: cross-site` would 403 there
     with a much less diagnosable error. */
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') {
    return { ok: false, reason: 'cross-site', detail: 'Sec-Fetch-Site is cross-site' }
  }

  if (!write) return { ok: true }

  /* Arm 2. */
  if (origin !== undefined) {
    const originAuthority = authorityOf(origin)
    const hostAuthority = authorityOf(`http://${host ?? ''}`)
    if (originAuthority === undefined) {
      return { ok: false, reason: 'bad-origin', detail: 'Origin is not a parsable origin' }
    }
    if (hostAuthority === undefined) {
      return { ok: false, reason: 'bad-host', detail: 'Host is not a parsable authority' }
    }
    if (originAuthority !== hostAuthority) {
      return { ok: false, reason: 'cross-origin', detail: 'Origin does not match Host' }
    }
    return { ok: true }
  }

  /* Arm 3. */
  if (typeof site === 'string' && SAME_SITE_VALUES.has(site.toLowerCase())) return { ok: true }

  /* Arm 4. No Origin, no (usable) Sec-Fetch-Site: nothing proves the origin. */
  return { ok: false, reason: 'no-origin', detail: 'write request carries neither Origin nor a same-site Sec-Fetch-Site' }
}
