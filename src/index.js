/**
 * dsh-remote-control — host half (plain JavaScript, no build step).
 *
 * A Cordis plugin that will own one pairing-gated channel into the official
 * `dsh web` instance (`design.md` §1): a self-hosted listener that authenticates
 * every remote request, then reverse-proxies it to the loopback official port.
 * The official port stays on `127.0.0.1`, so an unpaired request is stopped
 * before it can reach DSH at all.
 *
 * Stage 0/1 scope — what exists here today:
 *
 *   - the package/manifest skeleton, so the bundle patch installs and the row
 *     loads (this file is the only thing the Node half needs at load time);
 *   - the domain modules under `src/host/` — device store, pairing codes, device
 *     tokens — each pure and independently testable.
 *
 * The gateway (`src/host/gateway/*`), the loopback-only admin API and the audit
 * writer land in later stages. Until then `apply` wires the domain runtime and
 * prints exactly ONE line, which is stage 0's acceptance criterion.
 *
 * `inject` declares `webServer` because that is where the upstream port comes
 * from (`ctx.webServer.port`, `design.md` §2). It is declared from the start so
 * the dependency is visible in the plugin graph rather than appearing silently
 * in a later version.
 */
import { createPairingStore } from './host/pairing.js'
import { createStore } from './host/store.js'

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
 * Stage 0/1: resolve the device table and report state in one line. Nothing is
 * listening yet, so nothing needs a disposer — every listener added from stage 2
 * on must be registered through `ctx.effect()`.
 *
 * A corrupt `devices.json` throws out of `createStore`/`getSettings` on purpose
 * (`.trellis/spec/backend/error-handling.md`): the row goes FAILED and the user
 * sees it, instead of remote access quietly running on an empty device table.
 *
 * @param {object} ctx Cordis context.
 */
export function apply(ctx) {
  const runtime = createRuntime()
  const settings = runtime.store.getSettings()
  const devices = runtime.store.listDevices()
  /* Active, not total: `listDevices()` deliberately includes revoked rows (the
     panel and the audit need them), but a load line reporting "5 paired devices"
     when four of them are revoked is the kind of reassuring-and-wrong number
     that sends an operator looking in the wrong place. */
  const activeCount = devices.filter((device) => device.revokedAt === null).length

  /* Exactly one line. The gateway's own "listening on <host>:<port>" line is a
     stage 2 concern; claiming a listener before it exists would be a lie. */
  logLine(
    ctx,
    'info',
    `[remote-control] loaded — ${activeCount} paired device(s), configured port ${settings.port}, `
      + `remote access ${settings.enabled ? 'enabled in settings' : 'off'} (gateway not started in this build)`,
  )
}
