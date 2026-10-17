/**
 * dsh-remote-control — host half (plain JavaScript, no build step).
 *
 * A Cordis plugin owning one pairing-gated channel into the official
 * `dsh web` instance (`design.md` §1): a self-hosted listener that authenticates
 * every remote request, then reverse-proxies it to the loopback official port.
 * The official port stays on `127.0.0.1`, so an unpaired request is stopped
 * before it can reach DSH at all.
 *
 * Stage 3 scope — what exists here today:
 *
 *   - the package/manifest skeleton, so the bundle patch installs and the row
 *     loads (this file is the only thing the Node half needs at load time);
 *   - the domain modules under `src/host/` — device store, pairing codes, device
 *     tokens — each pure and independently testable;
 *   - the HTTP gateway under `src/host/gateway/`: the listener, the single
 *     authorization decision, the origin fence, the inner-credential provider and
 *     the reverse proxy;
 *   - the WebSocket upgrade passthrough (`gateway/wsproxy.js`), so the official
 *     `/api/remote.mux` stream reaches a paired device's browser.
 *
 * The loopback-only admin API and audit writer (stage 4) and the client UI (stage
 * 5) land later. Until then the gateway can be driven programmatically —
 * `gateway.revokeDevice(id)` is the entry point the panel will call, and it
 * already closes the revoked device's live sockets (`prd.md` constraint 5).
 *
 * ## Default off (`prd.md` D1, acceptance 1)
 *
 * `apply` starts a listener ONLY when `settings.enabled` is true. A disabled
 * plugin prints its one line and binds nothing, so `dsh web`'s observable
 * behaviour is identical to a host without the plugin installed.
 *
 * `inject` declares `webServer` because that is where the upstream port comes
 * from (`ctx.webServer.port`, `design.md` §2). It is declared from the start so
 * the dependency is visible in the plugin graph rather than appearing silently
 * in a later version.
 *
 * `ctx.connection` is deliberately NOT injected: it is optional (see
 * `gateway/inner-auth.js`), read through `ctx.get('connection')`, and its absence
 * degrades one credential exchange instead of parking the whole plugin.
 */
import { DEVICE_COOKIE_NAME } from './host/constants.js'
import { createPairingStore } from './host/pairing.js'
import { createStore } from './host/store.js'
import { startGateway } from './host/gateway/server.js'

export const name = 'dsh-remote-control'

/**
 * The official web server, read (never registered on) for its port.
 *
 * Load-safety note, verified against Cordis 4.0.2: a declared-but-unavailable
 * injected service does NOT throw and does NOT fail the fiber — the fiber parks
 * in PENDING and `apply` simply never runs. So this declaration cannot break a
 * load; the worst case if `webServer` were ever absent is that the plugin stays
 * silent instead of printing its line.
 *
 * That case cannot arise in a profile that can host this plugin: the `webserver`
 * row is contributed by `@deepseek-ai/dsh-web-app` (its `cordis.patch.yml`) and
 * is present in the desktop profile too, so every surface this plugin targets
 * provides the service. It is declared from the start rather than added in
 * stage 2 because the dependency is real now (the port is the upstream target)
 * and a silently-appearing dependency is worse than a declared one.
 */
export const inject = ['webServer']

/**
 * Emit one diagnostic line through the host logger.
 *
 * `ctx.logger` is the only permitted log sink (`.trellis/spec/backend/quality-guidelines.md`).
 * A host that provides no logger gets silence rather than a stray `console.log`:
 * there is nowhere sensible to write, and inventing a sink is how stray output
 * ends up in a user's terminal.
 *
 * @param {object} ctx
 * @param {'info' | 'warn' | 'error'} level
 * @param {string} message Free text with inline values; never a token or a cookie.
 */
function logLine(ctx, level, message) {
  const logger = ctx !== null && typeof ctx === 'object' ? ctx.logger : undefined
  const sink = logger !== null && typeof logger === 'object' ? logger[level] : undefined
  if (typeof sink !== 'function') return
  sink.call(logger, message)
}

/**
 * Build the transport-independent domain runtime.
 *
 * Exported so a test (or a later stage) can construct the same pieces without
 * mounting the whole plugin, and so every side effect stays injectable: `baseDir`
 * and the clock are parameters, never globals.
 *
 * @param {object} [options]
 * @param {string} [options.baseDir] Directory holding `devices.json`; defaults to `~/.dsh/remote-control`.
 * @param {() => number} [options.now] Clock in epoch milliseconds.
 * @returns {{ store: ReturnType<typeof createStore>, pairing: ReturnType<typeof createPairingStore> }}
 */
export function createRuntime(options = {}) {
  return {
    store: createStore(options),
    /* Codes live in memory only: a pairing code that outlives the process would
       be a code nobody can redeem, so there is nothing to persist. */
    pairing: createPairingStore(options),
  }
}

/**
 * Mount the plugin.
 *
 * With remote access off, this resolves the device table and prints exactly one
 * line — stage 0's acceptance criterion, and the "no observable change" guarantee
 * of `prd.md` D1. With it on, it additionally starts the gateway listener and logs
 * a second line naming what it bound.
 *
 * A corrupt `devices.json` throws out of `createStore`/`getSettings` on purpose
 * (`.trellis/spec/backend/error-handling.md`): the row goes FAILED and the user
 * sees it, instead of remote access quietly running on an empty device table.
 *
 * A port that cannot be bound rejects the promise returned by `apply`, which
 * likewise fails the fiber — the user must not be told remote access is up when
 * nothing is listening.
 *
 * `apply` is a plain function that MAY return a promise, not an `async` function.
 * The distinction matters: an `async` function converts every synchronous throw
 * into a rejection, and a corrupt device table (`store/corrupt`) must surface at
 * the moment of the call so the row fails immediately and visibly. Cordis awaits
 * a returned promise, so the asynchronous bind still gates activation.
 *
 * @param {object} ctx Cordis context.
 * @param {object} [config] Cordis plugin config (the profile row's `config` block).
 * @param {number} [config.port] Bind port overrides `settings.port`.
 *   `0` asks the OS for one. Exists for two callers: a profile that wants to pin
 *   the port without editing `devices.json`, and a test that must not bind a real
 *   port (`implement.md` — tests bind port 0, never a fixed one).
 * @param {string} [config.host] Bind address overrides the all-interfaces default.
 * @returns {Promise<void> | undefined} A promise only while the listener is binding.
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime()
  const settings = runtime.store.getSettings()
  const devices = runtime.store.listDevices()
  /* Active, not total: `listDevices()` deliberately includes revoked rows (the
     panel and the audit need them), but a load line reporting "5 paired devices"
     when four of them are revoked is the kind of reassuring-and-wrong number
     that sends an operator looking in the wrong place. */
  const activeCount = devices.filter((device) => device.revokedAt === null).length

  /* Exactly one load line. The gateway's own "listening on <host>:<port>" line is
     printed only after the bind succeeds, so it can never claim a listener that
     does not exist. */
  logLine(
    ctx,
    'info',
    `[remote-control] loaded — ${activeCount} paired device(s), configured port ${settings.port}, `
      + `remote access ${settings.enabled ? 'enabled' : 'off'}`,
  )

  if (!settings.enabled) return

  /* The upstream port comes from the official web server. Reading it lazily (here
     rather than at module scope) is what makes `inject: ['webServer']` meaningful:
     when the service is absent Cordis parks the fiber in PENDING and this code
     never runs, so the cast below cannot see `undefined` in practice. The guard
     exists for the test harness, where a fake context may provide the service with
     a port of 0. */
  const officialPort = ctx.webServer.port
  if (!Number.isInteger(officialPort) || officialPort <= 0) {
    throw gatewayFailure('gateway/invalid-upstream', 'the official web server did not report a listening port')
  }

  /* A row-level override, then the stored setting. `Number.isInteger` and not
     truthiness: 0 is a legitimate override (OS-assigned) and the common one in
     tests, which must never bind a real port. */
  const bindPort = Number.isInteger(config?.port) ? config.port : settings.port
  const bindHost = typeof config?.host === 'string' && config.host !== '' ? config.host : undefined

  const gateway = startGateway({
    ctx,
    store: runtime.store,
    officialPort,
    port: bindPort,
    host: bindHost,
    cookieName: DEVICE_COOKIE_NAME,
    logger: ctx.logger,
  })

  /* Return the pending promise rather than awaiting it: the caller (Cordis) holds
     activation until the socket is actually bound, and a listen failure rejects
     into the fiber as a startup error. The listening line is therefore printed from
     a callback, never optimistically before the bind. */
  return gateway.then((started) => {
    logLine(
      ctx,
      'info',
      `[remote-control] gateway listening on ${started.host}:${String(started.port)} `
        + `(upstream ${started.upstream.host})`,
    )
  })
}

/**
 * Build the Error used for a startup precondition failure.
 *
 * A plain Error with a stable `code`, never a subclass
 * (`.trellis/spec/backend/error-handling.md`).
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function gatewayFailure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}
