/**
 * dsh-remote-control — the managed Cloudflare Tunnel (`cloudflared`).
 *
 * `prd.md` R1-R3: one external program, started and stopped by the panel, whose
 * public URL becomes an access address. This module owns the PROCESS and the
 * persisted configuration; `tunnel-binary.js` owns finding and installing the
 * executable; `src/index.js` decides WHEN (gateway lifecycle); `api.js` exposes it
 * on the loopback admin surface.
 *
 * ## Why this module may spawn a process
 *
 * The package's original invariant was "the host half never shells out". That
 * invariant is now narrowed, not deleted: exactly one program may be started, from
 * exactly two modules, and this file does it in the only shape that keeps an argv
 * array under our control:
 *
 *   - `spawnImpl(binary, args, { shell: false, windowsHide: true })` — never a
 *     command string, never a shell;
 *   - `binary` comes from `resolveTunnelBinary`, i.e. a configured path, PATH, or
 *     the file this plugin downloaded itself;
 *   - the token goes through `--token-file`, so it is not in `argv` (visible to
 *     same-user `ps`) and not in the child's environment.
 *
 * `tests/package.test.mjs` asserts that no OTHER host module imports
 * `node:child_process`, so the exception cannot spread.
 *
 * ## Failure policy
 *
 * A tunnel that cannot start is a DEGRADED OPTIONAL CAPABILITY, never a fatal
 * plugin error: remote access over the LAN still works, and the panel shows
 * `failed` + a stable code. That is `quality-guidelines.md` §5's "no silent
 * degradation" applied in both directions — loud in the panel, harmless to the
 * core.
 *
 * ## No auto-restart
 *
 * `cloudflared` reconnects its own edge connections. If the PROCESS exits, the
 * user asked for something this plugin cannot fix by looping; restarting it would
 * turn a broken token into an infinite retry loop and a changing quick URL into a
 * moving target. The state becomes `failed` and the panel offers a restart.
 *
 * ## No reachability claim
 *
 * `running` means "the process is up and (for quick tunnels) printed a URL". It
 * never means "that URL is reachable from the internet". The same honesty rule as
 * the address book: the plugin does not probe.
 *
 * ## Token storage
 *
 * A dashboard token is a credential for the tunnel identity. It lives in
 * `<baseDir>/cloudflared-token` (0600), never in `devices.json`, and the API only
 * ever learns `tokenSet: boolean`. See `design.md` §3.2.
 */
import { spawn } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { formatAddress, parseAddress } from './addresses.js'
import {
  TUNNEL_BINARY_PATH_MAX,
  TUNNEL_LOG_LINES_MAX,
  TUNNEL_MODES,
  TUNNEL_QUICK_HOST_SUFFIX,
  TUNNEL_READY_GRACE_MS,
  TUNNEL_START_TIMEOUT_MS,
  TUNNEL_STOP_TIMEOUT_MS,
  TUNNEL_TOKEN_FILE_NAME,
  TUNNEL_TOKEN_MAX,
} from './constants.js'
import {
  downloadTunnelBinary,
  downloadedBinaryLeaf,
  resolveTunnelBinary,
} from './tunnel-binary.js'

/** Build an Error carrying a stable `code` (`.trellis/spec/backend/error-handling.md`). */
function tunnelError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * The tunnel settings a fresh document carries.
 *
 * A FRESH object every call, for the same reason `defaultAccess()` is: the value
 * is handed to the store and read back, and a shared literal would let one
 * caller's mutation surface in another's settings.
 *
 * @returns {{ enabled: boolean, mode: 'quick' | 'token', binaryPath: string, publicUrl: string }}
 */
export function defaultTunnel() {
  return { enabled: false, mode: 'quick', binaryPath: '', publicUrl: '' }
}

/**
 * Whether a string looks like an absolute path on any supported platform.
 *
 * Written by hand instead of `path.isAbsolute` because the grammar is part of the
 * STORED format: a Windows profile can hand `devices.json` to a POSIX process (and
 * the tests run on all three platforms), so `C:\...` must be recognised as
 * absolute regardless of which separator the current host uses. A bare name is
 * handled before this is asked.
 *
 * @param {string} value
 * @returns {boolean}
 */
function looksAbsolute(value) {
  if (value.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  /* UNC (`\\server\share\...`). */
  return value.startsWith('\\\\')
}

/**
 * Whether a value is a bare command name (`cloudflared`, `cloudflared.exe`).
 *
 * @param {string} value
 * @returns {boolean}
 */
function isBareName(value) {
  return !value.includes('/') && !value.includes('\\')
}

/**
 * One traversal, two policies — the same shape `addresses.js` uses and for the
 * same reason: `store.js` must never fail to load a hand-edited file, while
 * `POST /settings` must tell the caller instead of quietly rewriting its input.
 *
 * @param {unknown} input
 * @returns {{ tunnel: { enabled: boolean, mode: 'quick' | 'token', binaryPath: string, publicUrl: string }, errors: string[] }}
 */
function readTunnel(input) {
  const errors = []
  /* `undefined` means "absent" (an old document, or a partial patch) and takes the
     defaults silently. `null` is a VALUE the caller wrote, so the strict reader must
     refuse it while the lenient one still repairs it — the same distinction
     `addresses.js#readAccess` makes for `access`. */
  if (input === undefined) return { tunnel: defaultTunnel(), errors }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    errors.push('the tunnel setting must be an object')
    return { tunnel: defaultTunnel(), errors }
  }

  const enabled = input.enabled === true
  if (input.enabled !== undefined && input.enabled !== null && typeof input.enabled !== 'boolean') {
    errors.push('enabled must be a boolean')
  }

  const rawMode = typeof input.mode === 'string' ? input.mode.trim() : ''
  let mode = 'quick'
  if (input.mode !== undefined && input.mode !== null && typeof input.mode !== 'string') {
    errors.push('the tunnel mode must be a string')
  } else if (rawMode !== '') {
    if (TUNNEL_MODES.includes(rawMode)) mode = rawMode
    else errors.push(`the tunnel mode must be one of ${TUNNEL_MODES.join(' / ')}`)
  }

  let binaryPath = ''
  if (input.binaryPath !== undefined && input.binaryPath !== null) {
    if (typeof input.binaryPath !== 'string') {
      errors.push('the cloudflared path must be a string')
    } else {
      const trimmed = input.binaryPath.trim()
      if (trimmed !== '') {
        if (trimmed.length > TUNNEL_BINARY_PATH_MAX) {
          errors.push(`the cloudflared path is longer than ${TUNNEL_BINARY_PATH_MAX} characters`)
        } else if (/[\0\r\n]/.test(trimmed)) {
          errors.push('the cloudflared path contains a control character')
        } else if (!isBareName(trimmed) && !looksAbsolute(trimmed)) {
          errors.push('the cloudflared path must be an absolute path or a command name')
        } else {
          binaryPath = trimmed
        }
      }
    }
  }

  let publicUrl = ''
  if (input.publicUrl !== undefined && input.publicUrl !== null) {
    if (typeof input.publicUrl !== 'string') {
      errors.push('the public hostname must be a string')
    } else {
      const trimmed = input.publicUrl.trim()
      if (trimmed !== '') {
        const parsed = parseAddress(trimmed)
        if (parsed === null) {
          errors.push('the public hostname must be a host, host:port or https://host[:port] with no path')
        } else {
          /* A tunnel's public side is TLS-terminated by Cloudflare, so a bare
             hostname means https. Storing the scheme (instead of leaving it out
             and re-deciding at link time) keeps the panel and the link agreeing. */
          publicUrl = parsed.scheme === null
            ? `https://${formatAddress(parsed)}`
            : formatAddress(parsed)
        }
      }
    }
  }

  return { tunnel: { enabled, mode, binaryPath, publicUrl }, errors }
}

/**
 * Normalize one `settings.tunnel` value, keeping everything usable (read path).
 *
 * @param {unknown} input
 * @returns {{ enabled: boolean, mode: 'quick' | 'token', binaryPath: string, publicUrl: string }}
 */
export function normalizeTunnel(input) {
  return readTunnel(input).tunnel
}

/**
 * Validate one `settings.tunnel` value, refusing anything that needed repairing
 * (write path — `POST /settings` answers `400 admin/invalid-tunnel`).
 *
 * @param {unknown} input
 * @returns {{ ok: true, tunnel: object } | { ok: false, message: string }}
 */
export function validateTunnel(input) {
  const { tunnel, errors } = readTunnel(input)
  return errors.length === 0 ? { ok: true, tunnel } : { ok: false, message: errors[0] }
}

/**
 * Recognise the public URL of a quick tunnel in one line of `cloudflared` output.
 *
 * Quick-tunnel hostnames are three or more hyphen-separated words under
 * `.trycloudflare.com` (`research/cloudflared-facts.md` §1). Requiring the dashes
 * is what keeps an incidental documentation link (`docs.trycloudflare.com`) from
 * being mistaken for ours.
 *
 * Pure; used by the process reader and directly by tests.
 *
 * @param {unknown} line
 * @returns {string | null} The URL, or null when the line does not carry one.
 */
export function quickTunnelUrl(line) {
  if (typeof line !== 'string' || line === '') return null
  const match = line.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+){2,}\.trycloudflare\.com/i)
  if (match === null) return null
  const found = match[0].toLowerCase()
  /* The suffix constant is asserted by `tests/tunnel.test.mjs`; this keeps the
     regex and the documented suffix from drifting apart silently. */
  return found.endsWith(TUNNEL_QUICK_HOST_SUFFIX) ? found : null
}

/** Absolute path of the tunnel credential file. */
export function tunnelTokenPath(baseDir) {
  return path.join(baseDir, TUNNEL_TOKEN_FILE_NAME)
}

/** Longest/loosest bounds of one token value, shared with the admin API's check. */
export function isValidTunnelToken(value) {
  if (typeof value !== 'string') return false
  const token = value.trim()
  return token.length >= 8
    && token.length <= TUNNEL_TOKEN_MAX
    && !/\s/.test(token)
    && !/[\0-\x1f\x7f]/.test(token)
}

/**
 * Read the stored tunnel token.
 *
 * Returns `present` separately from `valid` so a corrupt file is reported as
 * "there is a token but it is unusable" (`tunnel/token-invalid`) instead of
 * "no token" — the two send the user to different next actions.
 *
 * @param {string} baseDir Runtime directory.
 * @returns {{ token: string, present: boolean, valid: boolean }}
 */
export function readTunnelToken(baseDir) {
  if (typeof baseDir !== 'string' || baseDir === '') return { token: '', present: false, valid: false }
  const file = tunnelTokenPath(baseDir)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { token: '', present: false, valid: false }
    }
    /* The file may exist but be unreadable; that is not "no token". */
    return { token: '', present: true, valid: false }
  }
  const token = raw.trim()
  const valid = isValidTunnelToken(token)
  return { token: valid ? token : '', present: true, valid }
}

/** Apply 0600 to a path, tolerating platforms without POSIX modes. */
function applySecretMode(filePath) {
  if (process.platform === 'win32') return
  try {
    chmodSync(filePath, 0o600)
  } catch {
    /* best-effort: a filesystem without mode support must not fail a save */
  }
}

/**
 * Store or clear the tunnel token.
 *
 * Empty string deletes the file (that is how the panel clears a token). Written
 * through the same temp → fsync → rename dance as `store.js`, because a torn
 * token file would be indistinguishable from a wrong token at the next start.
 *
 * @param {string} baseDir Runtime directory.
 * @param {string} token
 * @returns {{ tokenSet: boolean }}
 */
export function writeTunnelToken(baseDir, token) {
  if (typeof baseDir !== 'string' || baseDir === '') {
    throw tunnelError('tunnel/storage', 'the runtime directory is unknown')
  }
  const value = typeof token === 'string' ? token.trim() : ''
  const file = tunnelTokenPath(baseDir)

  if (value === '') {
    try {
      unlinkSync(file)
    } catch (error) {
      if (error === null || typeof error !== 'object' || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
        throw tunnelError('tunnel/storage', 'the tunnel token could not be removed')
      }
    }
    return { tokenSet: false }
  }

  if (!isValidTunnelToken(value)) {
    throw tunnelError('tunnel/token-invalid', 'the tunnel token is not usable')
  }

  try {
    mkdirSync(baseDir, { recursive: true, mode: 0o700 })
  } catch {
    throw tunnelError('tunnel/storage', 'the runtime directory could not be created')
  }

  const tempPath = `${file}.${process.pid}.tmp`
  let descriptor
  const bytes = Buffer.from(value, 'utf8')
  try {
    descriptor = openSync(tempPath, 'w', 0o600)
    let written = 0
    while (written < bytes.length) {
      written += writeSync(descriptor, bytes, written, bytes.length - written)
    }
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    applySecretMode(tempPath)
    renameSync(tempPath, file)
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        /* the descriptor may already be unusable; removing the temp file matters */
      }
    }
    try {
      unlinkSync(tempPath)
    } catch {
      /* nothing to clean up */
    }
    throw tunnelError('tunnel/storage', 'the tunnel token could not be saved')
  }
  applySecretMode(file)
  return { tokenSet: true }
}

/**
 * Split a byte stream into lines without losing a multi-byte character that spans
 * two chunks, and without letting a pathological line grow without bound.
 *
 * @param {(line: string) => void} onLine
 * @returns {{ push: (chunk: Buffer | string) => void, flush: () => void }}
 */
function createLineReader(onLine) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        onLine(line)
        newline = buffer.indexOf('\n')
      }
      if (buffer.length > 8_192) buffer = buffer.slice(-8_192)
    },
    flush() {
      const rest = `${buffer}${decoder.end()}`
      buffer = ''
      if (rest !== '') onLine(rest)
    },
  }
}

/**
 * Create the tunnel controller bound to one runtime directory.
 *
 * Every effect is injectable so tests never start a real `cloudflared`, never
 * sleep for the production timeouts, and never touch the network.
 *
 * @param {object} [options]
 * @param {string} [options.baseDir] Runtime directory (token file + downloaded binary).
 * @param {object} [options.logger] Host logger (`ctx.logger`).
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @param {Function} [options.spawnImpl] `node:child_process#spawn`, injectable for tests.
 * @param {typeof globalThis.fetch} [options.fetchImpl] Download transport, injectable.
 * @param {NodeJS.Platform | string} [options.platform]
 * @param {string} [options.arch]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {number} [options.startTimeoutMs]
 * @param {number} [options.readyGraceMs]
 * @param {number} [options.stopTimeoutMs]
 */
export function createTunnel(options = {}) {
  const baseDir = typeof options.baseDir === 'string' && options.baseDir !== ''
    ? options.baseDir
    : ''
  const logger = options.logger
  const now = typeof options.now === 'function' ? options.now : Date.now
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const arch = typeof options.arch === 'string' ? options.arch : process.arch
  const env = options.env !== null && typeof options.env === 'object' ? options.env : process.env
  const startTimeoutMs = Number.isFinite(options.startTimeoutMs) && options.startTimeoutMs > 0
    ? options.startTimeoutMs
    : TUNNEL_START_TIMEOUT_MS
  const readyGraceMs = Number.isFinite(options.readyGraceMs) && options.readyGraceMs > 0
    ? options.readyGraceMs
    : TUNNEL_READY_GRACE_MS
  const stopTimeoutMs = Number.isFinite(options.stopTimeoutMs) && options.stopTimeoutMs > 0
    ? options.stopTimeoutMs
    : TUNNEL_STOP_TIMEOUT_MS

  /** Last settings this controller was asked to run (not necessarily current). */
  let settings = defaultTunnel()
  /** `stopped` | `starting` | `running` | `failed`. */
  let state = 'stopped'
  /** Public URL, or '' when there is none. */
  let url = ''
  /** Stable-code error of the last failure, or null. */
  let failure = null
  /** ISO timestamp of the successful start, or null. */
  let startedAt = null
  /** The live child process, or null. */
  let child = null
  /** Fingerprint of the running configuration, so a no-op start does not restart. */
  let runningFingerprint = ''
  /** Recent output lines, diagnostics only (never returned by the API). */
  let recentLines = []
  /** Serialises start/stop/download so two panel clicks cannot interleave. */
  let operation = Promise.resolve()
  /** Set while a stop was requested, so an exit is not reported as a failure. */
  let stopRequested = false
  /** Set by `dispose`: no new start may begin and the current one is abandoned. */
  let disposed = false
  /** Resolves the in-flight start gate, so a stop need not wait for a URL timeout. */
  let activeGate = null

  /** Report one diagnostic line through the host logger. Never includes the token. */
  function log(level, message) {
    const sink = logger !== null && typeof logger === 'object' ? logger[level] : undefined
    if (typeof sink === 'function') sink.call(logger, message)
  }

  /** Fresh binary resolution. Cheap enough to run on every status read. */
  function binaryNow() {
    return resolveTunnelBinary({ baseDir, binaryPath: settings.binaryPath, platform, env })
  }

  /** The full status the API and the panel read. Never carries the token. */
  function describe() {
    const token = readTunnelToken(baseDir)
    const binary = binaryNow()
    return {
      enabled: settings.enabled,
      mode: settings.mode,
      publicUrl: settings.publicUrl,
      state,
      url,
      error: failure === null ? null : { code: failure.code, message: failure.message },
      /* `tokenSet` answers "is a usable token stored"; `tokenState` additionally
         distinguishes a missing file from a corrupt one, because the panel's next
         action differs (enter one vs. fix/clear a broken file). The VALUE is never
         part of either answer. */
      tokenSet: token.valid,
      tokenState: token.valid ? 'ok' : (token.present ? 'invalid' : 'none'),
      binary: {
        available: binary.available,
        source: binary.source,
        path: binary.path,
      },
      startedAt,
    }
  }

  /** Record one output line for diagnostics, bounded. */
  function remember(line) {
    if (typeof line !== 'string' || line === '') return
    recentLines.push(line)
    if (recentLines.length > TUNNEL_LOG_LINES_MAX) recentLines = recentLines.slice(-TUNNEL_LOG_LINES_MAX)
  }

  /** Move to `failed`, remembering the stable code. */
  function fail(code, message) {
    state = 'failed'
    failure = tunnelError(code, message)
    url = ''
    startedAt = null
    runningFingerprint = ''
    log('warn', `[remote-control] cloudflared failed (${code})`)
  }

  /** Drop the child reference and its listeners without touching the public state. */
  function detach() {
    const current = child
    child = null
    runningFingerprint = ''
    if (current !== null && typeof current === 'object') {
      try {
        current.removeAllListeners?.('exit')
        current.removeAllListeners?.('error')
        /* A ChildProcess emits `error` when it could not be killed; after this
           detach there is no handler left, and an unhandled `error` would crash
           the host. A no-op listener keeps that emission harmless. */
        current.on?.('error', () => {})
      } catch {
        /* a fake or already-destroyed child must not fail shutdown */
      }
    }
    return current
  }

  /** Kill the current child, gracefully first, then forcibly. */
  function killChild() {
    const current = detach()
    if (current === null) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          current.off?.('exit', finish)
        } catch {
          /* nothing to detach */
        }
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          current.kill?.('SIGKILL')
        } catch {
          /* the process may already be gone */
        }
        finish()
      }, stopTimeoutMs)
      try {
        current.once?.('exit', finish)
      } catch {
        /* nothing to listen on; the timeout still bounds this */
      }
      try {
        const killed = current.kill?.()
        if (killed === false) finish()
      } catch {
        finish()
      }
    })
  }

  /**
   * Attach output readers and the exit/error handlers to one child.
   *
   * `onEvent` tells the start attempt that something happened, so a quick-tunnel
   * wait does not sit until its timeout after the process already failed.
   *
   * @param {object} target Child process.
   * @param {{ quick: boolean, onEvent: (kind: 'url' | 'exit' | 'error') => void }} hooks
   */
  function watch(target, hooks) {
    const readLine = (line) => {
      /* The child may already have been replaced (restart) or detached (stop)
         while its pipe still had buffered output. Acting on it would resurrect a
         dead tunnel's URL on the replacement's state. */
      if (target !== child) return
      remember(line)
      if (hooks.quick !== true || url !== '') return
      const found = quickTunnelUrl(line)
      if (found === null) return
      url = found
      state = 'running'
      failure = null
      startedAt = new Date(now()).toISOString()
      log('info', '[remote-control] cloudflared running (quick)')
      hooks.onEvent('url')
    }

    for (const stream of [target.stdout, target.stderr]) {
      if (stream === null || typeof stream !== 'object') continue
      const reader = createLineReader(readLine)
      stream.setEncoding?.('utf8')
      stream.on('data', (chunk) => reader.push(chunk))
      stream.on('close', () => reader.flush())
    }

    const onExit = (code, signal) => {
      if (target !== child) return
      detach()
      if (stopRequested === true) {
        state = 'stopped'
        failure = null
        url = ''
        startedAt = null
        hooks.onEvent('exit')
        return
      }
      const detail = Number.isInteger(code) ? `exit ${String(code)}` : (typeof signal === 'string' ? signal : 'exit')
      state = 'failed'
      failure = tunnelError('tunnel/exited', `cloudflared stopped unexpectedly (${detail})`)
      url = ''
      startedAt = null
      runningFingerprint = ''
      log('warn', '[remote-control] cloudflared stopped unexpectedly')
      hooks.onEvent('exit')
    }

    const onError = () => {
      if (target !== child) return
      detach()
      fail('tunnel/spawn-failed', 'cloudflared could not be started')
      hooks.onEvent('error')
    }

    try {
      target.once('exit', onExit)
      target.once('error', onError)
    } catch {
      /* a real ChildProcess always supports these; a broken injected one is caught in start() */
    }
  }

  /** Stop the running process, or do nothing. Always ends in `stopped`. */
  async function stopInternal() {
    /* A stop that had nothing to stop is the common case on every gateway start
       (syncTunnel runs unconditionally) and must not print a line: the load-path
       tests prove "off means exactly one line", and a no-op stop is not news. */
    const hadSomething = child !== null || state !== 'stopped'
    if (child !== null) {
      stopRequested = true
      try {
        await killChild()
      } finally {
        stopRequested = false
      }
    }
    state = 'stopped'
    failure = null
    url = ''
    startedAt = null
    runningFingerprint = ''
    if (hadSomething) log('info', '[remote-control] cloudflared stopped')
  }

  /** Wait for `ms`, or for the child to exit, whichever comes first. */
  function waitFor(target, ms) {
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          target.off?.('exit', finish)
        } catch {
          /* nothing to detach */
        }
        resolve()
      }
      const timer = setTimeout(finish, ms)
      try {
        target.once('exit', finish)
      } catch {
        /* a real ChildProcess supports this; the timer still bounds the wait */
      }
    })
  }

  /** One start attempt. Never throws; ends in `running` or `failed`. */
  async function runStart(nextSettings, port) {
    stopRequested = false
    failure = null
    url = ''
    startedAt = null
    recentLines = []
    settings = normalizeTunnel(nextSettings)

    if (disposed === true) {
      state = 'stopped'
      return describe()
    }

    if (settings.enabled !== true) {
      await stopInternal()
      return describe()
    }

    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      fail('tunnel/no-port', 'the gateway port is unknown')
      return describe()
    }

    const binary = binaryNow()
    if (binary.available !== true || typeof binary.path !== 'string') {
      fail('tunnel/binary-missing', 'cloudflared was not found on this machine')
      return describe()
    }

    let token = ''
    if (settings.mode === 'token') {
      if (settings.publicUrl === '') {
        fail('tunnel/url-missing', 'a public hostname is required for a named tunnel')
        return describe()
      }
      const stored = readTunnelToken(baseDir)
      if (!stored.present) {
        fail('tunnel/token-missing', 'a tunnel token is required for a named tunnel')
        return describe()
      }
      if (!stored.valid) {
        fail('tunnel/token-invalid', 'the stored tunnel token is not usable')
        return describe()
      }
      token = stored.token
    }

    const fingerprint = [
      settings.mode,
      String(port),
      settings.binaryPath,
      settings.publicUrl,
      token,
    ].join('\u0000')

    if (state === 'running' && runningFingerprint === fingerprint) return describe()
    if (state === 'running' || state === 'starting' || child !== null) await stopInternal()

    state = 'starting'
    const quick = settings.mode === 'quick'
    const args = quick
      ? ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${String(port)}`]
      : ['tunnel', '--no-autoupdate', 'run', '--token-file', tunnelTokenPath(baseDir)]

    if (disposed === true) {
      state = 'stopped'
      return describe()
    }

    let spawned
    try {
      spawned = spawnImpl(binary.path, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        /* Explicit, even though it is the default: the package test asserts this
           literal is present wherever a process is spawned. */
        shell: false,
      })
    } catch {
      fail('tunnel/spawn-failed', 'cloudflared could not be started')
      return describe()
    }
    if (spawned === null || typeof spawned !== 'object') {
      fail('tunnel/spawn-failed', 'cloudflared could not be started')
      return describe()
    }

    child = spawned
    runningFingerprint = fingerprint

    /** @type {(kind: string) => void} */
    let signalEvent = () => {}
    const gate = new Promise((resolve) => {
      signalEvent = resolve
    })
    activeGate = signalEvent
    watch(spawned, {
      quick,
      onEvent: (kind) => {
        signalEvent(kind)
      },
    })

    if (quick) {
      const timer = setTimeout(() => signalEvent('timeout'), startTimeoutMs)
      const outcome = await gate
      activeGate = null
      clearTimeout(timer)
      if (disposed === true) {
        await killChild()
        state = 'stopped'
        return describe()
      }
      /* A stop that pre-empted the wait resolves the gate with `stop`. The queued
         stop will kill the process, but this attempt must not report `starting` —
         its caller would show a spinner for a tunnel that is already going away. */
      if (outcome === 'stop') {
        await killChild()
        state = 'stopped'
        failure = null
        url = ''
        startedAt = null
        return describe()
      }
      if (outcome === 'timeout' && child === spawned) {
        await killChild()
        fail('tunnel/start-timeout', 'cloudflared did not report a public URL in time')
      }
      if (child !== spawned || state !== 'running') return describe()
    } else {
      /* A token-mode tunnel is reported running once it survives the grace window;
         a malformed token makes `cloudflared` exit well inside it. */
      await waitFor(spawned, readyGraceMs)
      activeGate = null
      if (disposed === true) {
        await killChild()
        state = 'stopped'
        return describe()
      }
      if (child !== spawned) return describe()
      state = 'running'
      failure = null
      url = settings.publicUrl
      startedAt = new Date(now()).toISOString()
      log('info', '[remote-control] cloudflared running (token)')
    }

    return describe()
  }

  /**
   * Serialise one operation behind any in-flight one.
   *
   * The chain must survive a failed operation, or one bad spawn would poison every
   * later click.
   *
   * @param {() => Promise<object>} task
   * @returns {Promise<object>}
   */
  function enqueue(task) {
    const run = operation.then(task, task)
    operation = run.then(() => undefined, () => undefined)
    return run
  }

  const controller = {
    /**
     * Adopt settings WITHOUT touching the process.
     *
     * The index reconfigures the tunnel when the gateway is off: there is nowhere
     * to forward to, so nothing should run, but the panel must still read back what
     * the user just saved (`enabled`, `mode`, `publicUrl`). `start` cannot express
     * that — it would try to spawn and report a failure for a state the user did
     * not ask to run yet.
     *
     * @param {object} next
     * @returns {object} The updated status.
     */
    configure(next) {
      settings = normalizeTunnel(next)
      return describe()
    },

    /**
     * Current status. Pure read: no process is touched and no network is used,
     * but the binary lookup stats PATH so a freshly installed program shows up
     * without a restart.
     */
    describe,

    /**
     * Start (or restart) the tunnel for one gateway port.
     *
     * @param {{ settings: object, port: number }} input
     * @returns {Promise<object>} The resulting status; never rejects for a tunnel
     *   problem.
     */
    start(input) {
      if (disposed === true) return Promise.resolve(describe())
      const nextSettings = input?.settings
      const port = Number.isInteger(input?.port) ? input.port : null
      return enqueue(() => runStart(nextSettings, port))
    },

    /** Stop the tunnel. Idempotent; resolves with the resulting status. */
    stop() {
      /* A stop clicked while a quick tunnel is still waiting for its URL must not
         queue behind the 30 s timeout: resolve the gate now, let the start return,
         then the queued stop kills the process. */
      if (state === 'starting' && typeof activeGate === 'function') activeGate('stop')
      return enqueue(async () => {
        await stopInternal()
        return describe()
      })
    },

    /** Stop then start with the same settings and port. */
    restart(input) {
      return enqueue(async () => {
        await stopInternal()
        return runStart(input?.settings, Number.isInteger(input?.port) ? input.port : null)
      })
    },

    /**
     * Download the official binary into the runtime directory.
     *
     * Refused while a process is live: replacing an executable that is running is
     * a Windows failure, and reporting success while the old build keeps running
     * would be the reassuring-and-wrong state this package forbids.
     *
     * @returns {Promise<{ path: string, version: string }>}
     */
    download() {
      /* Checked BEFORE the queue: a download requested during a start would
         otherwise wait for that start (up to 30 s) and only then discover it has
         to refuse. */
      if (child !== null || state === 'starting') {
        return Promise.reject(tunnelError('tunnel/busy', 'the tunnel is running'))
      }
      return enqueue(async () => {
        if (child !== null || state === 'starting') {
          throw tunnelError('tunnel/busy', 'the tunnel is running')
        }
        const installed = await downloadTunnelBinary({ baseDir, platform, arch, fetchImpl })
        /* A tunnel that was only failed because the binary was missing is now
           startable; leaving the stale error would make the card contradict the
           successful download right above it. Any other failure (bad token, bad
           URL) is still true and is kept. */
        if (failure !== null && failure.code === 'tunnel/binary-missing') {
          state = 'stopped'
          failure = null
        }
        return installed
      })
    },

    /** Store or clear the tunnel token (`''` clears). */
    writeToken(token) {
      return writeTunnelToken(baseDir, token)
    },

    /** Stop and release everything. Never throws, so it is safe as a disposer. */
    async dispose() {
      disposed = true
      stopRequested = true
      if (typeof activeGate === 'function') activeGate('disposed')
      const current = child
      if (current !== null && typeof current === 'object') {
        try {
          current.kill?.('SIGTERM')
        } catch {
          /* the process may already be gone */
        }
        /* Do not await the exit: unload must not hang on a process that ignores
           the signal. The kill timer is unref'd so it cannot hold the host open. */
        const timer = setTimeout(() => {
          try {
            current.kill?.('SIGKILL')
          } catch {
            /* already gone */
          }
        }, stopTimeoutMs)
        timer.unref?.()
        try {
          current.removeAllListeners?.('exit')
          current.removeAllListeners?.('error')
        } catch {
          /* a fake or already-destroyed child must not fail unload */
        }
      }
      child = null
      state = 'stopped'
      failure = null
      url = ''
      startedAt = null
      runningFingerprint = ''
      activeGate = null
    },

    /** Absolute path of the downloaded binary, for diagnostics and tests. */
    downloadedPath() {
      return path.join(baseDir, downloadedBinaryLeaf(platform))
    },

    /** Recent output lines. Diagnostics/tests only; the API never reads this. */
    recentOutput() {
      return recentLines.slice()
    },
  }

  return controller
}
