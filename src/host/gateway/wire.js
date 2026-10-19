/**
 * dsh-remote-control — the gateway's outbound edge.
 *
 * Everything the gateway writes *towards a client* lives here: error responses,
 * the device cookie's wire format, and the one guarded way a gateway module
 * writes a diagnostic line. Two rules from
 * `.trellis/spec/backend/error-handling.md` are enforced structurally rather
 * than by convention, because both are the kind of mistake that only shows up
 * under load:
 *
 *   - **Never `writeHead` twice.** Every sender funnels through {@link begin},
 *     which checks `res.headersSent` first. A second attempt destroys the
 *     response instead of throwing `ERR_HTTP_HEADERS_SENT` out of a handler.
 *   - **Never leak internals in a body.** Responses carry one human-readable
 *     sentence plus a stable `code`. No file paths, no upstream URL, no token
 *     digest, and — the security red line — never inner credential material.
 *
 * `emit` is here rather than in its own module because it is the other half of
 * the same concern: what leaves the process. It exists so the gateway modules
 * can call `emit(logger, 'warn', …)` unconditionally even when a host provided
 * no logger at all (or a partial one), which is the same defensiveness
 * `src/index.js` applies to `ctx.logger`.
 */

/** Levels the host logger exposes and the gateway uses. */
const LEVELS = ['debug', 'info', 'warn', 'error']

/**
 * Write one diagnostic line through a logger that may be missing or partial.
 *
 * A host with no logger gets silence rather than a stray `console.log`: there is
 * nowhere sensible to write, and inventing a sink is how stray output ends up in
 * a user's terminal (`.trellis/spec/backend/quality-guidelines.md` — the host
 * logs through `ctx.logger`, never the console).
 *
 * @param {object | null | undefined} logger Anything exposing `debug`/`info`/`warn`/`error`.
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 * @param {string} message Free text with inline values; never a token or a cookie.
 */
export function emit(logger, level, message) {
  if (logger === null || typeof logger !== 'object') return
  if (!LEVELS.includes(level)) return
  const sink = logger[level]
  if (typeof sink !== 'function') return
  sink.call(logger, message)
}

/**
 * Open a response with a status and headers, exactly once.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, string | string[]>} headers
 * @returns {boolean} true when the head was written and the caller may write a body.
 */
function begin(res, status, headers) {
  if (res.headersSent === true) {
    /* Something already answered. The only safe move left is to drop the
       connection: writing would throw, and leaving it open would hang the
       client on a response that will never be completed. */
    res.destroy()
    return false
  }
  res.writeHead(status, headers)
  return true
}

/**
 * Send the documented error envelope: `{ ok: false, error: { code, message } }`.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code Stable `模块/原因` code (`.trellis/spec/backend/error-handling.md`).
 * @param {string} message One human-readable sentence. Must contain no internals.
 * @param {Record<string, string>} [extraHeaders] Additional response headers.
 * @returns {boolean} whether anything was written.
 */
export function sendError(res, status, code, message, extraHeaders = undefined) {
  const payload = Buffer.from(JSON.stringify({ ok: false, error: { code, message } }), 'utf8')
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders)
  const opened = begin(res, status, headers)
  if (!opened) return false
  res.end(payload)
  return true
}

/** Escape the handful of characters that matter inside a text node. */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Send a minimal HTML page for a failed browser navigation.
 *
 * A phone opening the gateway in a browser with no device cookie must see
 * something readable, not a JSON blob. The page is deliberately tiny and
 * self-contained: no assets, no external requests, nothing that could be
 * mistaken for the DSH UI.
 *
 * It deliberately does NOT redirect to the pairing page. A redirect would move an
 * unauthenticated caller onto a route it has no business being pushed to — the
 * pairing page is reached from the QR link's own fragment or not at all
 * (`pairing-route.js`), and a 401 that silently becomes a pairing page reads as
 * "something went wrong" instead of "this device is not paired".
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code Stable error code, shown so a user can quote it.
 * @param {string} message One human-readable sentence.
 * @param {Record<string, string>} [extraHeaders]
 * @returns {boolean} whether anything was written.
 */
export function sendHtml(res, status, code, message, extraHeaders = undefined) {
  const body = Buffer.from(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>dsh remote control</title></head>'
      + '<body style="font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1.5rem">'
      + `<h1 style="font-size:1.25rem">dsh remote control</h1><p>${escapeHtml(message)}</p>`
      + `<p style="color:#666;font-size:.875rem">${escapeHtml(code)}</p>`
      + '</body></html>',
    'utf8',
  )
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders)
  const opened = begin(res, status, headers)
  if (!opened) return false
  res.end(body)
  return true
}

/**
 * Send a complete HTML document, with per-caller headers.
 *
 * Unlike {@link sendHtml} this carries no error code and takes the caller's own
 * headers, because the one caller is the pairing page (`pairing-route.js`), which
 * ships a fixed document and needs `Content-Security-Policy` / `X-Frame-Options`
 * that an error page does not. The shared rule is unchanged: the head goes through
 * {@link begin}, so it can never be written twice.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} html The complete document.
 * @param {Record<string, string>} [extraHeaders]
 * @returns {boolean} whether anything was written.
 */
export function sendDocument(res, status, html, extraHeaders = undefined) {
  const body = Buffer.from(typeof html === 'string' ? html : '', 'utf8')
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders)
  const opened = begin(res, status, headers)
  if (!opened) return false
  res.end(body)
  return true
}

/**
 * Send a redirect.
 *
 * `303` is the one that means "your POST succeeded; GET this instead", which is
 * exactly the pairing success transition: the browser must follow it as a GET, with
 * the `Set-Cookie` from this response already stored, so the page it lands on is
 * authenticated by the cookie this very response handed out.
 *
 * An empty body is deliberate: a `303` has nothing to say, and a body would be a
 * second place for a message to leak from.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} location Same-origin path only; never an absolute URL.
 * @param {Record<string, string>} [extraHeaders]
 * @returns {boolean} whether anything was written.
 */
export function sendRedirect(res, status, location, extraHeaders = undefined) {
  const headers = {
    location,
    'content-length': '0',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders)
  const opened = begin(res, status, headers)
  if (!opened) return false
  res.end()
  return true
}

/**
 * Whether a request is a browser navigation that should get HTML rather than JSON.
 *
 * Judged from `Accept` alone: a navigation asks for HTML, a `fetch()` asks for
 * JSON (or a wildcard, which must not be treated as a navigation or an XHR would
 * receive a page).
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function wantsHtml(req) {
  const accept = req !== null && typeof req === 'object' ? req.headers?.accept : undefined
  if (typeof accept !== 'string') return false
  return accept.includes('text/html')
}

/**
 * `Set-Cookie` value for a device credential.
 *
 * `value` is a signed JWT (`research/jwt-device-credential.md`). A JWS compact
 * serialization is `header.payload.signature` in base64url — letters, digits, `-`,
 * `_` and two `.` — so it is cookie-safe with no escaping. The value is NOT
 * sanitized here: `tokens.js` is the only thing that produces one, and a sanitizer
 * on this side would be a second place for the format to be defined.
 *
 * Attributes follow `design.md` §3.2: `HttpOnly; SameSite=Lax; Path=/`.
 * **No `Secure`** — the LAN transport is plain HTTP, and a `Secure` cookie is
 * simply never sent back, which would make pairing appear to work and then fail
 * on the next request. That is a documented security boundary in the README, not
 * an oversight.
 *
 * @param {string} name
 * @param {string} value Signed device JWT.
 * @param {number} maxAgeSeconds
 * @returns {string}
 */
export function deviceCookie(name, value, maxAgeSeconds) {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; HttpOnly; SameSite=Lax`
}

/**
 * `Set-Cookie` value that deletes the device cookie.
 *
 * Sent on a revoked device's request so a browser stops presenting a credential
 * that can never work again, instead of failing on every load.
 *
 * @param {string} name
 * @returns {string}
 */
export function clearDeviceCookie(name) {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`
}
