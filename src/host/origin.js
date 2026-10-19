/**
 * dsh-remote-control — Origin / Sec-Fetch-Site validation.
 *
 * `design.md` §3.2 step 3 and `prd.md`'s architecture note: the official
 * WebServer performs no Origin check of its own, so this module holds the only
 * check standing between a page on `evil.example` and a paired device's cookie.
 * A browser attaches cookies to cross-site requests; `SameSite=Lax` stops that
 * for most methods but not for a top-level `POST` navigation, and the cookie is
 * the whole credential. Hence an explicit check here.
 *
 * ## Why this lives in the domain half
 *
 * It was first written under `gateway/`, because the gateway was its only
 * caller. Stage 4 added a second one: the admin API on the official port
 * (`api.js`), which must run the same fence — it is reachable from a browser and
 * every one of its routes writes state. `directory-structure.md` makes the
 * dependency one-way (`api.js` never imports `gateway/*`), so the fence moved
 * down a layer and `gateway/origin.js` re-exports it unchanged. Two copies of
 * this logic is exactly how one arm ends up with a hole the other does not have.
 *
 * The decision rules below are unchanged from stage 3, including the separate,
 * stricter upgrade entry point.
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
 *
 * ## Two entries, because a WebSocket upgrade is a GET with a worse failure mode
 *
 * {@link checkOrigin} is the HTTP fence and keeps the four arms above unchanged.
 * {@link checkUpgradeOrigin} is a **separate, stricter** fence for upgrade
 * requests: a browser opens a WebSocket with no CORS preflight at all and is not
 * obliged to send `Sec-Fetch-Site`, so a live `Origin` with no `Sec-Fetch-Site` —
 * measured on a real upgrade request — would sail through the read arms and hand a
 * page on `evil.example` a persistent bidirectional channel to DSH. On the upgrade
 * path an `Origin`, when present, must match `Host`; the HTTP path is deliberately
 * not changed, because there a foreign `Origin` on a GET is what CORS is for.
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

  /* Arm 4. No Origin, no (usable) Sec-Fetch-Site. Before refusing, consult
     `Referer`: a same-origin page that issues a write without either marker is
     real traffic, and the panel does exactly that (measured against the running
     GUI: `POST /remote-control/api/settings` with no `Origin` and no
     `Sec-Fetch-Site` was answered 403 `admin/cross-origin`, so pressing Save or
     Generate-code in the panel failed).

     This does not widen the CSRF surface, because a cross-site write cannot
     produce a matching `Referer`:
       - page JavaScript cannot set `Referer`; the browser owns it;
       - a cross-site page's `Referer` names the ATTACKER's origin, so it fails
         the same-origin comparison below;
       - such a request also carries `Origin` (arm 2 rejects it) and usually
         `Sec-Fetch-Site: cross-site` (arm 1 rejects it);
       - under `Referrer-Policy: no-referrer` the header is simply absent and we
         still fall through to the refusal below;
       - a non-browser client could forge `Referer`, but it can forge every
         header — and it does not hold the device cookie that makes CSRF
         interesting. */
  const referer = headerOf(req, 'referer')
  if (referer !== undefined) {
    const refererAuthority = authorityOf(referer)
    const hostAuthority = authorityOf(`http://${host ?? ''}`)
    if (refererAuthority !== undefined && refererAuthority === hostAuthority) return { ok: true }
    return { ok: false, reason: 'cross-origin', detail: 'Referer does not match Host' }
  }

  /* Arm 5. Nothing at all proves the origin. */
  return { ok: false, reason: 'no-origin', detail: 'write request carries neither Origin, a same-site Sec-Fetch-Site, nor a same-origin Referer' }
}

/**
 * Decide whether a **WebSocket upgrade** passes the origin fence.
 *
 * ## Why this is a second entry and not an argument to `checkOrigin`
 *
 * A WebSocket upgrade is a `GET`, so the read arms above would hand it a decision
 * built for a request whose worst outcome is reading a response. For a WS upgrade
 * the worst outcome is a persistent bidirectional channel: the attacker page reads
 * every streamed token AND issues instructions on the victim's behalf. That is
 * CSWSH, and three properties of WebSocket turn the read arms into a hole:
 *
 *   1. **No CORS preflight exists.** A page opens `new WebSocket(url)` and the
 *      browser sends the handshake directly; there is no `OPTIONS` phase to fail.
 *   2. **The browser always sends `Origin`** (RFC 6455 §4.1) — but it is **not
 *      obliged to send `Sec-Fetch-Site`**, and measured against this host that
 *      header is simply absent on a real upgrade request. `checkOrigin`'s read path
 *      only consults `Sec-Fetch-Site`, so a live `Origin: http://evil.com` with no
 *      `Sec-Fetch-Site` came out `{ ok: true }` — measured.
 *   3. **The channel is long-lived**, so one admitted handshake is unbounded
 *      access, not one read.
 *
 * So the rule here is strictly stronger than the read arms: **if `Origin` is
 * present, it must match the authority the request was addressed to** — no
 * exception for "it is only a read". `checkOrigin` keeps its behaviour untouched,
 * because the HTTP path has been reviewed against those four arms and a GET with a
 * foreign `Origin` is legitimately served (CORS decides what the browser may read).
 * Same fence, different consequence; two entries.
 *
 * ## The arms, and why a missing `Origin` is allowed
 *
 * | # | upgrade request | verdict |
 * |---|---|---|
 * | 1 | `Sec-Fetch-Site: cross-site` | reject — unforgeable, strongest signal |
 * | 2 | `Origin` present and matching `Host` | allow |
 * | 3 | `Origin` present and **not** matching `Host` | reject, **even with no `Sec-Fetch-Site`** |
 * | 4 | `Origin` malformed (`null`), or `Host` unparsable | reject — cannot prove a match |
 * | 5 | no `Origin` | allow — only a non-browser client omits it |
 *
 * Arm 5 rests on a specification guarantee, not on optimism: a browser's
 * `WebSocket` constructor is required to send `Origin`, so a handshake without one
 * cannot have come from a page. That is what keeps a CLI client, a script and this
 * project's own tests working without inventing an `Origin` they do not have.
 * `Sec-Fetch-Site` is therefore *not consulted* in the no-`Origin` case: it can
 * only ever be absent or hostile there, and treating a hostile-but-irrelevant
 * header as a reason to allow would be backwards.
 *
 * Pure: reads the request, returns a verdict, never writes and never throws.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: true } | { ok: false, reason: string, detail: string }}
 */
export function checkUpgradeOrigin(req) {
  const site = headerOf(req, 'sec-fetch-site')
  const origin = headerOf(req, 'origin')
  const host = headerOf(req, 'host')

  /* Arm 1. Applies whether or not an Origin is present, and beats a matching
     Origin: a page cannot forge this header, so it is believed over one it can. */
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') {
    return { ok: false, reason: 'cross-site', detail: 'the upgrade declares Sec-Fetch-Site: cross-site' }
  }

  /* Arms 2-4. THIS is the arm the read path does not have. */
  if (origin !== undefined) {
    const originAuthority = authorityOf(origin)
    if (originAuthority === undefined) {
      /* `null` is what a sandboxed iframe sends. Not an origin we can compare. */
      return { ok: false, reason: 'bad-origin', detail: 'the upgrade Origin is not a parsable origin' }
    }
    const hostAuthority = authorityOf(`http://${host ?? ''}`)
    if (hostAuthority === undefined) {
      return { ok: false, reason: 'bad-host', detail: 'the upgrade Host is not a parsable authority' }
    }
    if (originAuthority !== hostAuthority) {
      return { ok: false, reason: 'cross-origin', detail: 'the upgrade Origin does not match Host' }
    }
    return { ok: true }
  }

  /* Arm 5. No Origin: no browser can produce this handshake (RFC 6455 §4.1), so it
     is a non-browser client, which holds no cookie of its own accord. */
  return { ok: true }
}
