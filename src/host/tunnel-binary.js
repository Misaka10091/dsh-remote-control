/**
 * dsh-remote-control — locating and installing the `cloudflared` binary.
 *
 * `prd.md` R4/R5 ask for two sources: a binary the user already has (PATH or an
 * explicit path) and one this plugin can fetch from Cloudflare's official GitHub
 * release. Both live here so `tunnel.js` can stay about the PROCESS and this file
 * can stay about FILES.
 *
 * ## Why this file is allowed to download an executable
 *
 * `tests/package.test.mjs` used to assert that no host module shells out, and that
 * still holds for everything except the tunnel modules. Downloading an executable
 * is the strongest action in the package, so its bounds are deliberately narrow:
 *
 *   - the metadata host is a CONSTANT (`TUNNEL_RELEASE_API`), never a setting;
 *   - the asset URL must be `https://github.com/...`, checked before a byte is
 *     written (`TUNNEL_ASSET_HOST`);
 *   - the sha256 comes from GitHub's own API response for that asset and is
 *     REQUIRED — a response without a digest installs nothing;
 *   - the download has a byte cap and a deadline;
 *   - the file is written to a temp name, verified, then `rename`d into place, so
 *     an interrupted download can never leave a half binary that looks runnable.
 *
 * It never runs automatically: `POST /tunnel/download` is the only caller, and the
 * panel only offers the button while no binary is available.
 *
 * ## Dependency direction
 *
 * Builds on Node built-ins only (`node:crypto`, `node:fs`, `node:path`,
 * `node:zlib`). No `child_process`, no gateway import, no network module beyond
 * the injected `fetch`.
 */
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import {
  TUNNEL_ASSET_HOST,
  TUNNEL_BINARY_FILE_NAME,
  TUNNEL_DOWNLOAD_MAX_BYTES,
  TUNNEL_DOWNLOAD_TIMEOUT_MS,
  TUNNEL_RELEASE_API,
} from './constants.js'

/** Build an Error carrying a stable `code` (`.trellis/spec/backend/error-handling.md`). */
function tunnelError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Leaf name of the binary inside the runtime directory.
 *
 * `cloudflared.exe` on Windows and `cloudflared` everywhere else. Exported because
 * `tunnel.js` reports the resolved path and the panel shows its source; keeping
 * the platform spelling in one place means the two cannot disagree.
 *
 * @param {NodeJS.Platform | string} platform
 * @returns {string}
 */
export function downloadedBinaryLeaf(platform) {
  return platform === 'win32' ? `${TUNNEL_BINARY_FILE_NAME}.exe` : TUNNEL_BINARY_FILE_NAME
}

/**
 * Asset table: one row per platform/arch this plugin can install.
 *
 * Measured against `cloudflared` 2026.10.1 (`research/cloudflared-facts.md` §3).
 * Windows arm64 is absent from the official release, and there is no honest way to
 * install a binary that does not exist — that combination answers
 * `tunnel/unsupported-platform` instead of guessing.
 */
const ASSETS = Object.freeze({
  'win32-x64': { asset: 'cloudflared-windows-amd64.exe', archive: null },
  'win32-ia32': { asset: 'cloudflared-windows-386.exe', archive: null },
  'linux-x64': { asset: 'cloudflared-linux-amd64', archive: null },
  'linux-ia32': { asset: 'cloudflared-linux-386', archive: null },
  'linux-arm64': { asset: 'cloudflared-linux-arm64', archive: null },
  'linux-arm': { asset: 'cloudflared-linux-arm', archive: null },
  'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz', archive: 'tgz' },
  'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', archive: 'tgz' },
})

/** `sha256:<64 hex>` — the only digest form accepted from the release API. */
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/i

/**
 * Whether a path is an existing regular file.
 *
 * `statSync` and not `accessSync` alone: a directory named `cloudflared` on PATH
 * must not be treated as the program.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Whether a POSIX path is executable by this process.
 *
 * A no-op on Windows, where the extension is what makes a file runnable and there
 * is no `X_OK` bit to test.
 *
 * @param {string} candidate
 * @param {boolean} windows
 * @returns {boolean}
 */
function isExecutable(candidate, windows) {
  if (!isFile(candidate)) return false
  if (windows) return true
  try {
    accessSync(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find one command on PATH, honouring Windows' `PATHEXT`.
 *
 * Deliberately not a shell lookup: no `where`/`which` child process, no command
 * string, no glob. A missing PATH entry is skipped; an empty PATH yields null.
 *
 * @param {string} command Bare file name (`cloudflared`, `cloudflared.exe`).
 * @param {object} [options]
 * @param {NodeJS.Platform | string} [options.platform]
 * @param {Record<string, string | undefined>} [options.env]
 * @returns {string | null}
 */
export function findOnPath(command, options = {}) {
  if (typeof command !== 'string' || command === '') return null
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const env = options.env !== null && typeof options.env === 'object' ? options.env : process.env
  const windows = platform === 'win32'
  const rawPath = windows ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '')
  if (typeof rawPath !== 'string' || rawPath === '') return null

  const separator = windows ? ';' : ':'
  const directories = rawPath
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry !== '')
  const extensions = windows
    ? (typeof env.PATHEXT === 'string' && env.PATHEXT !== ''
      /* Only formats CreateProcess can start directly. `.BAT` / `.CMD` need
         `cmd.exe`, and this package spawns with `shell: false` on principle, so
         accepting them would resolve to a file that cannot actually run. */
      ? env.PATHEXT.split(';').filter((entry) => /^\.(?:com|exe)$/i.test(entry))
      : ['.COM', '.EXE'])
    : ['']
  /* A name that already carries an extension is tried as-is first; the empty
     suffix also covers the POSIX case where there is no extension concept. */
  const suffixes = command.includes('.') ? [''] : ['', ...extensions]

  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${command}${suffix}`)
      if (isExecutable(candidate, windows)) return candidate
    }
  }
  return null
}

/**
 * Whether a configured `binaryPath` is a bare command name rather than a path.
 *
 * Bare means "no separator": `cloudflared` and `cloudflared.exe` are looked up on
 * PATH, while `C:\Tools\cloudflared.exe`, `/usr/local/bin/cloudflared` and
 * `.\bin\cloudflared.exe` are treated as paths. `tunnel.js#validateTunnel` refuses
 * the last shape when it is relative, so reaching this function with one is a
 * caller bug rather than a supported spelling.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isBareCommand(value) {
  return !value.includes('/') && !value.includes('\\')
}

/**
 * The binary this process should run, or a `missing` answer that says why.
 *
 * Order is `custom` → `path` → `downloaded`:
 *
 *   - a configured path is authoritative. If it does not resolve, the answer is
 *     `missing` and NOT a silent fallback — a typo must not be masked by an older
 *     copy that happens to sit elsewhere (`prd.md` R4);
 *   - PATH next, because a system package is what the user maintains and updates;
 *   - the downloaded copy last, so it only serves the case it was created for
 *     (nothing installed). Downloading explicitly does not shadow a managed
 *     install on the next start.
 *
 * Synchronous on purpose: it stats a handful of paths and `GET /tunnel` /
 * `GET /state` call it during a read.
 *
 * @param {object} options
 * @param {string} options.baseDir Runtime directory that may hold a downloaded copy.
 * @param {string} [options.binaryPath] `settings.tunnel.binaryPath`.
 * @param {NodeJS.Platform | string} [options.platform]
 * @param {Record<string, string | undefined>} [options.env]
 * @returns {{ available: boolean, source: 'custom' | 'path' | 'downloaded' | 'missing', path: string | null }}
 */
export function resolveTunnelBinary(options) {
  const baseDir = typeof options?.baseDir === 'string' ? options.baseDir : ''
  const platform = typeof options?.platform === 'string' ? options.platform : process.platform
  const env = options?.env !== null && typeof options.env === 'object' ? options.env : process.env
  const windows = platform === 'win32'
  const configured = typeof options?.binaryPath === 'string' ? options.binaryPath.trim() : ''

  if (configured !== '') {
    const resolved = isBareCommand(configured)
      ? findOnPath(configured, { platform, env })
      : (isExecutable(configured, windows) ? configured : null)
    return resolved === null
      ? { available: false, source: 'missing', path: null }
      : { available: true, source: 'custom', path: resolved }
  }

  const onPath = findOnPath(TUNNEL_BINARY_FILE_NAME, { platform, env })
  if (onPath !== null) return { available: true, source: 'path', path: onPath }

  if (baseDir !== '') {
    const downloaded = path.join(baseDir, downloadedBinaryLeaf(platform))
    if (isExecutable(downloaded, windows)) {
      return { available: true, source: 'downloaded', path: downloaded }
    }
  }

  return { available: false, source: 'missing', path: null }
}

/**
 * Pick the release asset for this platform/arch, or explain why there is none.
 *
 * @param {string} platform
 * @param {string} arch
 * @returns {{ asset: string, archive: 'tgz' | null }}
 */
export function assetFor(platform, arch) {
  const row = ASSETS[`${platform}-${arch}`]
  if (row === undefined) {
    throw tunnelError(
      'tunnel/unsupported-platform',
      `cloudflared has no published build for ${platform}/${arch}`,
    )
  }
  return { ...row }
}

/**
 * Read a `sha256:<hex>` digest, or null when the value is absent or malformed.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function digestOf(value) {
  if (typeof value !== 'string') return null
  const match = value.match(DIGEST_PATTERN)
  return match === null ? null : match[1].toLowerCase()
}

/**
 * SHA-256 of a buffer, lower-case hex.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Fetch JSON with a deadline, refusing anything that is not a 2xx object.
 *
 * The deadline is applied through `AbortSignal.timeout`, which Node 18 provides.
 * A test's injected fetch may ignore it; the production path is what it is for.
 *
 * @param {typeof globalThis.fetch} fetchImpl
 * @param {string} url
 * @param {number} timeoutMs
 * @param {string} failureCode Stable code to throw on a transport/parse failure.
 * @returns {Promise<Record<string, unknown>>}
 */
async function fetchJson(fetchImpl, url, timeoutMs, failureCode) {
  let response
  try {
    const signal = typeof globalThis.AbortSignal?.timeout === 'function'
      ? globalThis.AbortSignal.timeout(timeoutMs)
      : undefined
    response = await fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json' },
      ...(signal === undefined ? {} : { signal }),
    })
  } catch {
    throw tunnelError(failureCode, 'the release metadata could not be fetched')
  }
  if (response === null || typeof response !== 'object' || response.ok !== true) {
    throw tunnelError(failureCode, 'the release metadata request was refused')
  }
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw tunnelError(failureCode, 'the release metadata was not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw tunnelError(failureCode, 'the release metadata was not a JSON object')
  }
  return parsed
}

/**
 * Download one asset, bounded in size and time.
 *
 * `content-length` is checked before the body is read when present; the size is
 * checked again afterwards, because a header is a hint and the buffer is the fact.
 *
 * @param {typeof globalThis.fetch} fetchImpl
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Buffer>}
 */
async function fetchAsset(fetchImpl, url, timeoutMs) {
  let response
  try {
    const signal = typeof globalThis.AbortSignal?.timeout === 'function'
      ? globalThis.AbortSignal.timeout(timeoutMs)
      : undefined
    response = await fetchImpl(url, {
      redirect: 'follow',
      ...(signal === undefined ? {} : { signal }),
    })
  } catch {
    throw tunnelError('tunnel/download-failed', 'the cloudflared download could not be started')
  }
  if (response === null || typeof response !== 'object' || response.ok !== true) {
    throw tunnelError('tunnel/download-failed', 'the cloudflared download was refused')
  }

  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > TUNNEL_DOWNLOAD_MAX_BYTES) {
    throw tunnelError('tunnel/download-failed', 'the cloudflared download is larger than this plugin accepts')
  }

  let buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch {
    throw tunnelError('tunnel/download-failed', 'the cloudflared download did not complete')
  }
  if (buffer.length === 0 || buffer.length > TUNNEL_DOWNLOAD_MAX_BYTES) {
    throw tunnelError('tunnel/download-failed', 'the cloudflared download has an unusable size')
  }
  return buffer
}

/**
 * Extract the single `cloudflared` executable from a ustar `.tgz`.
 *
 * A full tar implementation would be a dependency; the official macOS archive is
 * one gzip-compressed tar with one ordinary file, so this walks the 512-byte
 * headers and returns the first regular entry's bytes. Every offset is bounds
 * checked, and a malformed archive is a `tunnel/download-failed` rather than an
 * exception escaping with a raw `RangeError`.
 *
 * @param {Buffer} tgz
 * @returns {Buffer}
 */
export function extractBinaryFromTgz(tgz) {
  let tar
  try {
    tar = gunzipSync(tgz)
  } catch {
    throw tunnelError('tunnel/download-failed', 'the macOS archive could not be decompressed')
  }

  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    /* Two zero blocks terminate the archive. */
    let allZero = true
    for (const byte of header) {
      if (byte !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break

    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim()
    const size = Number.parseInt(sizeText === '' ? '0' : sizeText, 8)
    if (!Number.isFinite(size) || size < 0) {
      throw tunnelError('tunnel/download-failed', 'the macOS archive has an unreadable entry')
    }
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) {
      throw tunnelError('tunnel/download-failed', 'the macOS archive is truncated')
    }
    if (type === '0') return tar.subarray(dataStart, dataEnd)
    /* GNU long name (`L`) and pax headers (`x`/`g`) are metadata; skip their body. */
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  throw tunnelError('tunnel/download-failed', 'the macOS archive contained no executable')
}

/**
 * Write one buffer to its final path through a temp file in the same directory.
 *
 * Same reasoning as `store.js`: `writeFileSync(target)` truncates first, and an
 * interrupted write would publish a truncated executable. Temp → `fsync` → rename
 * means a reader sees either nothing or the complete file.
 *
 * @param {string} target
 * @param {Buffer} bytes
 * @param {boolean} windows
 */
function installAtomically(target, bytes, windows) {
  const directory = path.dirname(target)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  } catch {
    throw tunnelError('tunnel/download-failed', 'the runtime directory could not be created')
  }
  const tempPath = `${target}.${process.pid}.download`
  let descriptor
  try {
    descriptor = openSync(tempPath, 'w', 0o700)
    let written = 0
    while (written < bytes.length) {
      written += writeSync(descriptor, bytes, written, bytes.length - written)
    }
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (!windows) chmodSync(tempPath, 0o755)
    renameSync(tempPath, target)
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        /* the descriptor may already be unusable; removing the temp file is what matters */
      }
    }
    try {
      unlinkSync(tempPath)
    } catch {
      /* nothing to clean up, or the platform refused — the thrown error is the news */
    }
    if (error !== null && typeof error === 'object' && error.code === 'tunnel/download-failed') throw error
    throw tunnelError('tunnel/download-failed', 'the downloaded cloudflared could not be installed')
  }
}

/**
 * Download and install the official `cloudflared` for this machine.
 *
 * @param {object} options
 * @param {string} options.baseDir Runtime directory that receives the binary.
 * @param {NodeJS.Platform | string} [options.platform]
 * @param {string} [options.arch]
 * @param {typeof globalThis.fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ path: string, version: string }>}
 */
export async function downloadTunnelBinary(options) {
  const baseDir = typeof options?.baseDir === 'string' && options.baseDir !== '' ? options.baseDir : ''
  if (baseDir === '') throw tunnelError('tunnel/download-failed', 'the runtime directory is unknown')
  const platform = typeof options?.platform === 'string' ? options.platform : process.platform
  const arch = typeof options?.arch === 'string' ? options.arch : process.arch
  const fetchImpl = typeof options?.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const timeoutMs = Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : TUNNEL_DOWNLOAD_TIMEOUT_MS
  if (typeof fetchImpl !== 'function') {
    throw tunnelError('tunnel/download-failed', 'this host has no fetch implementation')
  }

  const asset = assetFor(platform, arch)
  const metadata = await fetchJson(fetchImpl, TUNNEL_RELEASE_API, timeoutMs, 'tunnel/download-failed')
  const assets = Array.isArray(metadata.assets) ? metadata.assets : []
  const entry = assets.find((candidate) => candidate !== null
    && typeof candidate === 'object'
    && candidate.name === asset.asset)
  if (entry === undefined) {
    throw tunnelError('tunnel/download-failed', 'the release does not publish a build for this machine')
  }

  const expected = digestOf(entry.digest)
  if (expected === null) {
    throw tunnelError('tunnel/download-failed', 'the release asset has no published sha256 digest')
  }

  let url
  try {
    url = new URL(String(entry.browser_download_url))
  } catch {
    throw tunnelError('tunnel/download-failed', 'the release asset URL is not usable')
  }
  if (url.protocol !== 'https:' || url.hostname !== TUNNEL_ASSET_HOST) {
    throw tunnelError('tunnel/download-failed', 'the release asset is not hosted on the expected host')
  }

  const downloaded = await fetchAsset(fetchImpl, url.href, timeoutMs)
  const actual = sha256(downloaded)
  if (actual !== expected) {
    throw tunnelError('tunnel/download-failed', 'the downloaded file does not match its published digest')
  }

  const binary = asset.archive === 'tgz' ? extractBinaryFromTgz(downloaded) : downloaded
  if (binary.length < 1024) {
    throw tunnelError('tunnel/download-failed', 'the downloaded file is not a usable binary')
  }

  const target = path.join(baseDir, downloadedBinaryLeaf(platform))
  installAtomically(target, binary, platform === 'win32')
  return {
    path: target,
    version: typeof metadata.tag_name === 'string' ? metadata.tag_name : '',
  }
}
