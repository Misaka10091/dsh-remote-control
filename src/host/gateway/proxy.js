/**
 * dsh-remote-control — the HTTP reverse proxy.
 *
 * Forwards one authorized request to `http://127.0.0.1:<officialPort>` and streams
 * the answer back. Two things make this less trivial than "pipe the request".
 *
 * ## 1. Three rewrites, and they are not optional
 *
 * The official port enforces a Host/Origin fence plus an authority-bound
 * `dsh-auth-*` cookie, with no loopback exemption
 * (`research/official-connection-fence.md` §3, measured):
 *
 * | # | Action | Why |
 * |---|---|---|
 * | A | rewrite `Host` to `127.0.0.1:<officialPort>` | satisfies the loopback-host arm of `isTrustedApiRequest` |
 * | B | strip the client's `Origin` / `Sec-Fetch-Site` | the fence compares `origin.host === Host`, so a rewritten Host with a surviving Origin is a guaranteed 403 |
 * | C | attach the inner `dsh-auth-*` cookie | satisfies `BrowserAuth.isAuthenticated` |
 *
 * **A and B are one operation and must stay together.** Changing `Host` without
 * dropping `Origin` is precisely the configuration that produces an unexplainable
 * 403 — the parent called this out after measuring it. `upstreamHeaders()` below
 * applies both in the same pass so a future edit cannot introduce one without the
 * other.
 *
 * The client's own `Origin` is dropped rather than rewritten: the upstream fence
 * accepts a missing `Origin` (it returns `true`), and rewriting would mean
 * claiming an origin the client did not come from. `Sec-Fetch-*` is dropped for
 * the same reason (`cross-site` would fail the fence outright).
 *
 * ## 2. Streaming, not buffering
 *
 * A DSH session renders tokens as they arrive over SSE. Reading the upstream body
 * in full before writing would turn a live stream into one long pause, so the
 * response is `writeHead` + `pipe` and nothing in between. Backpressure comes
 * from `pipe` itself. Every destination gets an `error` listener: an unhandled
 * `error` on a `pipe()` destination leaks the socket and, worse, leaves the
 * client waiting forever.
 *
 * ## Response headers that must not pass
 *
 *   - `set-cookie` carrying an inner credential — never, to anyone
 *     (`inner-auth.js` security red line). Only the device cookie the gateway
 *     itself sets is allowed through, and today the gateway sets it in a pairing
 *     response it generates rather than by proxying.
 *   - `connection` / `keep-alive` / `transfer-encoding` — hop-by-hop headers
 *     belong to each hop. Forwarding `transfer-encoding` while Node recomputes it
 *     corrupts the framing.
 *   - `content-length` on a streamed body is kept only because Node's upstream
 *     sets it, and dropping it would force chunked encoding on responses that do
 *     not need it. It is safe to keep: the bytes are forwarded unchanged.
 *
 * `content-encoding` is deliberately NOT touched. DSH may gzip a response and the
 * proxy never decodes the body, so the header stays truthful end to end
 * (`design.md` §4.1: "注意官方已支持 gzip，代理要正确处理 Content-Encoding，避免二次解压").
 */
import { request as httpRequest } from 'node:http'

import { buildUpstreamCookie, carriesInnerCookie } from './inner-auth.js'

/** Request headers the upstream hop must not see. */
const DROPPED_REQUEST_HEADERS = new Set([
  /* Rewritten (A). */
  'host',
  /* Stripped (B). */
  'origin',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  /* Rewritten (C). */
  'cookie',
  /* Hop-by-hop: framing and connection management belong to each hop, not one
     end-to-end. `expect: 100-continue` in particular must not be forwarded — Node's
     `http.request` answers it locally when it sees one, and forwarding it would
     ask the upstream to negotiate a body this hop already owns. */
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  /* Not a secret, but not something to forward either: the gateway is not a CDN
     and the upstream does not trust header-derived client addresses. */
  'forwarded',
])

/** Response headers removed on the way back. */
const DROPPED_RESPONSE_HEADERS = new Set([
  /* Hop-by-hop. */
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'trailer',
  'upgrade',
])

/**
 * Fields worth forwarding to the upstream, for its own logging: the real source
 * address and the authority the client actually used. `design.md` §4.1 asks for
 * `X-Forwarded-For` to be kept for audit.
 *
 * A pre-existing `X-Forwarded-For` from the Internet is DISCARDED, not appended
 * to: appending is the correct behaviour behind a trusted CDN and a spoofing
 * vector behind nothing. The gateway is the first hop by construction, so it
 * writes the field rather than extending it.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string | undefined} peer Client address.
 * @returns {Record<string, string>}
 */
function forwardingHeaders(req, peer) {
  const headers = {}
  if (typeof peer === 'string' && peer !== '') headers['x-forwarded-for'] = peer
  const host = req.headers?.host
  if (typeof host === 'string' && host !== '') headers['x-forwarded-host'] = host
  headers['x-forwarded-proto'] = 'http'
  /* Marks the request as having crossed the gateway, so a future upstream (or a
     debugging session reading DSH's own logs) can tell the two hops apart without
     inspecting cookies. Carries no identity. */
  headers['x-dsh-remote-control'] = 'gateway'
  return headers
}

/**
 * Build the header set for the upstream hop.
 *
 * Exported because it is the part most worth asserting on: A, B and C in one
 * function, so a test can prove that rewriting `Host` also removes `Origin`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object} options
 * @param {string} options.upstreamHost `127.0.0.1:<port>`.
 * @param {string | undefined} options.innerCookie `name=value`, or undefined when unavailable.
 * @param {string | undefined} options.peer Client address for `X-Forwarded-For`.
 * @returns {import('node:http').OutgoingHttpHeaders}
 */
export function upstreamHeaders(req, options) {
  const source = req !== null && typeof req === 'object' && req.headers !== null ? req.headers : {}
  const headers = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (DROPPED_REQUEST_HEADERS.has(name)) continue
    headers[name] = value
  }

  /* (A) The one authority the upstream will accept. Never the client's Host: the
     fence reads Host to decide trust, so forwarding a LAN name would 403. */
  headers.host = options.upstreamHost

  /* (C) Credential, plus whatever non-inner cookies the device sent. */
  const cookie = buildUpstreamCookie(
    typeof source.cookie === 'string' ? source.cookie : undefined,
    options.innerCookie,
  )
  if (cookie !== undefined) headers.cookie = cookie

  Object.assign(headers, forwardingHeaders(req, options.peer))
  return headers
}

/**
 * Filter response headers before they reach the client.
 *
 * @param {import('node:http').IncomingMessage} upstreamResponse
 * @returns {{ headers: import('node:http').OutgoingHttpHeaders, droppedCookies: number }}
 */
export function downstreamHeaders(upstreamResponse) {
  const headers = {}
  let droppedCookies = 0
  const source = upstreamResponse?.headers ?? {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (DROPPED_RESPONSE_HEADERS.has(name)) continue
    if (name === 'set-cookie') {
      const entries = Array.isArray(value) ? value : [value]
      const kept = entries.filter((entry) => {
        const unsafe = carriesInnerCookie(entry)
        if (unsafe) droppedCookies += 1
        return !unsafe
      })
      if (kept.length > 0) headers['set-cookie'] = kept
      continue
    }
    headers[name] = value
  }
  return { headers, droppedCookies }
}

/**
 * Build an Error with a stable code.
 *
 * @param {string} code
 * @param {string} message Must carry no URL path, no upstream address, no cookie.
 * @returns {Error}
 */
function proxyError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Attach the listeners that keep `pipe()` from leaking.
 *
 * `source.pipe(destination)` forwards `error` from neither side: an error on the
 * destination is unhandled (process-level `uncaughtException` territory) and an
 * error on the source leaves the destination open forever. Both directions are
 * wired here, and the socket is destroyed so the client gets a reset rather than
 * a hang (`.trellis/spec/backend/error-handling.md`).
 *
 * @param {import('node:stream').Readable | import('node:http').IncomingMessage} source
 * @param {import('node:stream').Writable | import('node:http').ServerResponse} destination
 * @param {() => void} onFailure
 * @returns {() => void} detach
 */
function guardPipe(source, destination, onFailure) {
  const handleSourceError = () => onFailure()
  const handleDestinationError = () => {
    /* The upstream body is still being read; destroying it stops the upstream
       socket from sitting in CLOSE_WAIT for the rest of its natural life. */
    source.destroy?.()
    onFailure()
  }
  source.on('error', handleSourceError)
  destination.on('error', handleDestinationError)
  return () => {
    source.off('error', handleSourceError)
    destination.off('error', handleDestinationError)
  }
}

/**
 * Create the proxy.
 *
 * @param {object} options
 * @param {string} options.upstreamOrigin `http://127.0.0.1:<officialPort>`.
 * @param {string} options.upstreamHost `127.0.0.1:<officialPort>` — the `Host` to send.
 * @param {ReturnType<typeof import('./inner-auth.js').createInnerAuth>} options.innerAuth
 * @param {(logger: object, level: 'debug' | 'info' | 'warn' | 'error', message: string) => void} options.emit
 * @param {object} [options.logger]
 * @param {number} [options.timeoutMs] Upstream response timeout.
 * @returns {{
 *   forward: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, peer?: string) => Promise<void>,
 * }}
 */
export function createProxy(options) {
  const upstreamOrigin = options.upstreamOrigin
  const upstreamHost = options.upstreamHost
  const innerAuth = options.innerAuth
  const emit = typeof options.emit === 'function' ? options.emit : () => {}
  const logger = options.logger
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120_000

  /** Parse the upstream origin once; `http.request` needs host/port, not a URL. */
  const upstreamUrl = new URL(upstreamOrigin)

  /**
   * Send one request to the upstream and resolve with the response head.
   *
   * `agent: false` per request: a pooled socket reused across two streaming
   * responses is a class of bug (interleaved bodies) not worth the connect savings
   * on a loopback hop.
   *
   * The timeout covers the WAIT FOR THE RESPONSE HEAD only. Once the head arrives
   * it is cleared, because a session stream can legitimately sit silent for a long
   * time between events and a socket-inactivity timeout would sever a perfectly
   * healthy SSE connection. A client that goes away is detected by `res`'s own
   * `close`, which is the right signal for a live stream.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {string | undefined} innerCookie
   * @param {string | undefined} peer
   * @returns {Promise<import('node:http').IncomingMessage>}
   */
  function send(req, innerCookie, peer) {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }

      const upstreamRequest = httpRequest({
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req, { upstreamHost, innerCookie, peer }),
        agent: false,
      })

      upstreamRequest.setTimeout(timeoutMs, () => {
        upstreamRequest.destroy(proxyError('gateway/upstream-timeout', 'the upstream did not answer in time'))
      })
      upstreamRequest.on('error', (error) => {
        settle(reject, error instanceof Error ? error : proxyError('gateway/upstream-failed', 'the upstream request failed'))
      })
      upstreamRequest.on('response', (upstreamResponse) => {
        /* The head is in: stop policing idle time, or a stream with a long pause
           between events would be severed mid-flight. */
        upstreamRequest.setTimeout(0)
        settle(resolve, upstreamResponse)
      })

      /* Body: streamed, never buffered. `pipe` gives backpressure for free; the
         request's own `error` is handled so a client that aborts mid-upload does
         not leave an unhandled error behind. */
      req.on('error', () => {
        upstreamRequest.destroy()
      })
      req.pipe(upstreamRequest)
    })
  }

  /**
   * Proxy one authorized request.
   *
   * Resolves when the response has been fully written or abandoned. Never throws:
   * a proxy failure becomes a 502 (or a destroy if the head is already out),
   * because `.trellis/spec/backend/error-handling.md` is explicit that an
   * exception escaping a handler reaches the client as a connection reset.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string | undefined} [peer] Client address for `X-Forwarded-For`.
   * @returns {Promise<{ status: number, body: string | null }>} summary for audit/logging.
   */
  async function forward(req, res, peer) {
    let innerCookie
    try {
      innerCookie = await innerAuth.header()
    } catch {
      /* `header()` is written not to throw, but a request path may not depend on
         that: a throw here would kill the request with no response at all. */
      innerCookie = undefined
    }

    let upstreamResponse
    try {
      upstreamResponse = await send(req, innerCookie, peer)
    } catch {
      emit(logger, 'warn', `[remote-control] upstream request failed for ${describeMethod(req)}`)
      writeFailure(res, 502, 'gateway/upstream-unreachable', 'The dsh web instance did not answer.')
      return { status: 502, body: null }
    }

    const staleCredential = upstreamResponse.statusCode === 401
      && innerCookie !== undefined
      && innerAuth.available()

    if (staleCredential) {
      if (!isBodyless(req)) {
        /* A request whose body has already gone upstream cannot be replayed: the
           stream is consumed, and replaying a truncated one would be worse than
           relaying the 401. `readableEnded` is NOT a safe test — it is also false
           while a body is merely in flight, so it would replay a half-sent upload.
           {@link isBodyless} is provable instead. Declining to retry is always
           safe: the client gets the upstream's own 401, which is the honest answer
           for a request we cannot faithfully repeat. Checked BEFORE invalidating,
           so a request that cannot be retried pays for no credential exchange. */
        emit(logger, 'warn', '[remote-control] not replaying a request that carries a body')
      } else {
        /* DSH restarted, the launch token changed, the cached cookie is stale
           (`design.md` §4.3). Redeem ONCE and retry ONCE — bounded by construction,
           because the retry is not itself retried and there is no loop here. */
        emit(logger, 'warn', '[remote-control] upstream rejected the inner credential; re-minting it once')
        innerAuth.invalidate()

        let retryCookie
        try {
          retryCookie = await innerAuth.header()
        } catch {
          retryCookie = undefined
        }

        if (retryCookie !== undefined) {
          upstreamResponse.destroy()
          try {
            upstreamResponse = await send(req, retryCookie, peer)
          } catch {
            emit(logger, 'warn', '[remote-control] the retry after re-minting the inner credential failed')
            writeFailure(res, 502, 'gateway/upstream-unreachable', 'The dsh web instance did not answer.')
            return { status: 502, body: null }
          }
        }
      }
    }

    return relay(req, upstreamResponse, res)
  }

  /**
   * Stream one upstream response back to the client.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').IncomingMessage} upstreamResponse
   * @param {import('node:http').ServerResponse} res
   * @returns {{ status: number, body: string | null }}
   */
  function relay(req, upstreamResponse, res) {
    const status = typeof upstreamResponse.statusCode === 'number' ? upstreamResponse.statusCode : 502
    const { headers, droppedCookies } = downstreamHeaders(upstreamResponse)
    if (droppedCookies > 0) {
      /* Loud on purpose: the only way an inner credential appears in an upstream
         response is that the upstream re-issued one, and dropping it is a
         security control firing, not routine traffic. */
      emit(
        logger,
        'warn',
        `[remote-control] dropped ${String(droppedCookies)} upstream set-cookie header(s) carrying an inner credential`,
      )
    }

    if (res.headersSent === true) {
      /* Nothing sensible can be written; drop the connection rather than writing
         into an already-committed response. */
      upstreamResponse.destroy()
      res.destroy()
      return { status, body: null }
    }

    try {
      res.writeHead(status, headers)
    } catch {
      upstreamResponse.destroy()
      res.destroy()
      return { status: 502, body: null }
    }

    /* A 204/304 must not carry a body, and Node refuses one; `pipe` on an empty
       stream would still be well-behaved, but ending explicitly is clearer and
       avoids waiting for an upstream 'end' that a bodiless response may not send. */
    if (status === 204 || status === 304 || res.req?.method === 'HEAD') {
      upstreamResponse.resume()
      res.end()
      return { status, body: null }
    }

    const detach = guardPipe(upstreamResponse, res, () => {
      detach()
      upstreamResponse.destroy()
      res.destroy()
    })
    upstreamResponse.once('end', detach)
    res.once('close', () => {
      /* Client went away: stop reading the upstream instead of draining a stream
         whose bytes have nowhere to go. */
      detach()
      upstreamResponse.destroy()
    })
    upstreamResponse.pipe(res)
    return { status, body: null }
  }

  return { forward }
}

/**
 * Whether a request provably carries no body, and can therefore be replayed.
 *
 * Provable, not inferred: no `transfer-encoding` and no non-zero `content-length`.
 * The conservative direction matters — a false negative only declines a retry (the
 * client gets the upstream 401), while a false positive would replay a request with
 * a truncated body, which is a corrupted write sent to DSH.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isBodyless(req) {
  const headers = req?.headers ?? {}
  if (headers['transfer-encoding'] !== undefined) return false
  const declared = headers['content-length']
  if (declared === undefined) return true
  const length = Number(declared)
  return Number.isFinite(length) && length === 0
}

/** A request description safe to log: method and path, never headers. */
function describeMethod(req) {  const method = typeof req?.method === 'string' ? req.method : 'REQUEST'
  /* The path may carry a token in a query string for the pairing flow, so only
     the pathname is logged. */
  let pathname = ''
  try {
    pathname = new URL(req?.url ?? '/', 'http://x').pathname
  } catch {
    pathname = ''
  }
  return `${method} ${pathname}`
}

/**
 * Write a proxy failure the way the spec requires: a status and a sentence, never
 * an internal detail, and never a second `writeHead`.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function writeFailure(res, status, code, message) {
  if (res.headersSent === true) {
    res.destroy()
    return
  }
  const body = Buffer.from(JSON.stringify({ ok: false, error: { code, message } }), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}
