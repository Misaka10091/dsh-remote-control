/**
 * dsh-remote-control — the admin API (`/remote-control/api/*`).
 *
 * The device panel's only backend (`design.md` §7), and — by security design —
 * the one surface a paired remote device can never reach.
 *
 * ## Two layers, and both are load-bearing
 *
 * `prd.md` R4 draws the boundary this module exists to enforce: **pairing grants
 * session access, not administration**. A phone paired to drive a session must
 * not be able to enumerate, rename or revoke devices. Two independent layers
 * stand between it and this API:
 *
 *   1. **It is not served on the gateway port.** It is registered on the OFFICIAL
 *      `dsh web` server (`ctx.webServer.register`), which stays bound to
 *      `127.0.0.1`. The gateway — the only LAN-facing listener — refuses this
 *      prefix outright (`gateway/server.js`), so a remote request cannot even be
 *      proxied toward it. That refusal is not belt-and-braces, it is REQUIRED:
 *      the gateway forwards from loopback with `Host` rewritten to the loopback
 *      authority, so a proxied admin request would satisfy every test below and
 *      be answered. Without the gateway-side refusal the "loopback only" rule
 *      would be satisfied by the attacker's own proxy hop.
 *   2. **Even on the official port, {@link guard} runs.** `isLoopback` requires
 *      BOTH a loopback socket AND a loopback `Host` (DNS rebinding defence,
 *      `quality-guidelines.md` §8), and the origin fence runs on top of it.
 *
 * ## The origin fence is not skipped for the loopback arm
 *
 * This is the stage-2 defect in a different place, so it is worth stating
 * plainly: an exemption may waive the thing it names and nothing else. Here
 * loopback is the *admission rule*, not an exemption — and the fence still runs,
 * because this server is reachable from a browser and the whole API is
 * state-changing. `quality-guidelines.md` §8's test applies: does this hop
 * supply the proof the caller lacks? It does not — there is no credential being
 * injected and no header being stripped — so the fence is the only thing that
 * distinguishes a same-origin click from a cross-site one, and it must run.
 * It is {@link checkAdminOrigin}: the four-arm HTTP fence plus the panel-marker
 * arm the dsh desktop app's forwarding shell needs (`constants.js` —
 * `PANEL_MARKER_HEADER`, and `origin.js` for the measured reason), and not the
 * upgrade fence, because this API has no upgrade route.
 *
 * ## No `gateway/*` import
 *
 * `directory-structure.md` makes the dependency one-way. Everything this module
 * needs from the transport half lives in the domain half instead:
 * `host/loopback.js` (the local predicate) and `host/origin.js` (the fence).
 * `gateway/auth.js` and `gateway/origin.js` keep their public shapes by
 * re-export, so nothing that already imported them changes.
 *
 * ## Response contract
 *
 * `error-handling.md`: every response is `{ ok: true, data }` or
 * `{ ok: false, error: { code, message } }`. No handler throws — an exception
 * escaping here reaches the official server's listener and becomes a bare
 * connection reset. `headersSent` is checked before every head, so a late
 * failure destroys the response instead of throwing `ERR_HTTP_HEADERS_SENT`.
 */
import { ADMIN_API_PREFIX, AUDIT_EVENTS_MAX_PAGE, DEVICE_ID_PREFIX, PAIRING_ROUTE_PATH } from './constants.js'
import { listLanAddresses, validateAccess } from './addresses.js'
import {
  AUDIT_EVENTS,
  dayKeyOf,
  isAuditEvent,
  parseAuditCursor,
  parseAuditLimit,
} from './audit.js'
import { isLoopback } from './loopback.js'
import { checkAdminOrigin } from './origin.js'

/** Largest JSON body the admin API accepts. Every documented request is a few dozen bytes. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Deadline for reading one request body.
 *
 * `quality-guidelines.md` §10: every await gets a bound. The client here is a
 * loopback browser, but "loopback" is not "cannot hang" — a local process that
 * opens a request and stops writing would otherwise hold a handler (and its
 * socket) until the server's own request timeout, which is minutes.
 */
const BODY_TIMEOUT_MS = 10_000

/** Accepted device id shape: the store's prefix plus a base64url body. */
const DEVICE_ID_PATTERN = new RegExp(`^${DEVICE_ID_PREFIX}[A-Za-z0-9_-]{1,80}$`)

/**
 * Accepted pairing id shape: `pair_` plus a base64url body (`pairing.js` mints
 * 12 characters; the bound is generous so the two cannot drift).
 *
 * The pattern is what keeps a caller-supplied id from being echoed back as a
 * free-form string by the status route: a refused id is a `400`, and only an
 * id of the documented shape is ever answered or repeated in a response.
 */
const PAIR_ID_PATTERN = /^pair_[A-Za-z0-9_-]{1,80}$/

/** Longest device name the panel may set. */
const MAX_DEVICE_NAME_LENGTH = 80

/**
 * Build an Error carrying a stable `code` (see `.trellis/spec/backend/error-handling.md`).
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function adminError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Write one JSON envelope, exactly once.
 *
 * Deliberately not shared with `gateway/wire.js`: that module's job is the
 * gateway's outbound edge (device cookies, HTML for a navigation, upstream
 * header handling), and this one writes exactly two shapes. The single rule they
 * both obey — never `writeHead` twice — is honoured here by the `headersSent`
 * check, and a response that already started is destroyed rather than thrown at.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @returns {boolean} whether anything was written.
 */
function sendJson(res, status, payload) {
  let body
  try {
    body = Buffer.from(JSON.stringify(payload), 'utf8')
  } catch {
    /* A payload we cannot serialize is our bug, not the caller's. Answer with a
       fixed, valid envelope rather than letting the throw escape. */
    body = Buffer.from('{"ok":false,"error":{"code":"admin/internal","message":"internal error"}}', 'utf8')
    status = 500
  }
  if (res.headersSent === true) {
    res.destroy()
    return false
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      /* The panel fetches this from the DSH page's own origin, so no CORS header
         is needed — and none is sent, which keeps a cross-origin reader from
         being able to read a device list even if the fence were ever bypassed. */
    })
    res.end(body)
    return true
  } catch {
    if (res.headersSent !== true) res.destroy()
    else res.destroy()
    return false
  }
}

/**
 * Write the documented error envelope.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code Stable `模块/原因` code.
 * @param {string} message One human-readable sentence with no internals in it.
 * @returns {boolean}
 */
function sendError(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, message } })
}

/**
 * Write an arbitrary body (used by the JSONL export, which is not JSON).
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {Buffer} body
 * @returns {boolean}
 */
function sendRaw(res, status, headers, body) {
  if (res.headersSent === true) {
    res.destroy()
    return false
  }
  try {
    res.writeHead(status, headers)
    res.end(body)
    return true
  } catch {
    res.destroy()
    return false
  }
}

/**
 * Read a request body as text, bounded in size and in time.
 *
 * Both bounds matter and neither is optional:
 *
 *   - the SIZE bound keeps a local client from growing this process's heap;
 *   - the TIME bound keeps a client that stops writing from holding the handler
 *     (§10 — every await gets a deadline).
 *
 * `error`, `close` AND `end` are all handled (§19): a client that aborts does not
 * reliably emit `error`, and an abandoned promise here would leak the socket.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>} Rejects with a stable-`code` Error.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let settled = false

    /** @param {string} code @param {string} message */
    function fail(code, message) {
      if (settled) return
      settled = true
      cleanup()
      reject(adminError(code, message))
    }

    /** @param {string} text */
    function succeed(text) {
      if (settled) return
      settled = true
      cleanup()
      resolve(text)
    }

    function cleanup() {
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('close', onClose)
    }

    function onData(chunk) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail('admin/body-too-large', 'the request body is too large')
        return
      }
      chunks.push(chunk)
    }

    function onEnd() {
      succeed(Buffer.concat(chunks).toString('utf8'))
    }

    function onError() {
      fail('admin/body-unreadable', 'the request body could not be read')
    }

    function onClose() {
      /* `close` without `end` means the client went away mid-body. */
      fail('admin/body-aborted', 'the request was aborted before its body arrived')
    }

    const timer = setTimeout(() => {
      fail('admin/body-timeout', 'the request body did not arrive in time')
    }, BODY_TIMEOUT_MS)
    timer.unref?.()

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('close', onClose)
  })
}

/**
 * Parse a JSON body into an object, or fail with a stable code.
 *
 * An EMPTY body is `{}`: every documented POST has optional fields, and a
 * content-length-0 request is what `fetch(url, { method: 'POST' })` sends.
 *
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function parseBody(text) {
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    /* The parse error is NOT included in the message: it quotes the input, and
       the input is the user's. */
    throw adminError('admin/invalid-json', 'the request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw adminError('admin/invalid-json', 'the request body must be a JSON object')
  }
  return parsed
}

/**
 * Project a stored device onto what the panel may see.
 *
 * `tokenHash` is deliberately absent. It is not the token, but it IS the
 * verifier: anything holding it can be brute-forced offline against a candidate
 * token, and a browser page does not need it for anything. Rebuilding the object
 * rather than deleting one key also means a field added to `devices.json` later
 * is not exposed by accident.
 *
 * @param {{ id: string, name: string, ua: string, createdAt: string | null, lastSeenAt: string | null, revokedAt: string | null }} device
 * @param {number} liveConnections
 * @returns {Record<string, unknown>}
 */
function publicDevice(device, liveConnections) {
  return {
    id: device.id,
    name: device.name,
    ua: device.ua,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    liveConnections,
  }
}

/**
 * Mount the admin API on the official web server.
 *
 * @param {object} options
 * @param {object} options.ctx Cordis context (for `ctx.effect`).
 * @param {{ register?: Function }} options.webServer The official `WebServer` service.
 * @param {ReturnType<typeof import('./store.js').createStore>} options.store
 * @param {ReturnType<typeof import('./pairing.js').createPairingStore>} options.pairing
 * @param {ReturnType<typeof import('./audit.js').createAudit>} options.audit
 * @param {() => ({ revokeDevice: Function, activity: object } | null)} [options.getGateway]
 *   Returns the running gateway, or null while remote access is off. This is how
 *   revocation reaches `gateway.revokeDevice` — the single entry point that both
 *   writes the store AND closes live sockets (`quality-guidelines.md` §18).
 * @param {object} [options.logger]
 * @param {() => { address: string, iface: string, private: boolean }[]} [options.listLanAddresses]
 *   Injectable NIC enumeration. Defaults to the real `os.networkInterfaces()` read;
 *   overridden by tests so an assertion about `GET /state` never depends on the
 *   machine running the suite (`quality-guidelines.md` — injectable side effects).
 * @returns {{ dispose: () => void, available: boolean, guard: Function }}
 */
export function startAdminApi(options) {
  const ctx = options.ctx
  const webServer = options.webServer
  const store = options.store
  const pairing = options.pairing
  const audit = options.audit
  const getGateway = typeof options.getGateway === 'function' ? options.getGateway : () => null
  const logger = options.logger
  const readLanAddresses = typeof options.listLanAddresses === 'function'
    ? options.listLanAddresses
    : () => listLanAddresses()

  /** Report one diagnostic line; never a body, a code, or a token. */
  function log(level, message) {
    if (logger === null || typeof logger !== 'object') return
    const sink = logger[level]
    if (typeof sink === 'function') sink.call(logger, message)
  }

  /**
   * The admission check: loopback, then the origin fence. Fail closed.
   *
   * Exported on the returned handle so a test can exercise the two layers
   * directly as well as over a socket.
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {{ ok: true } | { ok: false, status: number, code: string, message: string }}
   */
  function guard(req) {
    /* Layer 2a: BOTH halves of "this is this machine" — a loopback socket alone is
       satisfiable by DNS rebinding, which is why `Host` is required too. */
    if (!isLoopback(req)) {
      return {
        ok: false,
        status: 403,
        code: 'admin/loopback-only',
        message: 'The remote control admin API is only available from this machine.',
      }
    }
    /* Layer 2b: the fence, on every method and for the loopback arm as well
       (`quality-guidelines.md` §8 — an exemption waives only what it names, and
       this arm waives nothing: it is an admission rule, not an exemption).
       `checkAdminOrigin` and not `checkOrigin`: the desktop app's forwarding shell
       strips `Origin`/`Sec-Fetch-Site`, so the panel's own marker header is the
       only proof a desktop-issued write can carry. The gateway keeps the stricter
       entry — see the note in `gateway/origin.js`. */
    const fence = checkAdminOrigin(req)
    if (!fence.ok) {
      return {
        ok: false,
        status: 403,
        code: 'admin/cross-origin',
        message: 'This request did not come from the dsh web page and was refused.',
      }
    }
    return { ok: true }
  }

  /**
   * Revoke one device through the gateway's single entry point.
   *
   * `quality-guidelines.md` §18 is the whole reason this is a separate function:
   * `store.revokeDevice()` alone marks the row, so `prd.md` constraint 5
   * ("吊销必须即时生效") would be half satisfied — the device would be refused on
   * its NEXT request while its live WebSocket kept streaming. `gateway.revokeDevice`
   * does both, and it is the only path taken when a gateway exists.
   *
   * The store-only branch is reachable exclusively when no gateway is running
   * (remote access off, or a host without a listener). In that state there are no
   * live sockets to close, so the two halves are not being separated — there is
   * only one half.
   *
   * @param {string} deviceId
   * @returns {{ device: object | null, closedSockets: number, via: 'gateway' | 'store' }}
   */
  function revokeDevice(deviceId) {
    const gateway = getGateway()
    if (gateway !== null && typeof gateway === 'object' && typeof gateway.revokeDevice === 'function') {
      const outcome = gateway.revokeDevice(deviceId)
      return {
        device: outcome?.device ?? null,
        closedSockets: Number.isInteger(outcome?.closedSockets) ? outcome.closedSockets : 0,
        via: 'gateway',
      }
    }
    return { device: store.revokeDevice(deviceId), closedSockets: 0, via: 'store' }
  }

  /**
   * Live socket count for a device, or 0 when nothing is listening.
   *
   * @param {string} deviceId
   * @returns {number}
   */
  function liveConnections(deviceId) {
    const gateway = getGateway()
    const sockets = gateway?.upgradeProxy?.sockets
    if (sockets === undefined || typeof sockets.countFor !== 'function') return 0
    try {
      return sockets.countFor(deviceId)
    } catch {
      return 0
    }
  }

  /**
   * The current gateway state, for the panel's "is remote access actually up?" row.
   *
   * `prd.md`'s failure mode to avoid is a panel that says "enabled" while nothing
   * is listening, so this reports the LISTENER's truth, not the setting's.
   *
   * @returns {Record<string, unknown> | null}
   */
  function gatewayState() {
    const gateway = getGateway()
    if (gateway === null || typeof gateway !== 'object') return null
    return {
      listening: gateway.server?.listening === true,
      host: gateway.host ?? null,
      port: gateway.port ?? null,
      upstream: gateway.upstream?.host ?? null,
      liveConnections: typeof gateway.upgradeProxy?.sockets?.count === 'function'
        ? gateway.upgradeProxy.sockets.count()
        : 0,
    }
  }

  /* ------------------------------------------------------------------ *
   * Handlers. Each returns `{ status, data }` or throws a stable-code Error;
   * `handle` turns both into an envelope. That keeps every write to `res` in
   * one place, which is what makes "never double writeHead" and "never throw out
   * of a handler" structural rather than remembered.
   * ------------------------------------------------------------------ */

  /** GET /state */
  function getState() {
    const devices = store.listDevices()
    return {
      status: 200,
      data: {
        settings: store.getSettings(),
        /* The NIC list travels with the state read because it is a fact about
           THIS MOMENT, not a setting: a cable that comes back does not need the
           panel restarted, and the stored `lanAddress` is returned unchanged
           beside it so the panel can tell "your choice is still here" from "your
           choice is gone, showing a fallback" (`design.md` §1.2).
           No address is written from this read — nothing here persists. */
        addresses: { lan: readLanAddresses() },
        devices: {
          active: devices.filter((device) => device.revokedAt === null).length,
          total: devices.length,
        },
        pairing: { pending: pairing.pending() },
        gateway: gatewayState(),
        /* `actions` travels with the state read instead of with every page of
           details (`design.md` §3): the panel's action filter is a `<select>` over
           the host's closed set, and the client must NOT carry its own copy of that
           list — a duplicated literal is how a dropdown ends up offering an action
           the server answers with 400, or missing one it accepts. */
        audit: { retentionDays: auditRetentionDays(), actions: AUDIT_EVENTS },
      },
    }
  }

  /** GET /devices */
  function listDevices() {
    /* Flush the throttled `lastSeenAt` first (`activity.js`): the panel is the only
       consumer of that field, so a read is the one moment it must be exact. */
    const gateway = getGateway()
    try {
      gateway?.activity?.flush?.()
    } catch {
      /* a failed flush must not fail the read */
    }
    const devices = store.listDevices().map(
      (device) => publicDevice(device, liveConnections(device.id)),
    )
    return { status: 200, data: { devices } }
  }

  /** POST /devices/:id/revoke */
  function revokeDeviceAction(deviceId, ip) {
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw adminError('admin/invalid-device', 'that is not a device id')
    }
    const outcome = revokeDevice(deviceId)
    if (outcome.device === null) {
      throw adminError('admin/unknown-device', 'no device with that id')
    }
    /* The audit line is written AFTER the effect, so a recorded `revoke` always
       describes something that happened. `closedSockets` is the number the
       gateway actually closed, which is the observable proof that revocation was
       immediate rather than merely recorded. */
    audit.record({ event: 'revoke', deviceId, ip, meta: { closedSockets: outcome.closedSockets } })
    log('info', `[remote-control] device ${deviceId} revoked from the panel`)
    return {
      status: 200,
      data: {
        id: outcome.device.id,
        revokedAt: outcome.device.revokedAt,
        closedSockets: outcome.closedSockets,
      },
    }
  }

  /** POST /devices/:id/rename */
  function renameDeviceAction(deviceId, body) {
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw adminError('admin/invalid-device', 'that is not a device id')
    }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '') throw adminError('admin/invalid-name', 'a device name is required')
    if (name.length > MAX_DEVICE_NAME_LENGTH) {
      throw adminError('admin/invalid-name', 'that device name is too long')
    }
    const device = store.renameDevice(deviceId, name)
    if (device === null) throw adminError('admin/unknown-device', 'no device with that id')
    return { status: 200, data: { device: publicDevice(device, liveConnections(deviceId)) } }
  }

  /**
   * POST /pairing — mint a pairing code for the panel to show as a QR.
   *
   * The clear `code` travels to the loopback browser in this response and nowhere
   * else: it is never logged, never audited and never written to disk
   * (`logging-guidelines.md` — a pairing code is on the never-log list).
   */
  function createPairing(body) {
    const label = typeof body.label === 'string' && body.label.trim() !== ''
      ? body.label.trim().slice(0, MAX_DEVICE_NAME_LENGTH)
      : undefined
    const pair = pairing.create(label === undefined ? {} : { label })
    const gateway = getGateway()
    const port = gateway?.port ?? null
    /* The QR carries the pair in the FRAGMENT, so the code is never sent to the
       server as part of a navigation and never lands in an access log
       (`design.md` §3.1 step 3). `host` is left for the panel: it renders the link
       from `settings.access` plus the NIC list in `GET /state`, and neither of
       those is this response's business (the port is, because the gateway knows
       it and the panel does not).
       `pairPath` comes from `constants.js` and is served by
       `gateway/pairing-route.js` — the panel and the route share one definition, so
       the link cannot point at a path nothing answers (which is what it did while
       the redeem half was missing). */
    const fragment = `${pair.pairId}:${pair.code}`
    return {
      status: 200,
      data: {
        pairId: pair.pairId,
        code: pair.code,
        expiresAt: new Date(pair.expiresAt).toISOString(),
        ttlMs: pair.expiresAt - pair.createdAt,
        port,
        pairPath: PAIRING_ROUTE_PATH,
        fragment,
      },
    }
  }

  /**
   * GET /pairing/:pairId — what became of one minted code.
   *
   * The panel holds the code and a local countdown, which cannot tell a code that
   * is still waiting from one the phone already redeemed; a redeemed code kept
   * counting down as though it were usable. This read answers exactly that
   * question, on demand (the panel's 「刷新」 button) rather than on a poll: the
   * code lives 120 s, and a timer that watched it would be a second mechanism for
   * a fact one click already provides.
   *
   * `state` is `pairing.js#state`'s five-value vocabulary. `unknown`/`expired`/
   * `locked` are ANSWERS (200), not errors: the id was well-formed, the host simply
   * no longer has a live pair for it. Only a malformed id is a `400`, because that
   * is the caller's typo and must not look like "no such code".
   *
   * ### What this route must never do
   *
   * Spend a failure budget. `pairing.state()` is a pure read, so refreshing cannot
   * burn the very code the panel is showing. And the response carries the STATE
   * only — never the code, never the label: this is a status probe, not a way to
   * retrieve a credential.
   *
   * @param {string} pairId
   * @returns {{ status: number, data: { pairId: string, state: string } }}
   */
  function pairingStatus(pairId) {
    if (!PAIR_ID_PATTERN.test(pairId)) {
      throw adminError('admin/invalid-pair', 'that is not a pairing id')
    }
    return { status: 200, data: { pairId, state: pairing.state(pairId) } }
  }

  /** POST /pairing/reset — clear one address's brute-force budget. */
  function resetPairingSource(body) {
    const source = typeof body.source === 'string' ? body.source.trim() : ''
    if (source === '') throw adminError('admin/invalid-source', 'a source address is required')
    const cleared = pairing.resetSource(source)
    return { status: 200, data: { source, cleared } }
  }

  /** GET /settings */
  function getSettings() {
    return { status: 200, data: { settings: store.getSettings() } }
  }

  /**
   * POST /settings
   *
   * Three writable fields, and the reload flag now answers a narrower question
   * than it used to (`design.md` §2.3):
   *
   *   - `enabled` / `port` re-bind the listener, so a change to either really does
   *     need `dsh` restarted. `requiresReload` is `true` only when one of them
   *     ACTUALLY changed — comparing before and after, not "a settings write
   *     happened". A panel that says "restart to apply" after an address edit
   *     sends the user to restart a process for nothing.
   *   - `access` only shapes the pairing link the panel renders. It takes effect
   *     immediately and is never a reason to restart.
   *
   * `access` is validated strictly and, on failure, the request is refused BEFORE
   * anything is written: a 400 that had already half-applied the other fields
   * would leave the panel's next read disagreeing with what it was told.
   */
  function updateSettings(body) {
    const patch = {}
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (Number.isInteger(body.port) && body.port > 0 && body.port <= 65535) patch.port = body.port
    if (body.access !== undefined) {
      const validated = validateAccess(body.access)
      if (!validated.ok) throw adminError('admin/invalid-access', validated.message)
      patch.access = validated.access
    }
    if (Object.keys(patch).length === 0) {
      throw adminError('admin/invalid-settings', 'no writable setting was provided')
    }
    /* Read BEFORE the write so "did the listener configuration change" is a real
       comparison. Both reads are of the same file within one request, so there is
       no window a concurrent writer could exploit here: this API has one client. */
    const before = store.getSettings()
    const settings = store.updateSettings(patch)
    return {
      status: 200,
      data: {
        settings,
        requiresReload: settings.enabled !== before.enabled || settings.port !== before.port,
      },
    }
  }

  /** GET /audit — the panel's summary. */
  function auditSummary() {
    const summary = audit.summarize()
    return { status: 200, data: summary }
  }

  /**
   * GET /audit/export — one JSONL download.
   *
   * Loopback-only like the rest of this API: the audit names every paired device
   * and the address it came from, so it is not something a remote device may
   * pull. The body is the export as produced by `audit.exportAll` — already
   * filtered to valid JSON objects, one per line.
   */
  function exportAudit(res) {
    const exported = audit.exportAll()
    const body = Buffer.from(exported.body, 'utf8')
    const opened = sendRaw(res, 200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-length': String(body.length),
      'content-disposition': `attachment; filename="dsh-remote-control-audit-${dayKeyOf(Date.now())}.jsonl"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    }, body)
    if (!opened) return true
    log('info', `[remote-control] audit exported (${String(exported.lines)} line(s))`)
    return true
  }

  /** Retention window, read back off the writer so the panel and the sweep agree. */
  function auditRetentionDays() {
    return Number.isInteger(audit.retentionDays) ? audit.retentionDays : null
  }

  /**
   * GET /audit/events — one page of the trail, projected and filtered
   * (`prd.md` R4/R6, `design.md` §2.1).
   *
   * ## Filtering is the HOST's job, and that is a correctness decision
   *
   * `prd.md` D4: the filter runs here, before paging. Filtering in the browser
   * would page over unfiltered records, so a page could arrive mostly — or
   * entirely — empty while more matching records exist further back; 「加载更多」
   * would then be a button that does nothing visible. It also means the panel never
   * receives records it asked not to see.
   *
   * An unknown `action` is a `400`, not an empty list. Returning `[]` would tell a
   * caller that a misspelt action has no events, which is indistinguishable from a
   * real answer — the same "looks like it works" failure `quality-guidelines.md`
   * §5 forbids.
   *
   * ## Validation uses the reader's own grammar
   *
   * `parseAuditLimit` / `parseAuditCursor` are the functions `readEvents` uses, so
   * "what the endpoint accepts" and "what the reader accepts" cannot drift
   * (`quality-guidelines.md` §24).
   *
   * @param {URLSearchParams} search
   * @returns {{ status: number, data: { events: object[], nextBefore: string | null } }}
   */
  function auditEvents(search) {
    const limit = parseAuditLimit(search.get('limit'))
    if (limit === null) {
      throw adminError(
        'admin/invalid-argument',
        `limit must be a whole number between 1 and ${String(AUDIT_EVENTS_MAX_PAGE)}`,
      )
    }
    const action = search.get('action')
    if (action !== null && action !== '' && !isAuditEvent(action)) {
      throw adminError('admin/invalid-argument', 'that is not a known audit action')
    }
    const before = search.get('before')
    if (before !== null && before !== '' && parseAuditCursor(before) === null) {
      throw adminError('admin/invalid-argument', 'the before cursor is not valid')
    }
    const page = audit.readEvents({
      limit,
      before: before === null ? undefined : before,
      action: action === null ? undefined : action,
    })
    return { status: 200, data: { events: page.events, nextBefore: page.nextBefore } }
  }

  /**
   * Dispatch one request.
   *
   * Every branch ends in a response. Nothing is `await`ed except the body read,
   * which is bounded, and no branch lets a throw escape.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handle(req, res) {
    const admitted = guard(req)
    if (!admitted.ok) {
      /* No detail about which half failed: a remote caller learns that this path
         exists and is refused, nothing more. */
      sendError(res, admitted.status, admitted.code, admitted.message)
      return
    }

    /* The peer address, for the audit line of an action taken from the panel. */
    const ip = typeof req?.socket?.remoteAddress === 'string' ? req.socket.remoteAddress : undefined
    const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET'

    let pathname
    let searchParams
    try {
      const target = new URL(req?.url ?? '/', 'http://localhost')
      pathname = target.pathname
      /* Kept alongside the path: the audit-detail read takes `limit`, `before` and
         `action` from the query string, and re-parsing the URL further down would
         be a second chance to disagree with the dispatched path. */
      searchParams = target.searchParams
    } catch {
      sendError(res, 400, 'admin/bad-request', 'The request target could not be parsed.')
      return
    }

    /* Everything after the mounted prefix: "" or "/devices/…". */
    const rest = pathname.length > ADMIN_API_PREFIX.length
      ? pathname.slice(ADMIN_API_PREFIX.length)
      : ''
    const segments = rest.split('/').filter((segment) => segment !== '')
    const [resource, ...tail] = segments

    try {
      /* `/remote-control/api` on its own is the state read, so the panel can
         probe the API with one GET and no path knowledge. */
      if (resource === undefined || resource === 'state') {
        requireMethod(method, ['GET'])
        respond(res, getState())
        return
      }

      switch (resource) {
        case 'devices': {
          if (tail.length === 0) {
            requireMethod(method, ['GET'])
            respond(res, listDevices())
            return
          }
          if (tail.length === 2 && tail[1] === 'revoke') {
            requireMethod(method, ['POST'])
            respond(res, revokeDeviceAction(tail[0], ip))
            return
          }
          if (tail.length === 2 && tail[1] === 'rename') {
            requireMethod(method, ['POST'])
            const body = parseBody(await readBody(req))
            respond(res, renameDeviceAction(tail[0], body))
            return
          }
          throw adminError('admin/not-found', 'there is no such endpoint')
        }
        case 'pairing': {
          if (tail.length === 0) {
            requireMethod(method, ['POST'])
            const body = parseBody(await readBody(req))
            respond(res, createPairing(body))
            return
          }
          if (tail.length === 1 && tail[0] === 'reset') {
            requireMethod(method, ['POST'])
            const body = parseBody(await readBody(req))
            respond(res, resetPairingSource(body))
            return
          }
          if (tail.length === 1) {
            /* The status probe for one minted code (`GET /pairing/:pairId`).
               Listed after `reset` so the one reserved segment cannot be read as
               a pair id. */
            requireMethod(method, ['GET'])
            respond(res, pairingStatus(tail[0]))
            return
          }
          throw adminError('admin/not-found', 'there is no such endpoint')
        }
        case 'settings': {
          if (tail.length !== 0) throw adminError('admin/not-found', 'there is no such endpoint')
          if (method === 'GET') {
            respond(res, getSettings())
            return
          }
          requireMethod(method, ['POST'])
          const body = parseBody(await readBody(req))
          respond(res, updateSettings(body))
          return
        }
        case 'audit': {
          if (tail.length === 0) {
            requireMethod(method, ['GET'])
            respond(res, auditSummary())
            return
          }
          if (tail.length === 1 && tail[0] === 'export') {
            requireMethod(method, ['GET'])
            exportAudit(res)
            return
          }
          if (tail.length === 1 && tail[0] === 'events') {
            /* Loopback-only by the `guard` above, exactly like every other route
               here: `design.md` §2.1 leaves the first statement of `handle`
               untouched rather than re-implementing admission per endpoint. */
            requireMethod(method, ['GET'])
            respond(res, auditEvents(searchParams))
            return
          }
          throw adminError('admin/not-found', 'there is no such endpoint')
        }
        default:
          throw adminError('admin/not-found', 'there is no such endpoint')
      }
    } catch (error) {
      const code = toAdminCode(error)
      const status = statusOf(code)
      /* A 5xx is our fault, so it gets a log line; a 4xx is the caller's, and
         logging it would let a loopback script fill the host's log. */
      if (status >= 500) log('error', `[remote-control] admin API failure: ${code}`)
      const message = status >= 500
        ? 'The remote control admin API could not complete this request.'
        : (typeof error?.message === 'string' && error.message !== '' ? error.message : 'Request refused.')
      sendError(res, status, code, message)
    }
  }

  /**
   * Write a handler's `{ status, data }` as the documented success envelope.
   *
   * One funnel for every success response, so the shape cannot drift per route
   * and a handler physically cannot reach `res` to write something else.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {{ status: number, data: unknown }} result
   */
  function respond(res, result) {
    sendJson(res, result.status, { ok: true, data: result.data })
  }

  /**
   * Assert the request method is allowed, or throw the stable code for 405.
   *
   * @param {string} method
   * @param {string[]} allowed
   */
  function requireMethod(method, allowed) {
    if (allowed.includes(method)) return
    throw adminError('admin/method-not-allowed', `This endpoint accepts ${allowed.join(' or ')}.`)
  }

  /**
   * Map a thrown error onto one of this API's stable codes.
   *
   * The audit reader re-validates its own arguments, because it is also called
   * directly (by tests, and by an embedder). Should that ever reject something the
   * endpoint's query parser accepted — exactly the drift the shared grammar exists
   * to prevent — the answer is a `400` naming the argument, never a `500` that
   * sends the user to the host log for their own typo.
   *
   * @param {unknown} error
   * @returns {string}
   */
  function toAdminCode(error) {
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : ''
    if (code.startsWith('admin/')) return code
    if (code === 'audit/invalid-limit' || code === 'audit/invalid-action' || code === 'audit/invalid-cursor') {
      return 'admin/invalid-argument'
    }
    return 'admin/internal'
  }

  /**
   * Map a stable code onto its status.
   *
   * @param {string} code
   * @returns {number}
   */
  function statusOf(code) {
    switch (code) {
      case 'admin/method-not-allowed': return 405
      case 'admin/not-found': return 404
      case 'admin/body-too-large': return 413
      case 'admin/body-timeout':
      case 'admin/body-aborted':
      case 'admin/body-unreadable':
      case 'admin/bad-request':
      case 'admin/invalid-json':
      case 'admin/invalid-device':
      case 'admin/invalid-pair':
      case 'admin/invalid-name':
      case 'admin/invalid-source':
      case 'admin/invalid-settings':
      /* A query parameter the reader would refuse: the caller's input, and the
         documented answer is `400 admin/invalid-argument` rather than an empty
         page (`prd.md` acceptance 6). */
      case 'admin/invalid-argument':
      /* A malformed access address is the caller's input, not a server fault:
         reporting 500 would send the user to the host log for a typo. */
      case 'admin/invalid-access': return 400
      case 'admin/unknown-device': return 404
      case 'admin/loopback-only':
      case 'admin/cross-origin': return 403
      default: return 500
    }
  }

  /**
   * The registered route handler.
   *
   * The official web server awaits whatever this returns, so it must never
   * reject: `handle` already catches everything, and this wrapper is the last
   * guard against a bug in the catch itself.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function routeHandler(req, res) {
    try {
      Promise.resolve(handle(req, res)).catch(() => {
        log('error', '[remote-control] the admin API rejected unexpectedly')
        if (res.headersSent === true) res.destroy()
        else sendError(res, 500, 'admin/internal', 'The remote control admin API failed to handle this request.')
      })
    } catch {
      log('error', '[remote-control] the admin API threw synchronously')
      if (res.headersSent === true) res.destroy()
      else sendError(res, 500, 'admin/internal', 'The remote control admin API failed to handle this request.')
    }
  }

  /* Registration. The `register` call is deferred into `ctx.effect` exactly like
     `dsh-client-connection` does (`apply.ts` there: `webCtx.effect(() => webCtx
     .webServer.register(route), …)`), so a hot reload removes the route instead
     of leaving a duplicate that makes the next registration throw.
     `webServer.register` RETURNS the disposer, which is what Cordis wants back
     from the effect — so the effect body returns it directly rather than storing
     it, or the route would be dropped by the first reload and never come back. */
  let available = false
  /* Declared, not left to the branch below: when a Cordis context exists the
     disposer belongs to `ctx.effect` and this stays a no-op, but the
     no-context branch ASSIGNS it, and referencing an undeclared binding is a
     `ReferenceError` in an ES module (strict mode). Measured: `startAdminApi`
     threw `ReferenceError: disposeRoute is not defined` for every caller without
     `ctx.effect` — an embedder or a test harness — and the throw happened before
     `available` was set, so the whole mount failed with no route and no warning. */
  let disposeRoute = () => {}
  if (webServer !== null && typeof webServer === 'object' && typeof webServer.register === 'function') {
    /** @returns {() => void} the route's disposer. */
    const register = () => webServer.register({
      kind: 'prefix',
      path: ADMIN_API_PREFIX,
      handler: routeHandler,
    })
    if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
      ctx.effect(register, 'remote-control: admin API')
    } else {
      /* No Cordis context: a test harness, or an embedder. Register directly and
         hand the disposer back so the caller still owns cleanup. */
      disposeRoute = register()
    }
    available = true
  } else {
    /* Visible degradation, not silence (`quality-guidelines.md` §5): on a host
       whose web server cannot register routes the panel's backend does not exist,
       and a user must be told rather than shown an empty device list. ONE line,
       from here — `src/index.js` does not repeat it, because two warnings for one
       condition is how a log gets skimmed. */
    log('warn', '[remote-control] ctx.webServer.register is unavailable; the device panel API is not mounted')
  }

  return {
    dispose: () => {
      try {
        disposeRoute()
      } catch {
        /* removing a route twice must not throw out of plugin unload */
      }
    },
    available,
    guard,
    handle,
  }
}
