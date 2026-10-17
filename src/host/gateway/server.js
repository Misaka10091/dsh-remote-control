/**
 * dsh-remote-control — the gateway listener.
 *
 * Owns one `http.Server` on `<0.0.0.0>:<settings.port>`. This listener is the
 * ONLY way in from the LAN (`design.md` §1): the official `dsh web` port stays on
 * `127.0.0.1`, so a request that the gateway refuses never reaches DSH at all.
 *
 * ## What this module owns, and what it deliberately does not
 *
 * It owns the transport: binding, the request lifecycle, mapping an authorization
 * verdict onto a status code, and the disposer. It does NOT decide
 * authorization — that is `auth.js` and only `auth.js` — and it does not know how
 * to forward a byte, which is `proxy.js`. Keeping those apart is what lets the
 * decision be tested without a socket and the proxy without an authorization
 * policy.
 *
 * ## Failure policy (`.trellis/spec/backend/error-handling.md`)
 *
 * Two different rules, and the difference is the point:
 *
 *   - **Startup failures are fatal.** A port that cannot be bound rejects the
 *     listen promise, which fails the Cordis fiber, which the user sees. Catching
 *     it and logging a warning would leave the panel claiming remote access is on
 *     while nothing is listening.
 *   - **Request failures are responses.** The `request` listener below catches
 *     every error a handler can produce and turns it into a status, because an
 *     exception escaping this listener reaches the client as a bare connection
 *     reset with no diagnosable cause.
 *
 * ## Cleanup
 *
 * `ctx.effect()` returns the disposer, so hot-reload and a switched-off plugin
 * both release the port. `closeAllConnections()` is called as well: `server.close()`
 * alone waits for keep-alive sockets to go idle, which can be minutes, and a
 * hot-reload would then fail to rebind (`EADDRINUSE`) while the old listener is
 * still draining. The activity tracker is flushed in the same disposer so the last
 * half-minute of "last seen" data is not lost.
 */
import { createServer } from 'node:http'

import { ACTIVITY_PERSIST_INTERVAL_MS, GATEWAY_BIND_HOST } from '../constants.js'
import { createActivityTracker } from './activity.js'
import {
  DECISION,
  authorize,
  codeFor,
  isAllowed,
  messageFor,
  peerAddress,
  statusFor,
} from './auth.js'
import { createInnerAuth } from './inner-auth.js'
import { createProxy } from './proxy.js'
import { clearDeviceCookie, emit, sendError, sendHtml, wantsHtml } from './wire.js'

/**
 * Build the upstream coordinates for the official port.
 *
 * `127.0.0.1` and not `localhost`: the official fence classifies the authority by
 * hostname, `localhost` would resolve fine, but a literal 127.0.0.1 cannot be
 * hijacked by a hosts-file entry and matches what `dsh web` prints.
 *
 * @param {number} officialPort
 * @returns {{ origin: string, host: string }}
 */
export function upstreamFor(officialPort) {
  const port = Number.isInteger(officialPort) && officialPort > 0 ? officialPort : 0
  return { origin: `http://127.0.0.1:${String(port)}`, host: `127.0.0.1:${String(port)}` }
}

/**
 * Start the gateway.
 *
 * @param {object} options
 * @param {object} options.ctx Cordis context (for `ctx.effect` and `ctx.get`).
 * @param {ReturnType<typeof import('../store.js').createStore>} options.store
 * @param {number} options.officialPort Port of the official `dsh web` listener.
 * @param {number} options.port Port to bind; 0 asks the OS for one (used by tests).
 * @param {string} [options.host] Bind address; defaults to all interfaces.
 * @param {string} options.cookieName Device cookie name.
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @param {typeof globalThis.fetch} [options.fetchImpl] Injectable for tests.
 * @param {number} [options.activityIntervalMs] Persist throttle; injectable for tests.
 * @param {number} [options.upstreamTimeoutMs] Bound on the wait for an upstream response head.
 * @param {number} [options.innerAuthTimeoutMs] Bound on one inner-credential exchange.
 * @param {object} [options.logger]
 * @returns {Promise<{
 *   server: import('node:http').Server,
 *   port: number,
 *   host: string,
 *   upstream: { origin: string, host: string },
 *   innerAuth: ReturnType<typeof createInnerAuth>,
 *   activity: ReturnType<typeof createActivityTracker>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startGateway(options) {
  const ctx = options.ctx
  const store = options.store
  const port = Number.isInteger(options.port) ? options.port : 0
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : GATEWAY_BIND_HOST
  const cookieName = options.cookieName
  const now = typeof options.now === 'function' ? options.now : Date.now
  const logger = options.logger
  const upstream = upstreamFor(options.officialPort)

  const activity = createActivityTracker({
    touch: (id) => store.touchDevice(id),
    now,
    intervalMs: Number.isFinite(options.activityIntervalMs)
      ? options.activityIntervalMs
      : ACTIVITY_PERSIST_INTERVAL_MS,
  })

  /* `ctx.get('connection')` and never `ctx.connection`, and never in `inject`:
     the service is OPTIONAL (`design.md` §9, quality-guidelines §6). Declaring it
     required would park the whole plugin — device panel included — in PENDING on a
     host that does not provide it, when the correct behaviour is a degraded
     gateway that passes the upstream 401 through and says so once. */
  const innerAuth = createInnerAuth({
    getConnection: () => (typeof ctx?.get === 'function' ? ctx.get('connection') : undefined),
    upstreamOrigin: upstream.origin,
    fetchImpl: options.fetchImpl,
    now,
    emit,
    logger,
    exchangeTimeoutMs: options.innerAuthTimeoutMs,
  })

  const proxy = createProxy({
    upstreamOrigin: upstream.origin,
    upstreamHost: upstream.host,
    innerAuth,
    emit,
    logger,
    timeoutMs: options.upstreamTimeoutMs,
  })

  /**
   * Answer one request.
   *
   * The flow is linear and every branch ends in a response or a proxy call:
   *
   *   1. authorize (the single decision point);
   *   2. refused → the mapped status, HTML for a navigation, plus the cookie
   *      deletion when the device was revoked;
   *   3. allowed → record activity, then proxy.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function handle(req, res) {
    const peer = peerAddress(req?.socket)
    let verdict
    try {
      verdict = authorize({ req, store, cookieName })
    } catch (error) {
      /* Store damage (`store/corrupt`) surfaces here. Answering 500 rather than
         letting it escape keeps the response diagnosable; the plugin already
         failed loudly at mount time, so reaching this means the file was damaged
         while running. */
      emit(
        logger,
        'error',
        `[remote-control] authorization failed: ${describeError(error)}`,
      )
      sendError(res, 500, 'gateway/internal', 'The remote gateway could not authorize this request.')
      return
    }

    if (!isAllowed(verdict)) {
      respondRefused(req, res, verdict)
      return
    }

    /* Activity is recorded only for a device, and only AFTER the decision: the
       loopback exemption has no device, and a refused request is not activity.
       `record` is throttled (7.06 ms per unthrottled write — see `activity.js`). */
    if (verdict.device !== null && verdict.device !== undefined) {
      activity.record(verdict.device.id)
    }

    proxy
      .forward(req, res, peer)
      .catch(() => {
        /* `forward` is written not to reject, but a rejection must not escape the
           request listener either. With the head already sent the only correct move
           is to drop the connection. */
        emit(logger, 'error', '[remote-control] the proxy rejected unexpectedly')
        if (res.headersSent === true) res.destroy()
        else sendError(res, 502, 'gateway/proxy-failed', 'The remote gateway could not complete this request.')
      })
  }

  /**
   * Write the refusal for a verdict.
   *
   * HTML for a browser navigation (a phone opening the URL must read something
   * useful), JSON for everything else — an XHR receiving a page would surface as a
   * parse error far from the cause.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ decision: string, reason: string | null }} verdict
   */
  function respondRefused(req, res, verdict) {
    const status = statusFor(verdict.decision)
    const code = codeFor(verdict.decision, verdict.reason)
    const message = messageFor(verdict.decision, verdict.reason)

    /* A revoked device's browser should stop presenting a credential that can
       never work again, so the cookie is expired in the same response. Clearing it
       on a plain 401 would also be harmless, but doing it only here keeps the
       signal meaningful: the presence of the deletion means "your device was
       revoked", not "you were never paired". */
    const headers = verdict.decision === DECISION.REVOKED
      ? { 'set-cookie': clearDeviceCookie(cookieName) }
      : undefined

    if (wantsHtml(req)) {
      sendHtml(res, status, code, message, headers)
      return
    }
    sendError(res, status, code, message, headers)
  }

  const server = createServer((req, res) => {
    /* Belt and braces: `handle` catches its own failures, but a throw from a
       listener that runs BEFORE the async body (a malformed request Node hands us
       anyway) must still not reach the process. */
    try {
      handle(req, res)
    } catch (error) {
      emit(logger, 'error', `[remote-control] unhandled request failure: ${describeError(error)}`)
      if (res.headersSent === true) res.destroy()
      else sendError(res, 500, 'gateway/internal', 'The remote gateway failed to handle this request.')
    }
  })

  /* A client that disconnects mid-request surfaces as a socket error. Without a
     listener Node treats it as unhandled and takes the process down, which would
     let one flaky phone kill remote access for everyone. */
  server.on('clientError', (error, socket) => {
    if (socket !== null && typeof socket === 'object' && socket.writable === true) {
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
    } else {
      socket?.destroy?.()
    }
    emit(logger, 'debug', `[remote-control] client error: ${describeError(error)}`)
  })

  /* Bound and listening, or the promise rejects and the fiber fails. No catch
     here on purpose (`error-handling.md`: a port that is in use must be fatal). */
  await new Promise((resolve, reject) => {
    const onFailure = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onFailure)
      resolve(undefined)
    }
    server.once('error', onFailure)
    server.once('listening', onListening)
    server.listen(port, host)
  })

  /* An error AFTER a successful listen (an accept failure, a TLS-less socket
     surprise) must not crash the host process: log it. */
  server.on('error', (error) => {
    emit(logger, 'error', `[remote-control] gateway server error: ${describeError(error)}`)
  })

  const address = server.address()
  const boundPort = address !== null && typeof address === 'object' ? address.port : port

  const close = () => new Promise((resolve) => {
    if (server.listening === false) {
      resolve(undefined)
      return
    }
    server.close(() => resolve(undefined))
    /* Force every keep-alive socket down: `close()` waits for idle, and a
       hot-reload cannot rebind a port the old listener still holds. */
    server.closeAllConnections()
  })

  /* The disposer. Registered AFTER the listen succeeds, so a failed start leaves
     nothing to clean up. Everything this module acquired is released here. */
  const dispose = () => {
    /* The last half-minute of activity would otherwise be lost. */
    try {
      activity.dispose()
    } catch {
      /* A flush during unload must never throw out of the disposer. */
    }
    return close()
  }

  if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'remote-control: gateway listener')
  }

  return {
    server,
    port: boundPort,
    host,
    upstream,
    innerAuth,
    activity,
    close,
  }
}

/**
 * Render an error for a log line without leaking its message body verbatim.
 *
 * `error.message` from a socket failure is safe (errno text), but including only
 * the code when one exists keeps a store error's message — which could name a path
 * — out of the log.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error === null || typeof error !== 'object') return 'unknown error'
  if (typeof error.code === 'string' && error.code !== '') return error.code
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return 'unknown error'
}
