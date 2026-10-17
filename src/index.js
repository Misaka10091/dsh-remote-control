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
 * Stage 4 adds the management surface and the trail:
 *
 *   - `host/audit.js` — the JSONL audit writer, its 30-day retention sweep and the
 *     export, mounted here unconditionally (see the `apply` note);
 *   - `host/api.js` — `/remote-control/api/*` on the OFFICIAL loopback server,
 *     loopback-only, which is the panel's backend and the one path a paired remote
 *     device must never reach (`prd.md` R4);
 *   - `host/classify.js` — path-prefix + method → audit event, degrading to
 *     `unknown` rather than coupling to DSH internals (`design.md` §6);
 *   - `host/loopback.js` and `host/origin.js` — the two predicates BOTH transports
 *     must share, lifted out of `gateway/` so `api.js` need not import it
 *     (`quality-guidelines.md` §7). `gateway/auth.js` and `gateway/origin.js`
 *     re-export them unchanged.
 *
 * The client UI (stage 5) lands later.
 *
 * ## Default off (`prd.md` D1, acceptance 1)
 *
 * `apply` starts a listener ONLY when `settings.enabled` is true. A disabled
 * plugin binds no socket, so `dsh web`'s observable behaviour is identical to a
 * host without the plugin installed.
 *
 * Two things are deliberately NOT gated on the switch, and neither is a listening
 * socket: the audit retention sweep (it is about files, not access — a user who
 * turns the feature off for a month must not come back to files past the
 * retention window) and the admin API route (it is the only way to turn the switch
 * back on, and it is served by the host's own loopback server, not by us).
 *
 * `inject` declares `webServer` because that is where the upstream port comes
 * from (`ctx.webServer.port`, `design.md` §2) and where the admin API registers.
 * It is declared from the start so the dependency is visible in the plugin graph
 * rather than appearing silently in a later version.
 *
 * `ctx.connection` is deliberately NOT injected: it is optional (see
 * `gateway/inner-auth.js`), read through `ctx.get('connection')`, and its absence
 * degrades one credential exchange instead of parking the whole plugin.
 */
import { AUDIT_PRUNE_INTERVAL_MS, DEVICE_COOKIE_NAME } from './host/constants.js'
import { createAudit } from './host/audit.js'
import { startAdminApi } from './host/api.js'
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
 * @param {(error: Error) => void} [options.onAuditError] Sink for audit failures.
 * @returns {{
 *   store: ReturnType<typeof createStore>,
 *   pairing: ReturnType<typeof createPairingStore>,
 *   audit: ReturnType<typeof createAudit>,
 * }}
 */
export function createRuntime(options = {}) {
  /* Both writers must land in the SAME directory (`design.md` §5/§6), and the
     audit writer must not resolve its own: `store.js` is the only module that
     knows where the runtime dir is (`directory-structure.md`). So the store is
     built first and its resolved `baseDir` is handed to the audit writer. */
  const store = createStore(options)
  const audit = createAudit({
    baseDir: store.baseDir,
    now: options.now,
    onError: options.onAuditError,
  })
  return {
    store,
    audit,
    /* Codes live in memory only: a pairing code that outlives the process would
       be a code nobody can redeem, so there is nothing to persist. The
       `onFailure` wiring is what makes a brute-force attempt visible
       (`implement.md` stage 2 supplement — the one item stage 4 owed stage 1):
       `pairing.js` reports the failed guess and stays filesystem-free, the audit
       writer decides how to record it. */
    pairing: createPairingStore({
      ...options,
      onFailure: (failure) => {
        audit.record({
          event: 'pair_failed',
          /* No `deviceId`: a failed pairing by definition has no device. The IP is
             the useful correlate, and it is an address, not a secret. */
          ip: failure.source ?? undefined,
          /* A pair id is an opaque `pair_*` identifier; the CODE is never in scope
             inside `pairing.js`'s failure path, so it cannot reach this line. */
          meta: {
            ...(failure.pairId === null ? {} : { pairId: failure.pairId }),
            code: failure.code,
          },
        })
      },
    }),
  }
}

/**
 * Mount the plugin.
 *
 * Stage 4 adds two things to the load path, and the two are gated differently on
 * purpose:
 *
 *   - **The audit writer and its retention sweep** always exist. `prd.md` R5 is
 *     about what remote devices did, so there is nothing to record while remote
 *     access is off — but the cleanup must run regardless, or a user who turns
 *     the feature off for a month comes back to files older than the retention
 *     window. The sweep touches only the audit directory and deletes only its
 *     own expired day files.
 *   - **The admin API always mounts**, even while remote access is off, and that
 *     is not an oversight: the panel's toggle is the ONLY way to turn remote
 *     access on, so an API that only appeared after it was on would leave the
 *     user editing `devices.json` by hand. It is registered on the official
 *     loopback server, so "off" still means "no LAN listener", which is what
 *     `prd.md` D1's "no observable change" is actually about.
 *   - **The gateway listener** is the only thing gated on `settings.enabled`,
 *     exactly as before.
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
 * @param {number} [config.auditPruneIntervalMs] Retention sweep interval; injectable so a test need not wait.
 * @param {string} [config.baseDir] Runtime directory; defaults to `~/.dsh/remote-control`.
 * @param {(handle: object) => void} [config.onAdminApi] Receives the mounted API handle.
 * @returns {Promise<void> | undefined} A promise only while the listener is binding.
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime({
    ...(typeof config?.baseDir === 'string' && config.baseDir !== '' ? { baseDir: config.baseDir } : {}),
    /* An audit write failure is reported once per failure through the host logger.
       It must never be fatal (the request that triggered it was authorized), and
       it must never be silent (`quality-guidelines.md` §5). */
    onAuditError: (error) => logLine(ctx, 'warn', `[remote-control] audit: ${describeAuditError(error)}`),
  })
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

  /* Retention: once at startup, then on an interval. Both are needed and neither
     replaces the other — startup covers the normal desktop case (restarted far
     more often than it runs for a day), the interval covers a process that stays
     up. Wrapped so a sweep failure is a warning, not a failed plugin: an
     undelible old file must not stop the gateway from starting. */
  const runPrune = () => {
    try {
      const outcome = runtime.audit.prune()
      if (outcome.deleted.length > 0) {
        logLine(
          ctx,
          'warn',
          `[remote-control] audit retention removed ${String(outcome.deleted.length)} expired day file(s) `
            + `(kept ${String(runtime.audit.retentionDays)} days)`,
        )
      }
    } catch (error) {
      logLine(ctx, 'warn', `[remote-control] audit retention failed: ${describeAuditError(error)}`)
    }
  }
  runPrune()

  /* The timer is registered through `ctx.effect` so it is cleared on hot reload
     and on plugin unload (`quality-guidelines.md` §6 — every timer gets a
     disposer). `unref` keeps a pending sweep from holding a shutting-down process
     open, which matters for a CLI host. */
  const pruneIntervalMs = Number.isFinite(config?.auditPruneIntervalMs) && config.auditPruneIntervalMs > 0
    ? config.auditPruneIntervalMs
    : AUDIT_PRUNE_INTERVAL_MS
  registerEffect(ctx, () => {
    const timer = setInterval(runPrune, pruneIntervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'remote-control: audit retention')

  /* The running gateway, or null. The admin API reads it lazily through this
     closure rather than capturing a value, because the gateway may start after
     the API mounts (and may never start at all while the switch is off).
     `gateway.revokeDevice` behind it is the single entry point that both writes
     the store AND closes live sockets (`quality-guidelines.md` §18). */
  let live = null

  /* Mount the admin API. It does not depend on the gateway having started: every
     device-management route works from the store, and only `revoke` prefers the
     gateway (for the socket half of revocation). A host that cannot register
     routes gets ONE warning, emitted by `startAdminApi` itself — repeating it
     here would be two lines for one condition.
     `config.onAdminApi` hands the handle to a caller that wants it (the tests do,
     so they can exercise `guard` and `handle` directly as well as over a socket). */
  const admin = startAdminApi({
    ctx,
    webServer: ctx?.webServer,
    store: runtime.store,
    pairing: runtime.pairing,
    audit: runtime.audit,
    getGateway: () => live,
    logger: ctx?.logger,
  })
  if (typeof config?.onAdminApi === 'function') config.onAdminApi(admin)

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
    /* The audit writer, wired LAST so an audit failure can never be mistaken for
       an authorization failure: `server.js` records through `recordSafely`,
       which swallows its own writer's problems. */
    audit: runtime.audit,
    logger: ctx.logger,
  })

  /* Return the pending promise rather than awaiting it: the caller (Cordis) holds
     activation until the socket is actually bound, and a listen failure rejects
     into the fiber as a startup error. The listening line is therefore printed from
     a callback, never optimistically before the bind. */
  return gateway.then((started) => {
    live = started
    logLine(
      ctx,
      'info',
      `[remote-control] gateway listening on ${started.host}:${String(started.port)} `
        + `(upstream ${started.upstream.host})`,
    )
  })
}

/**
 * Register one disposer with `ctx.effect`, tolerating a context that has none.
 *
 * `ctx.effect` is the ONLY correct place for a timer or a listener in this
 * package (`quality-guidelines.md` §6). A test harness may provide a context
 * without it; rather than silently leaking, the disposer is returned to nobody
 * and the caller's own teardown is expected to run — which is what the tests do.
 *
 * @param {object} ctx
 * @param {() => (() => void)} acquire Returns the disposer.
 * @param {string} label Effect label, shown by Cordis on reload.
 */
function registerEffect(ctx, acquire, label) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.effect !== 'function') return
  ctx.effect(() => {
    const release = acquire()
    return typeof release === 'function' ? release : () => {}
  }, label)
}

/**
 * Describe an error for a log line, without its message.
 *
 * An audit error's `message` is safe, but a `code` is what an operator greps
 * for and it never quotes a path or a value. The message is used only when no
 * code exists.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeAuditError(error) {
  if (error === null || typeof error !== 'object') return 'unknown error'
  if (typeof error.code === 'string' && error.code !== '') return error.code
  return 'storage error'
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
