/**
 * dsh-remote-control — the WebSocket upgrade passthrough (stage 3).
 *
 * `design.md` §4.2: the live streaming channel is a single multiplexed
 * WebSocket on `/api/remote.mux`, opened by `WebSocketServer({ noServer: true })`
 * and hooked to the official server's `upgrade` event. An HTTP reverse proxy
 * cannot carry it, so the gateway terminates nothing and forwards bytes.
 *
 * ## No `ws` dependency, and why that is not a compromise
 *
 * Measured (`research/official-connection-fence.md` §6.1): speaking the handshake
 * by hand over `node:net` works — connect, write the request line and headers,
 * read the `101`, then pipe both directions. The gateway never parses a frame, so
 * a frame parser would be dead weight. `package.json` stays at zero runtime
 * dependencies, which `tests/package.test.mjs` locks.
 *
 * That choice pushes four obligations onto this module, and each one has a test:
 *
 *   - **A handshake is a request, not a stream.** The upstream fence runs on it
 *     exactly as it does for HTTP, so the same three rewrites apply (A: `Host` →
 *     `127.0.0.1:<officialPort>`, B: drop `Origin`/`Sec-Fetch-*`, C: attach the
 *     inner `dsh-auth-*` cookie). {@link upgradeHeaders} reuses
 *     `proxy.js`'s `upstreamHeaders()` rather than restating them, so the two hops
 *     cannot drift apart.
 *   - **The origin fence must be the strict one.** An upgrade is a `GET`, but a
 *     browser sends no CORS preflight for a `WebSocket` and is not obliged to send
 *     `Sec-Fetch-Site`. The read arms of `checkOrigin` would therefore admit a
 *     handshake carrying a live `Origin: http://evil.example` — CSWSH. That
 *     decision is not made here: `auth.js` `authorize()` is called with
 *     `upgrade: true` and picks `checkUpgradeOrigin()`. This module only acts on
 *     the verdict (`quality-guidelines.md` §8 — one decision point).
 *   - **A wait across a process boundary needs a deadline** (§10). The upstream
 *     may accept the TCP connection and never answer; `UPGRADE_HEAD_TIMEOUT_MS`
 *     bounds the wait for the head. Once `101` arrives the deadline is cleared,
 *     because a healthy multiplexed stream is silent between events by design.
 *   - **Disconnect does not always emit `error`** (§11). Both ends get an `error`
 *     AND a `close` outlet, so a LAN client that opens and drops handshakes cannot
 *     pin one upstream socket per drop.
 *
 * ## Revocation must close live sockets (`prd.md` constraint 5)
 *
 * "吊销必须即时生效" cannot be satisfied by re-checking cookies on new requests
 * alone: an upgraded socket was authorized once and would otherwise outlive the
 * revocation indefinitely — a revoked phone with the session still streaming.
 * Every admitted socket is therefore registered in {@link createSocketRegistry}
 * under its device id, **before** the first `await`, and `sockets.closeDevice(id)`
 * tears the live ones down. `server.js` exposes that through
 * `gateway.revokeDevice()`, which is the single entry point stage 4's admin API
 * will call.
 *
 * ## Failure policy
 *
 * Every path ends in "both sockets destroyed", never in a forwarded request:
 * a refusal, a bad status, an oversized head, a timeout and a connect failure all
 * fail closed (`.trellis/spec/backend/error-handling.md` — the upgrade path has no
 * response body to write, so destroying the socket IS the error response).
 * `handle()` itself is synchronous and never throws; the asynchronous part is
 * wrapped so a rejection cannot reach the server's `upgrade` listener.
 */
import { connect as netConnect } from 'node:net'

import {
  UPGRADE_HEAD_TIMEOUT_MS,
  UPGRADE_MAX_SUBPROTOCOL_LENGTH,
} from '../constants.js'
import { upstreamHeaders } from './proxy.js'

/** Size cap on the upstream's response head, so a hostile upstream cannot exhaust memory. */
const MAX_HEAD_BYTES = 16 * 1024

/** The delimiter that ends an HTTP head. */
const HEAD_END = '\r\n\r\n'

/** How long a clean upstream close may wait for the client to flush before being forced down. */
const LINGER_MS = 1_000

/**
 * Parse the status code out of an HTTP response head.
 *
 * Exported for tests: the decision "is this a `101`" is the whole branch, and it is
 * worth asserting without a socket.
 *
 * @param {string} headText First bytes of the response, as latin1.
 * @returns {number | null} The three-digit status, or null when unparsable.
 */
export function parseStatusLine(headText) {
  if (typeof headText !== 'string') return null
  const end = headText.indexOf('\r\n')
  const line = end === -1 ? headText : headText.slice(0, end)
  /* `.match()` rather than a stateful `RegExp` method: the package invariant test
     forbids shell-out patterns anywhere in the host half, and a comment that spells
     one out is a false positive in that guard rather than an exception worth
     carving. */
  const match = line.match(/^HTTP\/1\.[01] (\d{3})/)
  return match === null ? null : Number(match[1])
}

/**
 * Build the header set for the upstream upgrade hop.
 *
 * `proxy.js`'s {@link upstreamHeaders} already performs (A) the `Host` rewrite,
 * (B) the `Origin`/`Sec-Fetch-*` strip, (C) the inner-cookie attach and the
 * forwarding-header hygiene (including "drop the client's `x-forwarded-*` before
 * synthesizing our own"). Reusing it is the point: a second, hand-written header
 * builder on this path is how the two hops end up disagreeing about what the
 * official fence requires.
 *
 * What is added back is exactly what makes it a handshake:
 *
 *   - `connection: Upgrade` and `upgrade: websocket`, which `upstreamHeaders`
 *     drops as hop-by-hop because on the HTTP path they must not cross. Here this
 *     hop IS the one opening the upgrade, so it writes its own.
 *   - a bound on `sec-websocket-protocol` / `sec-websocket-extensions`: both are
 *     attacker-chosen strings copied into a head this hop synthesizes, so an
 *     oversized one is dropped rather than forwarded (`quality-guidelines.md` §9 —
 *     a field this hop writes is not the client's to make arbitrarily large).
 *   - no `content-length` / `content-type`: a handshake carries no body, and
 *     forwarding a `content-length` would tell the upstream to wait for bytes that
 *     will never arrive.
 *
 * `sec-websocket-key`, `-version`, `-protocol` and `-extensions` survive
 * `upstreamHeaders` untouched (they are end-to-end between the browser and DSH; a
 * byte-forwarding hop is transparent to both framing and `permessage-deflate`).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object} options
 * @param {string} options.upstreamAuthority `127.0.0.1:<officialPort>`.
 * @param {string | undefined} options.innerCookie `name=value` from `inner-auth`.
 * @param {string | undefined} options.peer Client address for `X-Forwarded-For`.
 * @returns {Record<string, string | string[]>}
 */
export function upgradeHeaders(req, options) {
  const headers = upstreamHeaders(req, {
    upstreamHost: options.upstreamAuthority,
    innerCookie: options.innerCookie,
    peer: options.peer,
  })

  /* A handshake has no entity body. Forwarding either field would make the
     upstream block waiting for a body this hop never sends. */
  delete headers['content-length']
  delete headers['content-type']

  /* Bound the two browser-chosen protocol headers before copying them. Dropping an
     oversized list costs the client its subprotocol (it falls back to no protocol),
     which is a smaller failure than forwarding an attacker-sized header. */
  for (const name of ['sec-websocket-protocol', 'sec-websocket-extensions']) {
    const value = headers[name]
    const length = typeof value === 'string' ? value.length : Array.isArray(value) ? value.join(',').length : 0
    if (length > UPGRADE_MAX_SUBPROTOCOL_LENGTH) delete headers[name]
  }

  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'
  return headers
}

/**
 * Render the request head that opens the upstream handshake.
 *
 * `path` is the client's request target, which carries the query the official
 * mux registers on, so it is forwarded verbatim — but CR/LF is stripped, because
 * a header-injection-shaped path must not be able to add lines to a head this hop
 * builds by concatenation.
 *
 * @param {string} path
 * @param {Record<string, string | string[]>} headers
 * @returns {string}
 */
export function serializeUpgradeRequest(path, headers) {
  const target = typeof path === 'string' && path !== '' ? path.replace(/[\r\n]/g, '') : '/'
  const lines = [`GET ${target} HTTP/1.1`]
  /* `host` first only for readability; the upstream does not care about order. */
  const names = Object.keys(headers)
  const ordered = ['host', ...names.filter((name) => name !== 'host')]
  for (const name of ordered) {
    if (!Object.hasOwn(headers, name)) continue
    const value = headers[name]
    const values = Array.isArray(value) ? value : [value]
    for (const entry of values) {
      if (entry === undefined || entry === null) continue
      lines.push(`${name}: ${String(entry).replace(/[\r\n]/g, ' ')}`)
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * Render a minimal refusal for a socket that will never become a WebSocket.
 *
 * `design.md` §3.3 says a refused upgrade gets `socket.destroy()` and no response
 * body, and that is honoured: the head carries `content-length: 0` and nothing
 * follows it. A status LINE is still written, because "Unexpected response code:
 * 401" in a browser console is a diagnosable failure while a bare reset is not —
 * `research/official-connection-fence.md` §6.1 measured both and this is the
 * friendlier of the two without weakening anything.
 *
 * No code, path, host or credential appears in the head: the only thing a refused
 * caller learns is the status class.
 *
 * @param {import('node:net').Socket} socket
 * @param {number} status
 * @returns {boolean} whether the socket was written to.
 */
export function refuseUpgrade(socket, status) {
  if (socket === null || typeof socket !== 'object') return false
  if (socket.destroyed === true || typeof socket.write !== 'function') return false
  const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 403
  const reason = code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : code === 502 ? 'Bad Gateway' : 'Refused'
  const head = `HTTP/1.1 ${String(code)} ${reason}\r\n`
    + 'connection: close\r\n'
    + 'content-length: 0\r\n'
    + 'cache-control: no-store\r\n'
    + '\r\n'
  try {
    socket.end(head)
    /* `end` flushes and FINs; forcing the handle down on `finish` keeps a client
       that never reads from pinning the socket, without truncating the head. */
    socket.once?.('finish', () => {
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
    })
    return true
  } catch {
    try {
      socket.destroy()
    } catch {
      /* already gone */
    }
    return false
  }
}

/**
 * The registry of admitted sockets, keyed by device.
 *
 * Exists for one requirement and is deliberately tiny: **revoking a device must
 * close its live connections** (`prd.md` constraint 5). An upgraded socket is
 * authorized once and then lives for hours, so a cookie re-check on new requests
 * cannot revoke it — the socket has to be found and destroyed.
 *
 * Sockets admitted under the loopback exemption have no device, so they are kept
 * aside for `closeAll()` (plugin unload) and are never reachable by a device id.
 *
 * `close` callbacks are stored rather than sockets so the caller owns what
 * "closing" means (both ends, in `wsproxy`'s case) and this module stays testable
 * without a net.Socket.
 *
 * @returns {{
 *   track: (deviceId: string | null, close: () => void) => () => void,
 *   closeDevice: (deviceId: string) => number,
 *   closeAll: () => number,
 *   count: () => number,
 *   countFor: (deviceId: string) => number,
 *   stats: { opened: number, closed: number, revoked: number },
 * }}
 */
export function createSocketRegistry() {
  /** @type {Map<string, Set<() => void>>} */
  const byDevice = new Map()

  /** Sockets admitted without a device (the loopback exemption). @type {Set<() => void>} */
  const anonymous = new Set()

  const stats = { opened: 0, closed: 0, revoked: 0 }

  /**
   * Register one live socket.
   *
   * @param {string | null} deviceId Owning device, or null for the loopback exemption.
   * @param {() => void} close Idempotent closer for that socket.
   * @returns {() => void} detach — call it when the socket ends, or the set grows forever.
   */
  function track(deviceId, close) {
    if (typeof close !== 'function') return () => {}
    const key = typeof deviceId === 'string' && deviceId !== '' ? deviceId : null
    let bucket
    if (key === null) {
      bucket = anonymous
    } else {
      bucket = byDevice.get(key)
      if (bucket === undefined) {
        bucket = new Set()
        byDevice.set(key, bucket)
      }
    }
    bucket.add(close)
    stats.opened += 1
    let detached = false
    return () => {
      if (detached) return
      detached = true
      bucket.delete(close)
      /* Dropping the empty bucket keeps the map converging: an attacker-chosen
         device id is not a key here (ids come from the store), but a table that
         grows with every connection would still be a leak on a long-lived host. */
      if (key !== null && bucket.size === 0) byDevice.delete(key)
      stats.closed += 1
    }
  }

  /**
   * Close every live socket belonging to one device.
   *
   * This is the "即时生效" half of revocation. Called from
   * `server.js`'s `revokeDevice()`, i.e. from whatever the stage-4 panel invokes.
   *
   * @param {string} deviceId
   * @returns {number} how many sockets were closed.
   */
  function closeDevice(deviceId) {
    if (typeof deviceId !== 'string' || deviceId === '') return 0
    const bucket = byDevice.get(deviceId)
    if (bucket === undefined) return 0
    let closed = 0
    /* A copy: each closer detaches itself, which would mutate the set mid-iteration. */
    for (const close of [...bucket]) {
      try {
        close()
        closed += 1
      } catch {
        /* A closer that throws must not stop the others: a revocation has to close
           every socket, not most of them. */
      }
    }
    byDevice.delete(deviceId)
    stats.revoked += closed
    return closed
  }

  /**
   * Close every live socket. Used by the plugin disposer: `server.close()` waits
   * for keep-alive HTTP sockets, and Node's `closeAllConnections()` explicitly
   * does NOT touch sockets that have been upgraded — so without this a hot-reload
   * would leave the old listeners' streams running.
   *
   * @returns {number}
   */
  function closeAll() {
    let closed = 0
    for (const deviceId of [...byDevice.keys()]) closed += closeDevice(deviceId)
    for (const close of [...anonymous]) {
      try {
        close()
        closed += 1
      } catch {
        /* see above */
      }
    }
    anonymous.clear()
    return closed
  }

  /** Total live sockets, device-owned and exempt alike. */
  function count() {
    let total = anonymous.size
    for (const bucket of byDevice.values()) total += bucket.size
    return total
  }

  /**
   * Live sockets for one device.
   *
   * @param {string} deviceId
   * @returns {number}
   */
  function countFor(deviceId) {
    return byDevice.get(deviceId)?.size ?? 0
  }

  return { track, closeDevice, closeAll, count, countFor, stats }
}

/**
 * Create the upgrade proxy.
 *
 * @param {object} options
 * @param {string} options.upstreamAuthority `127.0.0.1:<officialPort>` — the hop's authority.
 * @param {string} options.upstreamHost Hostname to connect to (`127.0.0.1`).
 * @param {number} options.upstreamPort Port to connect to (the official port).
 * @param {ReturnType<typeof import('./inner-auth.js').createInnerAuth>} options.innerAuth
 * @param {(logger: object, level: 'debug' | 'info' | 'warn' | 'error', message: string) => void} options.emit
 * @param {object} [options.logger]
 * @param {number} [options.headTimeoutMs] Deadline for the upstream's response head.
 * @param {number} [options.lingerMs] Grace for a clean upstream close to be flushed.
 * @param {(deviceId: string | null) => void} [options.onAdmitted] Called once per completed handshake.
 * @returns {{
 *   handle: (input: { req: object, socket: object, head?: Buffer | null, verdict: object, peer?: string }) => void,
 *   refuse: (socket: object, status: number) => boolean,
 *   sockets: ReturnType<typeof createSocketRegistry>,
 * }}
 */
export function createUpgradeProxy(options) {
  const upstreamAuthority = options.upstreamAuthority
  const upstreamHost = typeof options.upstreamHost === 'string' ? options.upstreamHost : '127.0.0.1'
  const upstreamPort = Number.isInteger(options.upstreamPort) ? options.upstreamPort : 0
  const innerAuth = options.innerAuth
  const emit = typeof options.emit === 'function' ? options.emit : () => {}
  const logger = options.logger
  const headTimeoutMs = Number.isFinite(options.headTimeoutMs) && options.headTimeoutMs > 0
    ? options.headTimeoutMs
    : UPGRADE_HEAD_TIMEOUT_MS
  const lingerMs = Number.isFinite(options.lingerMs) && options.lingerMs >= 0 ? options.lingerMs : LINGER_MS
  const onAdmitted = typeof options.onAdmitted === 'function' ? options.onAdmitted : () => {}
  const sockets = createSocketRegistry()

  /**
   * Describe a handshake for a log line: method and pathname only, never headers.
   *
   * @param {object} req
   * @returns {string}
   */
  function describe(req) {
    let pathname = ''
    try {
      pathname = new URL(req?.url ?? '/', 'http://x').pathname
    } catch {
      pathname = ''
    }
    return `GET ${pathname === '' ? '/' : pathname}`
  }

  /**
   * Admit one authorized upgrade and proxy it.
   *
   * Called only after `authorize()` returned ALLOW with `upgrade: true`; this
   * function makes no security decision of its own beyond failing closed.
   *
   * @param {object} input
   * @param {object} input.req The upgrade request.
   * @param {object} input.socket The client socket from the `upgrade` event.
   * @param {Buffer | null} [input.head] Bytes already read past the request head.
   * @param {object} input.verdict The `authorize()` verdict (carries the device, if any).
   * @param {string} [input.peer] Client address, for `X-Forwarded-For`.
   */
  function handle(input) {
    const socket = input?.socket
    /* A malformed event is not reachable from Node, but this function is the last
       thing between an `upgrade` event and the process, so it validates. */
    if (socket === null || typeof socket !== 'object' || typeof socket.destroy !== 'function') return
    if (socket.destroyed === true) return

    const deviceId = typeof input?.verdict?.device?.id === 'string' ? input.verdict.device.id : null
    const peer = typeof input?.peer === 'string' ? input.peer : undefined

    /** The upstream leg, once it exists. */
    let upstream = null
    let headTimer = null
    let lingerTimer = null
    let finished = false
    /** Whether the inner credential has already been re-minted for this socket. */
    let retried = false
    /** Whether this hop already answered the client itself (a refusal head). */
    let answeredClient = false
    /** Detaches this socket from the revocation registry. Assigned before any await. */
    let detach = () => {}

    /**
     * Release both legs, exactly once.
     *
     * Idempotent by design: it is reachable from the client's `error`, the
     * client's `close`, the upstream's `error`, the upstream's early `close`, the
     * head deadline, every refusal branch and the revocation registry — several of
     * which can fire for one socket.
     *
     * @param {string} why Short reason, for the debug line. Never the path or a header.
     */
    function teardown(why) {
      if (finished) return
      finished = true
      if (headTimer !== null) {
        clearTimeout(headTimer)
        headTimer = null
      }
      if (lingerTimer !== null) {
        clearTimeout(lingerTimer)
        lingerTimer = null
      }
      detach()
      if (upstream !== null) {
        const leg = upstream
        upstream = null
        /* Remove our listeners first: destroying emits `close`, and re-entering
           teardown from it is harmless but noisy. */
        leg.removeAllListeners()
        try {
          leg.destroy()
        } catch {
          /* already gone */
        }
      }
      /* When this hop already wrote a refusal head, the socket is left to
         `refuseUpgrade`, which ends it and destroys it once the head has flushed.
         Destroying here would truncate the very response that makes the refusal
         diagnosable. */
      if (!answeredClient) {
        try {
          socket.destroy()
        } catch {
          /* already gone */
        }
      }
      emit(logger, 'debug', `[remote-control] upgrade closed (${why}) for ${describe(input?.req)}`)
    }

    /** Destroy only the upstream leg, keeping the client for a retry. */
    function abandonUpstream() {
      if (headTimer !== null) {
        clearTimeout(headTimer)
        headTimer = null
      }
      if (upstream === null) return
      const leg = upstream
      upstream = null
      leg.removeAllListeners()
      try {
        leg.destroy()
      } catch {
        /* already gone */
      }
    }

    /**
     * Refuse the handshake: write the head, then tear down.
     *
     * @param {number} status
     */
    function refuse(status) {
      answeredClient = refuseUpgrade(socket, status) === true
      teardown('refused')
    }

    /* Register BEFORE the first await. The registry is what makes revocation
       immediate: if a revoke lands while the credential exchange is in flight,
       it finds this socket already and destroys it, and `teardown` is idempotent
       so the handshake stops at its next check. Registering after the exchange
       would leave exactly that window open. */
    detach = sockets.track(deviceId, () => teardown('revoked'))

    /* Disconnect does not always emit `error` (`quality-guidelines.md` §11), and on
       an upgraded socket it does not always emit `close` either. MEASURED on this
       Node: while the handshake is in flight the client socket is paused (nobody is
       reading it yet), and a client that calls `destroy()` in that window produces
       exactly one event on the server side — `end`. No `close`, no `error`. Binding
       only `close` (the HTTP hop's fix) would therefore still pin one upstream
       socket per dropped handshake for the whole head timeout, which is the same
       "open one, drop one" attack in its WebSocket spelling. All three are bound,
       and `teardown` is idempotent so the overlap costs nothing. */
    socket.on('error', () => teardown('client-error'))
    socket.on('close', () => teardown('client-close'))
    socket.on('end', () => teardown('client-end'))

    /* A socket the server has a timeout on would otherwise sever a healthy
       multiplexed stream during a quiet period. */
    try {
      socket.setTimeout?.(0)
      socket.setNoDelay?.(true)
    } catch {
      /* a stubbed socket in a test need not support these */
    }

    /**
     * Open the upstream leg and speak the handshake.
     *
     * @param {string | undefined} innerCookie
     */
    function beginHandshake(innerCookie) {
      if (finished) return

      let leg
      try {
        leg = netConnect({ host: upstreamHost, port: upstreamPort })
      } catch {
        teardown('upstream-connect-failed')
        return
      }
      upstream = leg

      /* Covers connect AND the wait for the head. A `net.connect` that is never
         answered and an upstream that accepts and goes quiet are the same failure
         to this hop: `quality-guidelines.md` §10. */
      headTimer = setTimeout(() => teardown('upstream-head-timeout'), headTimeoutMs)
      headTimer.unref?.()

      let buffered = Buffer.alloc(0)
      let decided = false

      function decide(status, headBytes, rest) {
        decided = true
        if (headTimer !== null) {
          clearTimeout(headTimer)
          headTimer = null
        }
        leg.off('data', onData)
        if (status === 101) {
          onSwitchingProtocols(headBytes, rest)
          return
        }
        onUpstreamRefusal(status, innerCookie)
      }

      /** Accumulate until the head is complete, then branch exactly once. */
      function onData(chunk) {
        if (decided || finished) return
        buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
        const at = buffered.indexOf(HEAD_END)
        if (at === -1) {
          /* A head this large is a fault (or a hostile upstream); a real one is a
             few hundred bytes. Failing closed bounds the buffer. */
          if (buffered.length > MAX_HEAD_BYTES) teardown('upstream-head-too-large')
          return
        }
        const headEnd = at + HEAD_END.length
        decide(
          parseStatusLine(buffered.subarray(0, headEnd).toString('latin1')),
          buffered.subarray(0, headEnd),
          buffered.subarray(headEnd),
        )
      }

      leg.on('data', onData)

      leg.on('error', () => teardown('upstream-error'))

      leg.once('connect', () => {
        if (finished) return
        const head = serializeUpgradeRequest(input?.req?.url, upgradeHeaders(input?.req, {
          upstreamAuthority,
          innerCookie,
          peer,
        }))
        try {
          leg.write(head)
        } catch {
          teardown('upstream-write-failed')
        }
      })

      /* An upstream that closes before the head is a failure; one that closes
         after `101` is the end of the stream, bound in `onSwitchingProtocols`. */
      leg.once('close', () => {
        if (finished || decided) return
        teardown('upstream-closed-early')
      })

      /**
       * The handshake succeeded: become a transparent byte pipe.
       *
       * @param {Buffer} headBytes The upstream's `101` head, forwarded verbatim.
       * @param {Buffer} rest Bytes the upstream sent in the same segment.
       */
      function onSwitchingProtocols(headBytes, rest) {
        try {
          socket.setNoDelay?.(true)
          socket.write(headBytes)
          /* Bytes the client pipelined after its request head, and bytes the
             upstream sent after its own head — forwarded before the pumps start,
             so not one byte of either direction is dropped. */
          if (input?.head !== undefined && input?.head !== null && input.head.length > 0) {
            leg.write(input.head)
          }
          if (rest.length > 0) socket.write(rest)
        } catch {
          teardown('passthrough-failed')
          return
        }

        /* Both directions, byte for byte. No frame is inspected, so control frames
           (ping/pong/close) pass through untouched — `design.md` §4.2 requires the
           gateway not to swallow the official heartbeat. */
        leg.pipe(socket)
        socket.pipe(leg)

        try {
          onAdmitted(deviceId)
        } catch {
          /* A bookkeeping callback must never break an established stream. */
        }

        emit(
          logger,
          'debug',
          `[remote-control] upgrade established for ${describe(input?.req)} `
            + `(device ${deviceId ?? 'loopback'})`,
        )

        /* No extra error listeners: the client's is bound above and the leg's
           during the handshake, and both call the idempotent `teardown`. Binding
           them again here would only add listeners to tear down later. */

        leg.once('close', () => {
          if (finished) return
          /* A CLEAN upstream close: `pipe` already ended the client, so destroying
             it here would discard the final frames still in the outgoing buffer.
             `allowHalfOpen` is false on both sockets, so the client's own close
             normally arrives on its own; the linger bound covers a peer that
             holds the half-open connection instead. */
          lingerTimer = setTimeout(() => teardown('upstream-closed'), lingerMs)
          lingerTimer.unref?.()
        })
      }

      /**
       * The upstream refused the handshake.
       *
       * A `401` with an inner credential available is the DSH-restart signature
       * (`design.md` §4.3 — the launch token changed, so the cached cookie is
       * stale). Re-mint ONCE and retry ONCE, bounded by the `retried` flag, which
       * is the same bounded-retry rule the HTTP hop applies.
       *
       * @param {number | null} status
       * @param {string | undefined} usedCookie
       */
      function onUpstreamRefusal(status, usedCookie) {
        const canRetry = status === 401
          && usedCookie !== undefined
          && retried === false
          && innerAuth !== undefined
          && typeof innerAuth.available === 'function'
          && innerAuth.available() === true

        if (!canRetry) {
          emit(
            logger,
            'debug',
            `[remote-control] upstream refused the upgrade for ${describe(input?.req)} `
              + `(status ${String(status ?? 'unparsable')})`,
          )
          /* The client sees the status CLASS, never the upstream's head: an
             upstream `set-cookie` on this path could only ever be credential
             material, and there is no body worth relaying. */
          refuse(status ?? 502)
          return
        }

        retried = true
        emit(
          logger,
          'warn',
          '[remote-control] the upstream rejected the upgrade with 401; re-minting the inner credential once',
        )
        abandonUpstream()
        innerAuth.invalidate()

        Promise.resolve()
          .then(() => innerAuth.header())
          .then((fresh) => {
            if (finished) return
            if (typeof fresh !== 'string' || fresh === '') {
              refuse(status)
              return
            }
            beginHandshake(fresh)
          })
          .catch(() => {
            if (finished) return
            refuse(status)
          })
      }
    }

    /* The credential exchange is the one await between admission and the upstream
       hop. It is bounded inside `inner-auth` (5 s) and made non-fatal here: with no
       credential the handshake is still attempted, and the upstream's 401 is
       reported honestly (`design.md` §4.4 degradation). */
    Promise.resolve()
      .then(() => (innerAuth === undefined ? undefined : innerAuth.header()))
      .then((innerCookie) => {
        if (finished) return
        beginHandshake(typeof innerCookie === 'string' ? innerCookie : undefined)
      })
      .catch(() => {
        if (finished) return
        teardown('credential-exchange-failed')
      })
  }

  return { handle, refuse: refuseUpgrade, sockets }
}
