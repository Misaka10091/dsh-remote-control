/**
 * dsh-remote-control — the inner browser-session credential.
 *
 * ## The problem this module exists for
 *
 * The official port is NOT open to a naive reverse proxy. `dsh-client-connection`
 * stacks a Host/Origin fence and an authority-bound signed cookie on top of the
 * web server, covering `/api`, the `/api/remote.mux` upgrade, and the index
 * response — **with no loopback exemption**
 * (`research/official-connection-fence.md` §2, measured: `GET 127.0.0.1:<port>/`
 * → 401 `dsh web authentication required`).
 *
 * So forwarding a remote device's request verbatim produces a 401 from DSH that
 * looks exactly like a bug in our proxy. The fix is one cookie:
 *
 *   - `ctx.connection.authenticatedUrl('http://127.0.0.1:<port>/')` returns the
 *     root URL carrying the process launch token (§2.2);
 *   - `GET` that URL with `redirect: 'manual'` — the exchange is a `303`, and
 *     following it would discard the `Set-Cookie` that is the entire point;
 *   - read the `dsh-auth-` prefixed `name=value` out of `set-cookie`.
 *
 * The resulting cookie is bound to the authority `127.0.0.1:<port>`, which is
 * precisely the authority the gateway rewrites `Host` to. So it is not a
 * per-request credential at all: **one redemption is reusable for the life of the
 * gateway's upstream target**, and this module caches it.
 *
 * ## Security red line
 *
 * This cookie is equivalent to complete access to the DSH instance. It exists
 * only on the gateway → upstream hop:
 *
 *   - it is never written to a response header (`proxy.js` strips `set-cookie`
 *     from upstream responses for exactly this reason);
 *   - it is never logged, never audited, never placed in an error body. There is
 *     deliberately no `describe()`/`toString()` on the cache, and the failure
 *     messages in this file name the phase, never the value;
 *   - every client-supplied cookie with this prefix is dropped before forwarding
 *     (`proxy.js`), so client bytes can never occupy the credential slot.
 *
 * ## Degradation
 *
 * `ctx.connection` is OPTIONAL: it is read with `ctx.get('connection')`, never
 * added to `inject` (`quality-guidelines.md` §6 — `inject` is a hard dependency
 * and declining to load the whole plugin because one optional service is missing
 * would take the device panel down with it). When it is absent — an older host —
 * no cookie is attached, the upstream 401 is passed through unchanged, and a
 * single `warn` records the degradation rather than one per request
 * (`.trellis/spec/backend/error-handling.md`: the one allowed downgrade must be
 * visible, not repeated).
 */

/** Prefix of the cookie minted by the official connection plugin. */
import { INNER_AUTH_RETRY_INTERVAL_MS, INNER_COOKIE_PREFIX as COOKIE_PREFIX } from '../constants.js'

/**
 * Pull the `name=value` of the `dsh-auth-*` cookie out of a `set-cookie` header.
 *
 * `Head` normalizes `set-cookie` to an array (in Node 18.14+ / undici). The
 * header is nevertheless accepted as a bare string too, because a host with a
 * polyfilled or stubbed `fetch` may hand back a single value, and silently
 * failing to find the cookie there would surface as an unexplained 401.
 *
 * Only the first `name=value` pair is taken: everything after the first `;` is
 * attributes (`Path`, `HttpOnly`, …), which must not be forwarded.
 *
 * @param {string[] | string | null | undefined} setCookie
 * @returns {string | undefined} `name=value`, or undefined when absent.
 */
export function extractInnerCookie(setCookie) {
  if (setCookie === null || setCookie === undefined) return undefined
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const separator = entry.indexOf(';')
    const pair = (separator === -1 ? entry : entry.slice(0, separator)).trim()
    const equals = pair.indexOf('=')
    if (equals === -1) continue
    if (!pair.slice(0, equals).trim().startsWith(COOKIE_PREFIX)) continue
    const value = pair.slice(equals + 1).trim()
    if (value === '') continue
    return `${pair.slice(0, equals).trim()}=${value}`
  }
  return undefined
}

/**
 * Build an Error carrying a stable `code` (`error-handling.md` — plain Error with
 * a `code` string, no custom subclasses).
 *
 * @param {string} code
 * @param {string} message Must never contain cookie material.
 * @returns {Error}
 */
function innerAuthError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Create the inner-credential provider.
 *
 * @param {object} options
 * @param {() => { authenticatedUrl?: (baseUrl: string) => unknown } | undefined} options.getConnection
 *   Reads the optional `connection` service at call time — NOT at construction —
 *   so the provider keeps working if the service is (re)loaded later, and so a
 *   test can swap it per case.
 * @param {string} options.upstreamOrigin e.g. `http://127.0.0.1:19387`.
 * @param {typeof globalThis.fetch} [options.fetchImpl] Injectable for tests; defaults to global `fetch`.
 * @param {() => number} [options.now] Clock in epoch milliseconds.
 * @param {number} [options.retryIntervalMs] Minimum spacing between failed attempts.
 * @param {(logger: object, level: 'debug' | 'info' | 'warn' | 'error', message: string) => void} [options.emit]
 *   Logger sink; defaults to a no-op so the module is usable without a host logger.
 * @param {object} [options.logger] Logger passed to `emit`.
 * @returns {{
 *   header: () => Promise<string | undefined>,
 *   invalidate: () => void,
 *   peek: () => string | undefined,
 *   refresh: () => Promise<string | undefined>,
 *   available: () => boolean,
 * }}
 */
export function createInnerAuth(options) {
  const getConnection = typeof options.getConnection === 'function' ? options.getConnection : () => undefined
  const upstreamOrigin = typeof options.upstreamOrigin === 'string' ? options.upstreamOrigin : ''
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const retryIntervalMs = Number.isFinite(options.retryIntervalMs) && options.retryIntervalMs > 0
    ? options.retryIntervalMs
    : INNER_AUTH_RETRY_INTERVAL_MS
  const emit = typeof options.emit === 'function' ? options.emit : () => {}
  const logger = options.logger

  /** The cached `name=value`. `null` = no attempt made yet; `undefined` = known-bad. */
  let cached = null

  /** When the last failed attempt happened, so a redeem storm cannot form. */
  let lastFailureAt = Number.NEGATIVE_INFINITY

  /** Whether the "no connection service" warning has been said. Once, not per request. */
  let warnedUnavailable = false

  /** Set while a redemption is in flight, so concurrent requests share one exchange. */
  let inFlight = null

  /** Whether the optional service is currently present. */
  function available() {
    const connection = getConnection()
    return connection !== undefined && connection !== null && typeof connection.authenticatedUrl === 'function'
  }

  /**
   * Perform one redemption against the upstream.
   *
   * @returns {Promise<string | undefined>} the `name=value`, or undefined on failure.
   */
  async function redeem() {
    if (!available()) {
      if (!warnedUnavailable) {
        warnedUnavailable = true
        emit(
          logger,
          'warn',
          `[remote-control] ctx.connection is unavailable: the gateway cannot mint the inner ${COOKIE_PREFIX}* `
            + 'credential, so upstream requests will be rejected (401) by dsh web. Remote access is degraded.',
        )
      }
      return undefined
    }
    const connection = getConnection()
    let url
    try {
      url = connection.authenticatedUrl(`${upstreamOrigin}/`)
    } catch {
      /* `authenticatedUrl` parses its argument; a malformed base is our bug, not
         the caller's, and must not escape as a request-time exception. */
      emit(logger, 'error', '[remote-control] inner credential: authenticatedUrl() rejected the upstream base URL')
      lastFailureAt = now()
      return undefined
    }
    if (typeof url !== 'string' || url === '') {
      emit(logger, 'error', '[remote-control] inner credential: authenticatedUrl() returned no URL')
      lastFailureAt = now()
      return undefined
    }

    let response
    try {
      /* `redirect: 'manual'` is mandatory: the exchange answers 303 with the
         cookie, and a followed redirect discards it (measured, §6 of the
         research note — the parent verified `set-cookie` survives only with
         `manual`). */
      response = await fetchImpl(url, { redirect: 'manual', method: 'GET' })
    } catch {
      /* Network-level failure: DSH not listening yet, or restarting. Not an
         exception to the request — the caller passes the upstream 401 through. */
      emit(logger, 'warn', '[remote-control] inner credential: the exchange request failed')
      lastFailureAt = now()
      return undefined
    }

    const headerValue = extractInnerCookie(response?.headers?.get?.('set-cookie'))
    if (headerValue === undefined) {
      /* A 200 instead of a 303 means the launch token was rejected — typically a
         stale URL after a DSH restart. Say the phase, never the value. */
      emit(
        logger,
        'warn',
        `[remote-control] inner credential: the exchange returned no ${COOKIE_PREFIX}* cookie `
          + `(status ${String(response?.status ?? 'unknown')})`,
      )
      lastFailureAt = now()
      return undefined
    }
    return headerValue
  }

  /**
   * Redeem, coalescing concurrent callers onto one exchange.
   *
   * Without this, a page load firing twenty requests at once would run twenty
   * exchanges, each of which makes DSH mint a fresh signed cookie. One in-flight
   * promise is shared instead, so the burst costs one exchange.
   *
   * @returns {Promise<string | undefined>}
   */
  async function redeemOnce() {
    if (inFlight !== null) return inFlight
    inFlight = redeem()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  /**
   * The `Cookie` header value for the upstream hop, or undefined when no inner
   * credential can be obtained (in which case the request proceeds without it and
   * the upstream 401 is passed through — `design.md` §4.4).
   *
   * @returns {Promise<string | undefined>}
   */
  async function header() {
    if (typeof cached === 'string') return cached
    /* A known-bad state is not retried on every request: `retryIntervalMs` bounds
       how often a failing upstream is asked again. */
    if (cached === undefined && now() - lastFailureAt < retryIntervalMs) return undefined
    const value = await redeemOnce()
    if (value === undefined) {
      cached = undefined
      return undefined
    }
    cached = value
    return value
  }

  /**
   * Drop the cache so the next {@link header} call redeems again.
   *
   * Called on an upstream 401. Bounded on purpose: `proxy.js` retries at most
   * ONCE, so a permanently failing credential cannot turn into a loop. Callers
   * must not call this from a request path more than once per request.
   */
  function invalidate() {
    cached = null
    /* Not `undefined`: that would trip the retry interval and make the single
       allowed retry a no-op. The retry interval is a shield against repeated
       failures, and `lastFailureAt` is what a failed retry sets. */
    lastFailureAt = Number.NEGATIVE_INFINITY
  }

  /**
   * The currently cached value, without redeeming. For tests and diagnostics —
   * never logged, never serialized.
   *
   * @returns {string | undefined}
   */
  function peek() {
    return typeof cached === 'string' ? cached : undefined
  }

  /**
   * Force a redemption and cache it, bypassing the cached value.
   *
   * Used at startup so the first remote request does not pay for the exchange,
   * and by tests.
   *
   * @returns {Promise<string | undefined>}
   */
  async function refresh() {
    cached = null
    lastFailureAt = Number.NEGATIVE_INFINITY
    return header()
  }

  return { header, invalidate, peek, refresh, available }
}

/**
 * Build the `Cookie` header to send upstream.
 *
 * The client's own `Cookie` header is filtered, not concatenated: every
 * `dsh-auth-` entry is dropped (a client can never hold a usable one, since the
 * value binds to the upstream authority, and forwarding one would put
 * client-controlled bytes where instance-wide credential material belongs), and
 * the minted inner pair is prepended.
 *
 * Order in a `Cookie` header is not significant, but the inner pair goes first so
 * that a hand-inspection of a debug trace reads it as "the credential we added,
 * then whatever the device had".
 *
 * @param {string | undefined} clientCookie The device's `Cookie` header.
 * @param {string | undefined} innerCookie `name=value` from `inner-auth`, or undefined.
 * @returns {string | undefined} `undefined` when there is nothing to send at all.
 */
export function buildUpstreamCookie(clientCookie, innerCookie) {
  const kept = []
  if (typeof clientCookie === 'string' && clientCookie !== '') {
    for (const segment of clientCookie.split(';')) {
      const pair = segment.trim()
      if (pair === '') continue
      const equals = pair.indexOf('=')
      const name = equals === -1 ? pair : pair.slice(0, equals).trim()
      /* Case-insensitive prefix test: cookie names are case-sensitive per RFC
         6265, but the official plugin always emits lower-case and a client
         sending `DSH-AUTH-…` must not be given the benefit of the doubt. */
      if (name.toLowerCase().startsWith(COOKIE_PREFIX)) continue
      kept.push(pair)
    }
  }
  if (typeof innerCookie === 'string' && innerCookie !== '') kept.unshift(innerCookie)
  return kept.length === 0 ? undefined : kept.join('; ')
}

/**
 * Whether a header value carries any inner credential.
 *
 * Used by `proxy.js` on the response path: an upstream `set-cookie` for this
 * prefix must never reach a client. Exported separately so the check is testable
 * without a server.
 *
 * @param {string | string[] | undefined} setCookie
 * @returns {boolean}
 */
export function carriesInnerCookie(setCookie) {
  if (setCookie === undefined || setCookie === null) return false
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const equals = entry.indexOf('=')
    const name = equals === -1 ? entry : entry.slice(0, equals)
    if (name.trim().toLowerCase().startsWith(COOKIE_PREFIX)) return true
  }
  return false
}
