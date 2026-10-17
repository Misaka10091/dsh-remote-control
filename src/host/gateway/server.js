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
 * still draining. That call does NOT cover upgraded sockets, so
 * `upgradeProxy.sockets.closeAll()` runs immediately before it. The activity
 * tracker is flushed in the same disposer so the last half-minute of "last seen"
 * data is not lost.
 *
 * ## Two transports, one decision
 *
 * HTTP requests go through `proxy.forward`. WebSocket handshakes go through
 * `handleUpgrade` → `authorize({ upgrade: true })` → `upgradeProxy.handle`. Both
 * call the SAME `authorize()`; the `upgrade` flag only swaps which origin fence
 * runs (`checkUpgradeOrigin`, strictly; see `origin.js` for why an upgrade cannot
 * use the read arms). No second decision path exists, which is the property
 * `quality-guidelines.md` §8 demands.
 *
 * ## The pairing bootstrap is the one route authorize() does not gate
 *
 * A device being paired has no cookie by definition, so `authorize()` cannot stand
 * in front of `/remote-control/pair` — the exemption is unavoidable. It is also the
 * exact shape of the two defects this project already paid for (the stage-2 loopback
 * exemption and the stage-3 read arms), so it is confined to one module
 * (`pairing-route.js`) and one path, and the reasoning is written there. The short
 * version: those defects were holes because the gateway INJECTS the inner
 * credential and STRIPS `Origin` on its way upstream, so an exempted request arrived
 * at DSH as an authenticated write. The pairing routes never reach `proxy.js` at
 * all — they answer from process memory — so the exemption waives the credential
 * and nothing else, the origin fence still runs in full, and `settings.enabled` is
 * re-read per request so a switched-off gateway mints nothing.
 *
 * ## The admin API is refused here, and that refusal is load-bearing
 *
 * `prd.md` R4: pairing grants session access, not administration. The admin API
 * is registered on the OFFICIAL loopback server (`api.js`), so it is not
 * reachable from the LAN at all — but this hop must still refuse the prefix
 * explicitly, and the reason is subtle enough to spell out:
 *
 *   the gateway forwards from loopback with `Host` rewritten to
 *   `127.0.0.1:<officialPort>` (`design.md` §4.4 item A). So if a remote request
 *   for `/remote-control/api/...` were proxied, the official server would see it
 *   arrive over a loopback socket with a loopback `Host` — i.e. it would satisfy
 *   `isLoopback()` and its own admin guard would ADMIT it. The "loopback only"
 *   rule would then be verified by the attacker's own proxy hop.
 *
 * Refusing here is therefore the layer that makes the rule true, not a
 * defence-in-depth extra. `ADMIN_API_PREFIX` is a constant shared with `api.js`,
 * so the two cannot disagree about what is being refused.
 *
 * ## Revocation is a Set, not a disk read (`prd.md` constraint 5)
 *
 * The credential is a signed JWT (`research/jwt-device-credential.md`), which
 * cannot be un-signed — a stateless token is valid until `exp` by construction.
 * So this module keeps the other half: a `Set` of revoked device ids, seeded from
 * the store at start and updated by {@link revokeDevice}. The per-request cost is
 * one Set lookup against the verified token's `sub`, and a revocation is visible
 * on the very next request — no TTL, no cache to invalidate, no window.
 *
 * The set exists only in this process and is rebuilt from `devices.json` on every
 * start (`revokedAt !== null` is the durable record), so a restart cannot resurrect
 * a revoked device.
 *
 * ## Audit (`prd.md` R5)
 *
 * Every admitted request is classified by `classify.js` (path prefix + method —
 * this hop does not understand DSH semantics) and recorded through the injected
 * `audit` writer. Only the ACTION and its identifiers are recorded: never a
 * message body, a tool argument, a file's contents, a token or a cookie. The
 * upgrade path records `connect`, and the socket's close records `disconnect`,
 * once.
 */
import { createServer } from 'node:http'

import {
  ACTIVITY_PERSIST_INTERVAL_MS,
  ADMIN_API_PREFIX,
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  GATEWAY_BIND_HOST,
} from '../constants.js'
import { classify, classifyUpgrade } from '../classify.js'
import { loadOrCreateJwtKey } from '../jwt-key.js'
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
import { createPairingRoute, isPairingPath } from './pairing-route.js'
import { createProxy } from './proxy.js'
import { clearDeviceCookie, emit, sendError, sendHtml, wantsHtml } from './wire.js'
import { createUpgradeProxy, refuseUpgrade } from './wsproxy.js'

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
 * @param {Buffer} [options.jwtKey] JWT signing key. Omitted = loaded from
 *   `options.baseDir` (or the store's own `baseDir`, which is where it belongs).
 * @param {string} [options.baseDir] Runtime directory holding `jwt-key`.
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @param {typeof globalThis.fetch} [options.fetchImpl] Injectable for tests.
 * @param {number} [options.activityIntervalMs] Persist throttle; injectable for tests.
 * @param {number} [options.upstreamTimeoutMs] Bound on the wait for an upstream response head.
 * @param {number} [options.innerAuthTimeoutMs] Bound on one inner-credential exchange.
 * @param {number} [options.upgradeHeadTimeoutMs] Bound on the wait for an upstream `101`.
 * @param {number} [options.upgradeLingerMs] Grace for a clean upstream WebSocket close.
 * @param {object} [options.audit] Audit writer (`audit.js`). Omitted = nothing is recorded.
 * @param {object} [options.pairing] Pairing store (`pairing.js`). Omitted = the pairing routes answer 503.
 * @param {(size: number) => Buffer} [options.random] Random-byte source for device ids and JWTs; injectable for tests.
 * @param {object} [options.logger]
 * @returns {Promise<{
 *   server: import('node:http').Server,
 *   port: number,
 *   host: string,
 *   upstream: { origin: string, host: string },
 *   innerAuth: ReturnType<typeof createInnerAuth>,
 *   activity: ReturnType<typeof createActivityTracker>,
 *   upgradeProxy: ReturnType<typeof createUpgradeProxy>,
 *   pairingRoute: ReturnType<typeof createPairingRoute>,
 *   jwtKey: Buffer,
 *   isRevoked: (deviceId: string) => boolean,
 *   revokeDevice: (deviceId: string) => { device: object | null, closedSockets: number },
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
  /* Optional: a host that never mounted an audit writer still gets a gateway.
     `recordSafely` below keeps the call site unconditional, so a future event
     cannot be forgotten just because the writer might be absent. */
  const audit = options.audit !== null && typeof options.audit === 'object' ? options.audit : null

  /* The signing key. Loaded here, at START, and deliberately not caught: a key file
     that exists but cannot be used must refuse to enable remote access
     (`research/jwt-device-credential.md` §3.3). Falling back to an in-memory key
     would work perfectly until the next restart and then silently invalidate every
     paired device — the exact failure the file exists to prevent.
     An injected key wins, so a test can sign tokens for a gateway it is about to
     start without writing a key file first. */
  const jwtKey = Buffer.isBuffer(options.jwtKey)
    ? options.jwtKey
    : loadOrCreateJwtKey({
      baseDir: typeof options.baseDir === 'string' && options.baseDir !== '' ? options.baseDir : store.baseDir,
      random: options.random,
    })

  /**
   * Revoked device ids, in memory (`prd.md` constraint 5).
   *
   * Seeded from the store so a restart cannot resurrect a revoked device, and kept
   * per-process because that is exactly the lifetime a JWT outlives: a token signed
   * before the revocation is still signature-valid, and this Set is what makes it
   * stop working. Rebuilt on the next start from `revokedAt`, which is the durable
   * record — the Set is a cache of the answer, never the answer itself.
   */
  const revokedIds = new Set()
  for (const device of store.listDevices()) {
    if (device.revokedAt !== null) revokedIds.add(device.id)
  }

  /** Whether a device id is revoked. One Set lookup; the hot path's only membership test. */
  function isRevoked(deviceId) {
    return typeof deviceId === 'string' && revokedIds.has(deviceId)
  }


  /**
   * Record one audit event, or nothing at all.
   *
   * A failing audit write must never fail the request that triggered it — the
   * request was already authorized and is about to be served. `audit.record`
   * itself never throws and reports its failures through its own sink; this
   * wrapper additionally survives an `audit` object that is present but broken.
   *
   * @param {{ event: string, deviceId?: string | null, ip?: string | null, meta?: object }} entry
   */
  function recordSafely(entry) {
    if (audit === null || typeof audit.record !== 'function') return
    try {
      audit.record(entry)
    } catch {
      /* see above: auditing is observability, not authorization */
    }
  }

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

  /* Stage 3: the multiplexed WebSocket behind `/api/remote.mux` (`design.md` §4.2).
     It shares ONE `innerAuth` with the HTTP hop on purpose — the credential is
     bound to the upstream authority, so a single redemption covers both, and a
     second cache would double the exchanges after a DSH restart. */
  const upgradeProxy = createUpgradeProxy({
    upstreamAuthority: upstream.host,
    upstreamHost: '127.0.0.1',
    upstreamPort: Number.isInteger(options.officialPort) ? options.officialPort : 0,
    innerAuth,
    emit,
    logger,
    headTimeoutMs: options.upgradeHeadTimeoutMs,
    lingerMs: options.upgradeLingerMs,
  })

  /* Stage 6: the pairing bootstrap. Needs the pairing store (in-memory, from
     `index.js`), the signing key (so it can mint the JWT) and the SAME
     `recordSafely` funnel every other event uses, so a broken audit writer cannot
     turn a successful pairing into a 500 — the device would then hold a cookie it
     was never told about. */
  const pairingRoute = createPairingRoute({
    store,
    pairing: options.pairing,
    cookieName,
    jwtKey,
    record: recordSafely,
    logger,
    random: options.random,
    now,
    maxAgeSeconds: Number.isInteger(options.maxAgeSeconds) && options.maxAgeSeconds > 0
      ? options.maxAgeSeconds
      : DEVICE_COOKIE_MAX_AGE_SECONDS,
  })

  /**
   * Answer one WebSocket upgrade handshake.
   *
   * Runs `authorize` with `upgrade: true`, which routes the origin fence to the
   * strict `checkUpgradeOrigin()` — an upgrade is a `GET`, and the read arms of
   * `checkOrigin` would admit a live `Origin: http://evil.example` with no
   * `Sec-Fetch-Site` (measured on a real handshake, and CSWSH if allowed). The
   * decision still lives in `auth.js` and nowhere else.
   *
   * Every refusal ends in a destroyed socket, never in a forwarded request: a
   * refusal that fell through to the proxy would be the one bug class this whole
   * module exists to prevent.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head Bytes already read past the request head.
   */
  function handleUpgrade(req, socket, head) {
    const peer = peerAddress(socket)
    let verdict
    try {
      verdict = authorize({ req, store, cookieName, key: jwtKey, isRevoked, now, upgrade: true })
    } catch (error) {
      /* Store damage (`store/corrupt`) surfaces here, exactly as on the HTTP path.
         An upgrade has no response body, so the socket is destroyed. */
      emit(logger, 'error', `[remote-control] upgrade authorization failed: ${describeError(error)}`)
      refuseUpgrade(socket, 500)
      return
    }

    if (!isAllowed(verdict)) {
      /* `design.md` §3.3: a refused handshake is not answered with a body. A status
         line is still written because a browser console reporting the code is
         diagnosable while a bare reset is not; no address, path or credential
         appears in it. */
      refuseUpgrade(socket, statusFor(verdict.decision))
      emit(
        logger,
        'debug',
        `[remote-control] upgrade refused (${codeFor(verdict.decision, verdict.reason)})`,
      )
      return
    }

    if (verdict.device !== null && verdict.device !== undefined) {
      activity.record(verdict.device.id)
    }

    /* An admitted handshake is the one moment a remote device genuinely "connects"
       (`design.md` §6). Recorded BEFORE the proxy call so a stream that fails to
       establish is still visible as an attempted connection, and only for a device
       — the loopback exemption has no device to attribute it to.
       `classifyUpgrade` returns `connect` for the multiplexed channel and
       `unknown` for a channel this hop does not recognize: an unrecognized channel
       is still an event, and dropping it would be a silent hole in the trail. */
    const deviceId = verdict.device?.id ?? null
    recordSafely({ event: classifyUpgrade(req?.url), deviceId, ip: peer })

    /* `disconnect` is emitted from the socket's own close, once. `wsproxy` already
       registers the socket in its revocation registry and tears it down from
       `error`/`close`/`end` (§19); binding here as well would be a second listener
       that could fire twice for one socket, so the pairing is done with a flag. */
    if (deviceId !== null) {
      let counted = false
      socket.once('close', () => {
        if (counted) return
        counted = true
        recordSafely({ event: 'disconnect', deviceId, ip: peer })
      })
    }

    upgradeProxy.handle({ req, socket, head, verdict, peer })
  }

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

    /* The admin API lives on the OFFICIAL loopback server (`api.js`), and this hop
       must refuse it explicitly: the gateway rewrites `Host` to the loopback
       upstream authority before forwarding, so a proxied admin request would
       arrive at the official server over a loopback socket with a loopback Host —
       satisfying that API's `isLoopback()` guard. Refusing here is what makes
       `prd.md` R4's boundary real rather than assumed. Answered before
       authorization so a paired device learns the same thing an unpaired one does:
       this path does not exist on this port. */
    if (isAdminPath(req?.url) === true) {
      sendError(res, 403, 'gateway/admin-not-here', 'Device management is only available from this machine.')
      emit(logger, 'debug', '[remote-control] refused an admin API request on the gateway port')
      return
    }

    /* The pairing bootstrap (`design.md` §3.1, `pairing-route.js`). Dispatched
       BEFORE `authorize` because a device being paired has no cookie yet — see the
       module note for why that exemption is safe here and was not safe in stage 2.
       `return` unconditionally: every pairing request is answered by that module,
       so nothing on this path can fall through to the proxy and be laundered into
       an authenticated upstream request. */
    if (isPairingPath(req?.url) === true) {
      pairingRoute.handle(req, res)
      return
    }

    let verdict
    try {
      verdict = authorize({ req, store, cookieName, key: jwtKey, isRevoked, now })
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

    /* The audit line (`prd.md` R5, `design.md` §6). `classify` answers with the
       ACTION and nothing else — path prefix + method, because this hop does not
       understand DSH semantics — and returns `null` for a read, which is not an
       action. An unrecognized write is `unknown`: recorded, never guessed.
       The request body is never read here, which is the structural half of
       "audit records actions, never content". */
    const event = classify(req?.method, req?.url)
    if (event !== null) {
      recordSafely({
        event,
        deviceId: verdict.device?.id ?? null,
        ip: peer,
        /* Identifiers only. `path` is the request target WITHOUT its query string:
           a query can carry a prompt fragment or a file path, and the trail has no
           business holding either. */
        meta: { method: String(req?.method ?? ''), path: pathnameOf(req?.url) },
      })
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

  /* The upgrade listener is attached AFTER `createServer` because it closes over
     the instance; registering it earlier would touch a `const` in its temporal dead
     zone and fail the whole start. */
  server.on('upgrade', (req, socket, head) => {
    /* Same belt-and-braces rule as the request listener: an exception escaping a
       socket event is an unhandled error, and one malformed handshake must not
       take remote access down for everyone. Failing closed means destroying the
       socket, never letting it through. */
    try {
      handleUpgrade(req, socket, head)
    } catch (error) {
      emit(logger, 'error', `[remote-control] unhandled upgrade failure: ${describeError(error)}`)
      try {
        socket?.destroy?.()
      } catch {
        /* already gone */
      }
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
    /* Upgraded sockets first: `server.closeAllConnections()` below deliberately
       does NOT touch them (Node's docs are explicit — that is what
       `closeAllConnections()` does not cover, and an upgraded socket is no longer
       an HTTP connection as far as the server is concerned). Without this, a
       hot-reload leaves the old listener's `/api/remote.mux` streams running
       against a dead authorization decision. */
    try {
      upgradeProxy.sockets.closeAll()
    } catch {
      /* the registry must never make a close fail */
    }
    if (server.listening === false) {
      resolve(undefined)
      return
    }
    server.close(() => resolve(undefined))
    /* Force every keep-alive socket down: `close()` waits for idle, and a
       hot-reload cannot rebind a port the old listener still holds. */
    server.closeAllConnections()
  })

  /**
   * Revoke a device and close its live connections.
   *
   * This is the "即时生效" requirement of `prd.md` constraint 5, and it has THREE
   * halves that cannot be separated:
   *
   *   1. the store marks the device, so the panel and the audit agree and a
   *      restart rebuilds the answer;
   *   2. the in-memory `Set` gains the id, so the NEXT request is refused without
   *      a disk read — and, crucially, so a JWT that is still signature-valid and
   *      still inside its `exp` stops working;
   *   3. every upgraded socket the device holds is destroyed, so the CURRENT
   *      session stops streaming.
   *
   * Doing only the first leaves a revoked phone watching the session and able to
   * send, indefinitely. That is exactly what a stateless JWT would have made
   * permanent, which is why the Set is not an optimisation: it is what makes the
   * JWT design legal under constraint 5.
   *
   * The Set is updated even when `store.revokeDevice` returns null (an unknown id):
   * adding an id that names nothing is harmless, and the alternative — returning
   * early — would let a row deleted by hand survive as a usable credential for a
   * device that a previous revoke had already killed.
   *
   * `store.revokeDevice` is idempotent, so closing sockets on an already-revoked
   * device is harmless and is still done: a socket could in principle have been
   * admitted between the two calls.
   *
   * @param {string} deviceId
   * @returns {{ device: object | null, closedSockets: number }}
   */
  function revokeDevice(deviceId) {
    /* Activity is flushed FIRST: after this call there will be no further request
       from the device to eventually write its final `lastSeenAt` (`activity.js`). */
    try {
      activity.flush(deviceId)
    } catch {
      /* a failed flush must not abort a revocation */
    }
    const device = store.revokeDevice(deviceId)
    /* Before the socket sweep, so a request landing between the two calls already
       meets the Set. */
    if (typeof deviceId === 'string' && deviceId !== '') revokedIds.add(deviceId)
    const closedSockets = upgradeProxy.sockets.closeDevice(deviceId)
    if (closedSockets > 0) {
      emit(
        logger,
        'info',
        `[remote-control] device ${deviceId} revoked; closed ${String(closedSockets)} live connection(s)`,
      )
    }
    return { device, closedSockets }
  }

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
    upgradeProxy,
    pairingRoute,
    jwtKey,
    isRevoked,
    revokeDevice,
    close,
  }
}

/**
 * Whether a request target names the admin API prefix.
 *
 * Shared with `api.js` through `ADMIN_API_PREFIX`, so the route the official
 * server serves and the route this port refuses can never diverge.
 *
 * @param {string | undefined} target
 * @returns {boolean}
 */
export function isAdminPath(target) {
  const pathname = pathnameOf(target)
  return pathname === ADMIN_API_PREFIX || pathname.startsWith(`${ADMIN_API_PREFIX}/`)
}

/**
 * The pathname of a request target, or '' when it cannot be parsed.
 *
 * Used so an audit `meta.path` never carries a query string: a query can contain
 * a prompt fragment or a file path, and the trail must hold neither
 * (`logging-guidelines.md`).
 *
 * @param {string | undefined} target
 * @returns {string}
 */
function pathnameOf(target) {
  if (typeof target !== 'string' || target === '') return ''
  try {
    return new URL(target, 'http://localhost').pathname
  } catch {
    return ''
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
