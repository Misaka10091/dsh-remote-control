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
import { createTunnel } from './host/tunnel.js'
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
 * ## The switch and the port are live, not restart-only
 *
 * `POST /remote-control/api/settings` writes `enabled` / `port` and then calls
 * {@link applyListenerChange} through the `applyListenerChange` seam below, which
 * stops or rebinds THIS process's listener. The panel's save therefore takes
 * effect on the next request instead of the next `dsh` start — a switch that
 * needs a restart is a switch the user does not believe.
 *
 * Three properties of that seam are load-bearing:
 *
 *   - **Bind before release.** Moving to a different port binds the new listener
 *     first, so a refusal (`EADDRINUSE`) leaves the old one serving rather than
 *     taking remote access down over a mistyped number. `api.js` reverts the
 *     stored setting when the rebind fails, so the file never claims a port the
 *     process is not on.
 *   - **One effect, many binds.** `startGateway` is called with
 *     `registerEffect: false` and this closure owns the single
 *     `remote-control: gateway listener` disposer, so toggling the switch does not
 *     stack one disposer per bind.
 *   - **Serialised.** Overlapping settings writes are queued through
 *     `reconfigureListener`; two interleaved rebinds could otherwise leave a
 *     listener bound and unreferenced.
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
 * @param {Function} [config.tunnelSpawnImpl] `child_process#spawn` for the
 *   managed cloudflared process; injectable so tests never start a real binary.
 * @param {typeof globalThis.fetch} [config.tunnelFetchImpl] Download transport for
 *   the cloudflared binary; injectable for the same reason.
 * @param {(handle: object) => void} [config.onAdminApi] Receives the mounted API handle.
 * @returns {Promise<void> | undefined} A promise only while the listener is binding.
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime({
    ...(typeof config?.baseDir === 'string' && config.baseDir !== '' ? { baseDir: config.baseDir } : {}),
    /* An audit write failure is reported once per failure through the host logger.
       It must never be fatal (the request that triggered it was authorized), and
       it must never be silent (`quality-guidelines.md` §5). */
    onAuditError: (error) => logLine(ctx, 'warn', `[remote-control] audit: ${describeErrorCode(error)}`),
  })

  /* The managed Cloudflare Tunnel. It is created unconditionally and stays idle
     while `settings.tunnel.enabled` is false, so the panel can turn it on and off
     without a restart. It is DELIBERATELY not part of `createRuntime`: the runtime
     is the transport-independent domain, and this controller owns a child process. */
  const tunnel = createTunnel({
    baseDir: runtime.store.baseDir,
    logger: ctx?.logger,
    ...(typeof config?.tunnelSpawnImpl === 'function' ? { spawnImpl: config.tunnelSpawnImpl } : {}),
    ...(typeof config?.tunnelFetchImpl === 'function' ? { fetchImpl: config.tunnelFetchImpl } : {}),
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
      logLine(ctx, 'warn', `[remote-control] audit retention failed: ${describeErrorCode(error)}`)
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

  /* The tunnel's process outlives a settings write but must not outlive the
     plugin: unloading or hot-reloading has to leave no `cloudflared` behind. One
     effect for the whole controller, registered once — the controller's own
     start/stop are idempotent, so a disposer per start would only add noise. */
  registerEffect(ctx, () => () => tunnel.dispose(), 'remote-control: cloudflared tunnel')

  /* The running gateway, or null. The admin API reads it lazily through this
     closure rather than capturing a value, because the gateway may start after
     the API mounts, may stop while the panel is open, and may move to another
     port without the process restarting. `gateway.revokeDevice` behind it is the
     single entry point that both writes the store AND closes live sockets
     (`quality-guidelines.md` §18). */
  let live = null

  /* The port this process ASKED a listener for — not the one the OS granted.
     Comparing "did the requested port change" against the BOUND port would be
     wrong in the one case that matters: a profile that pins `config.port` to 0
     (every test) binds an ephemeral number, so every settings write would look
     like a port change and restart the listener underneath the panel. */
  let liveRequestedPort = null

  /* Row-level overrides, resolved once. `Number.isInteger` and not truthiness:
     0 is a legitimate override (OS-assigned) and the common one in tests, which
     must never bind a real port. */
  const configPort = Number.isInteger(config?.port) ? config.port : null
  const configHost = typeof config?.host === 'string' && config.host !== '' ? config.host : undefined

  /** Whether the one listener effect has been registered (see below). */
  let listenerEffectRegistered = false

  /** The port a listener started for `nextSettings` must ask the OS for. */
  function requestedPortFor(nextSettings) {
    return configPort !== null ? configPort : nextSettings.port
  }

  /**
   * The upstream port, read from the official web server at the moment a listener
   * needs it.
   *
   * Reading it lazily (here rather than at module scope) is what makes
   * `inject: ['webServer']` meaningful: when the service is absent Cordis parks
   * the fiber in PENDING and this code never runs, so the read cannot see
   * `undefined` in practice. The guard exists for the test harness, where a fake
   * context may provide the service with a port of 0, and for a rebind, where the
   * service is present but could in principle report nothing usable.
   *
   * @returns {number}
   */
  function upstreamPort() {
    const port = ctx?.webServer?.port
    if (!Number.isInteger(port) || port <= 0) {
      throw gatewayFailure('gateway/invalid-upstream', 'the official web server did not report a listening port')
    }
    return port
  }

  /**
   * Reconcile the managed tunnel with the stored settings and the live listener.
   *
   * Four call sites and ONE rule: the tunnel runs iff `settings.tunnel.enabled` is
   * true AND a gateway listener is live. Everything the panel can change funnels
   * through here, so "remote access off but cloudflared still up" cannot be
   * expressed.
   *
   * `live.port` is the BOUND port, not `settings.port` and not the profile
   * override: with `config.port: 0` (every test) they differ, and the tunnel must
   * target the port that is actually listening.
   *
   * Never throws out: the caller is a lifecycle hook or an API action, and a
   * tunnel problem is reported as status, not as a failed plugin.
   *
   * @returns {Promise<object>} The tunnel status after the attempt.
   */
  function syncTunnel() {
    try {
      const current = runtime.store.getSettings().tunnel
      if (current.enabled !== true || live === null) return tunnel.stop()
      return tunnel.start({ settings: current, port: live.port })
    } catch (error) {
      /* A corrupt `devices.json` read must not be turned into a tunnel failure
         report — the store problem is already fatal elsewhere. */
      return Promise.reject(error)
    }
  }

  /** Log a tunnel failure once, without pretending it is a gateway failure. */
  function reportTunnel(status) {
    if (status === null || typeof status !== 'object') return
    if (status.state !== 'failed' || status.error === null || typeof status.error !== 'object') return
    logLine(ctx, 'warn', `[remote-control] cloudflared is not running: ${String(status.error.code)}`)
  }

  /**
   * Apply one tunnel settings change to the RUNNING process.
   *
   * Wired into `api.js` as `applyTunnelChange`, mirroring `applyListenerChange`:
   * the admin API persists, this function makes the process agree. A tunnel that
   * fails to start does NOT fail the settings write — the panel is shown `failed`
   * plus the code, and the user can fix the token/path and retry without the
   * setting being silently reverted (`prd.md` acceptance 2).
   *
   * @param {{ before?: object, after?: object }} change
   * @returns {Promise<object>}
   */
  async function applyTunnelChange(change) {
    const after = change?.after
    if (after === null || typeof after !== 'object') return tunnel.describe()
    if (after.enabled !== true || live === null) {
      await tunnel.stop()
      /* Adopt the saved settings even though nothing can run yet: the panel reads
         `enabled`/`mode`/`publicUrl` back from this status, and a stale one would
         show "off" the instant after the user turned it on. */
      return tunnel.configure(after)
    }
    const status = change.force === true
      ? await tunnel.restart({ settings: after, port: live.port })
      : await tunnel.start({ settings: after, port: live.port })
    reportTunnel(status)
    return status
  }

  /**
   * Bind one listener for `nextSettings` and make it the live one.
   *
   * `registerEffect: false` on purpose: this closure registers ONE effect for
   * whichever listener is current (see {@link registerListenerEffect}), so a host
   * that toggles the switch ten times ends up with one disposer, not ten.
   *
   * @param {object} nextSettings Settings snapshot this listener is bound for.
   * @param {number} [officialPort] Already-validated upstream port; resolved here when omitted.
   * @returns {Promise<object>} The started gateway handle.
   */
  async function startListener(nextSettings, officialPort) {
    const upstream = Number.isInteger(officialPort) ? officialPort : upstreamPort()
    const port = requestedPortFor(nextSettings)
    const started = await startGateway({
      ctx,
      store: runtime.store,
      officialPort: upstream,
      port,
      host: configHost,
      cookieName: DEVICE_COOKIE_NAME,
      /* The JWT signing key (`research/jwt-device-credential.md` §3.3). Left to the
         gateway to load, pointed at the SAME directory the store resolved, and
         deliberately not caught: an unreadable or corrupt key file must refuse to
         enable remote access rather than silently minting a fresh in-memory key that
         invalidates every paired device at the next restart. */
      baseDir: runtime.store.baseDir,
      /* The pairing store is the OTHER half of `design.md` §3.1: `api.js` mints a
         code on the loopback admin API, and the gateway's `/remote-control/pair`
         routes redeem it. Both must see the SAME in-memory table, or the code the
         panel shows can never be spent. */
      pairing: runtime.pairing,
      /* The audit writer, wired LAST so an audit failure can never be mistaken for
         an authorization failure: `server.js` records through `recordSafely`,
         which swallows its own writer's problems. */
      audit: runtime.audit,
      registerEffect: false,
      logger: ctx.logger,
    })
    live = started
    liveRequestedPort = port
    registerListenerEffect()
    logLine(
      ctx,
      'info',
      `[remote-control] gateway listening on ${started.host}:${String(started.port)} `
        + `(upstream ${started.upstream.host})`,
    )
    /* The tunnel targets this listener. Started asynchronously on purpose: a
       missing binary, a bad token or a slow edge must not delay activation of the
       LAN gateway (which is the feature this plugin exists for), and its failure is
       a panel state, not a plugin error. `syncTunnel` re-checks the stored switch,
       so a toggle that lands meanwhile wins. */
    syncTunnel().then(reportTunnel).catch((error) => {
      logLine(ctx, 'warn', `[remote-control] cloudflared did not start: ${describeErrorCode(error)}`)
    })
    return started
  }

  /**
   * Release the live listener, if any.
   *
   * Idempotent, and never throws out: this runs from a `ctx.effect` disposer
   * during unload AND from the panel's switch, and a socket that refuses to close
   * must not take the plugin down with it.
   *
   * @returns {Promise<void>}
   */
  async function stopListener() {
    const current = live
    live = null
    liveRequestedPort = null
    /* Stop the tunnel BEFORE the listener disappears: cloudflared would otherwise
       spend the gap reconnecting to a port that is closing, and its retry chatter
       would outlive the state that explains it. Idempotent when nothing is running. */
    try {
      await tunnel.stop()
    } catch (error) {
      logLine(ctx, 'warn', `[remote-control] cloudflared did not stop: ${describeErrorCode(error)}`)
    }
    if (current === null) return
    try {
      await current.dispose()
    } catch (error) {
      logLine(ctx, 'warn', `[remote-control] listener shutdown failed: ${describeErrorCode(error)}`)
    }
  }

  /**
   * Register the one effect that owns whatever listener is current.
   *
   * Registered on the FIRST bind rather than at mount time, because the plugin
   * must not claim a listener (or a `remote-control: gateway listener` effect) it
   * does not have while remote access is off — that label is how the load-line
   * test proves "off means no socket". Later binds reuse it.
   */
  function registerListenerEffect() {
    if (listenerEffectRegistered) return
    listenerEffectRegistered = true
    /* The disposer returns a promise; Cordis (and the test harness) awaits it, so
       an in-flight close is not lost at unload. */
    registerEffect(ctx, () => () => stopListener(), 'remote-control: gateway listener')
  }

  /**
   * Apply one listener-relevant settings change to the running process.
   *
   * The three cases the panel can produce, and what each does here:
   *
   *   - **switch off** — release the listener. There is no "disabled but still
   *     bound" state: a switched-off plugin must look exactly like one that was
   *     never installed (`prd.md` D1), and a closed socket is the only proof.
   *   - **switch on, or a new port** — bind the requested port, and only then
   *     release the previous listener. Binding first matters: the new port is free
   *     by definition when it differs, so a refusal (port in use) leaves the old
   *     listener serving instead of taking remote access down for a port the user
   *     merely mistyped.
   *   - **nothing to do** — the requested port is unchanged (a re-save, or an
   *     access edit that also carried the switch). Re-binding would drop every
   *     live session and every keep-alive socket for no change at all.
   *
   * A bind failure propagates: the caller (`api.js`) reverts the stored setting
   * and answers `409 admin/listener-failed`, so this function deliberately does
   * not catch. What it does guarantee is that the PREVIOUS listener is still live
   * when it throws.
   *
   * @param {{ before: object, after: object }} change
   * @returns {Promise<{ applied: boolean, port: number | null }>}
   */
  async function applyListenerChange(change) {
    const next = change?.after
    if (next === null || typeof next !== 'object') return { applied: false, port: null }

    if (next.enabled !== true) {
      if (live === null) {
        await tunnel.stop()
        return { applied: false, port: null }
      }
      await stopListener()
      logLine(ctx, 'info', '[remote-control] gateway stopped — remote access is off')
      return { applied: true, port: null }
    }

    const port = requestedPortFor(next)
    if (live !== null && liveRequestedPort === port) return { applied: false, port: live.port }

    const previous = live
    const started = await startListener(next)
    if (previous !== null) {
      try {
        await previous.dispose()
      } catch (error) {
        /* The new listener is already live; a stuck old socket is a leak to
           report, not a reason to fail a change that took effect. */
        logLine(ctx, 'warn', `[remote-control] old listener did not close cleanly: ${describeErrorCode(error)}`)
      }
      logLine(ctx, 'info', `[remote-control] gateway moved to ${started.host}:${String(started.port)}`)
    }
    return { applied: true, port: started.port }
  }

  /* Two settings writes can overlap (the panel disables its buttons, but a second
     window or a script need not). The store write is atomic; the REBIND is not,
     and two interleaved rebinds could leave one listener bound and unreferenced.
     Serialising here — rather than in `api.js` — keeps the invariant with the
     resources it is about. */
  let rebinding = Promise.resolve()

  /**
   * Queue one listener change behind any in-flight one.
   *
   * @param {{ before: object, after: object }} change
   * @returns {Promise<{ applied: boolean, port: number | null }>}
   */
  function reconfigureListener(change) {
    const run = rebinding.then(
      () => applyListenerChange(change),
      () => applyListenerChange(change),
    )
    /* The chain must survive a failed rebind, or one EADDRINUSE would poison every
       later attempt. */
    rebinding = run.then(() => undefined, () => undefined)
    return run
  }

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
    /* The tunnel controller, read lazily for the same reason as the gateway: it
       exists before the listener and may be running, stopped or failed while the
       panel is open. The admin API may ask for status and drive it, but it never
       owns the process. */
    getTunnel: () => tunnel,
    /* The hot-reload seam for tunnel settings. Without it `POST /tunnel/config`
       would only write the file and the panel would show a stale process. */
    applyTunnelChange,
    /* The hot-reload seam. Without it `POST /settings` answers
       `requiresReload: true` and the user restarts `dsh` for a switch and a port. */
    applyListenerChange: reconfigureListener,
    logger: ctx?.logger,
  })
  if (typeof config?.onAdminApi === 'function') config.onAdminApi(admin)

  if (!settings.enabled) return

  /* Validated SYNCHRONOUSLY, before the promise exists: a host whose official
     server reports no port must fail the fiber at the moment of the call, not as
     a floating rejection (see the `apply` note above). */
  const initialUpstream = upstreamPort()

  /* Return the pending promise rather than awaiting it: the caller (Cordis) holds
     activation until the socket is actually bound, and a listen failure rejects
     into the fiber as a startup error. The listening line is printed from inside
     `startListener`, never optimistically before the bind. */
  return startListener(settings, initialUpstream).then(() => undefined)
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
 * A `code` is what an operator greps for and it never quotes a path or a value.
 * The fallback is deliberately generic: these lines also cover an audit writer and
 * a socket that refused to close, and neither has a message that belongs in a
 * host log.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeErrorCode(error) {
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
