/**
 * dsh-remote-control — device storage.
 *
 * Owns `~/.dsh/remote-control/devices.json`: the device table plus the plugin's
 * settings (`design.md` §5, PRD D4). This is the only module in the package
 * that knows where the file lives; everything else receives a `baseDir`.
 *
 * Four properties matter here, and each one is a deliberate choice:
 *
 *   - ATOMIC WRITE. `writeFileSync(target)` truncates first, so a crash mid-write
 *     leaves half a JSON document and the whole device table is gone. We write a
 *     temp file in the SAME directory, `fsync` it, then `rename` — rename is
 *     atomic within a filesystem, so a reader sees either the old document or the
 *     new one, never a partial one.
 *   - MODE 0600. The file holds the device table: which devices are paired, what
 *     they are called, when they were last seen. That is not other users'
 *     business. The mode is applied at creation time (not afterwards) so the file
 *     is never briefly readable. On Windows the permission model has no 0600,
 *     `chmod` only toggles the read-only bit, so the call is a guarded no-op — it
 *     MUST NOT throw, or the plugin would refuse to start on the primary dev
 *     platform.
 *   - CORRUPTION IS AN ERROR. A file that exists but does not parse raises
 *     `store/corrupt` instead of being treated as an empty table. "Silently empty"
 *     would look identical to "all devices unpaired", which is a security-relevant
 *     lie in the other direction (`.trellis/spec/backend/database-guidelines.md`).
 *   - FORWARD VERSIONS ARE REFUSED. `version > 1` raises
 *     `store/version-unsupported` rather than being best-effort parsed.
 *
 * The module generates no random values (that is `tokens.js`); it only takes a
 * clock, which is injectable so tests need not wait.
 */
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
import { homedir } from 'node:os'
import path from 'node:path'

import { defaultAccess, normalizeAccess } from './addresses.js'
import {
  DEFAULT_GATEWAY_PORT,
  DEVICES_FILE_MODE,
  DEVICES_FILE_NAME,
  DEVICES_VERSION,
  RUNTIME_DIR_NAME,
  TOKEN_HASH_PATTERN,
} from './constants.js'

/** Build an Error carrying a stable `code` (see `.trellis/spec/backend/error-handling.md`). */
function storeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Default location: `<home>/.dsh/remote-control`.
 *
 * `os.homedir()` and not `~` — `~` is a shell expansion, Node never resolves it.
 * This is the ONLY place in the package that resolves the user's home.
 *
 * @returns {string}
 */
export function defaultBaseDir() {
  return path.join(homedir(), '.dsh', RUNTIME_DIR_NAME)
}

/** A brand-new, empty document. Never shared between stores — always a fresh object. */
function emptyDocument() {
  return {
    version: DEVICES_VERSION,
    devices: [],
    settings: { enabled: false, port: DEFAULT_GATEWAY_PORT, access: defaultAccess() },
  }
}

/**
 * Normalizing `settings.access` is delegated to `addresses.js#normalizeAccess`,
 * which is the LENIENT policy of that module's `readAccess`: it keeps what
 * survives, drops what does not, and never throws. This file always takes that
 * path on purpose — a `devices.json` on disk must NEVER fail to load because of a
 * hand edit (`database-guidelines.md`: forward-compatible additions, defaults for
 * missing fields). A broken address book is a broken LINK, not a broken plugin, so
 * it degrades to "no addresses" and the panel says so. The strict twin,
 * `validateAccess`, is what `POST /settings` answers `400 admin/invalid-access`
 * with; same rules, different policy.
 */

/** Coerce a timestamp-ish value to a string, or null. */
function asRecordedTime(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Project one stored device onto the documented field order.
 *
 * Field order is fixed by `design.md` §5 / `database-guidelines.md`: the reserved
 * `capabilities` slot sits last so a future version can fill it in place without
 * rewriting the document shape. Rebuilding the object (rather than spreading the
 * parsed one) also drops unknown keys a hand-edit may have left behind.
 *
 * `tokenHash` is LEGACY (`research/jwt-device-credential.md` §3.6). The credential
 * is a signed JWT now, so no new row carries a hash and nothing authenticates
 * against one. The field is still READ when an old `devices.json` has it, and still
 * VALIDATED as a sha256 hex digest when present, so `version: 1` parses exactly as
 * it did before and a hand-edited file is refused rather than half-understood. What
 * changed is only that a row may now omit it: a fresh document has no hash to
 * store, and requiring one would make `addDevice` impossible to call.
 *
 * `id` remains mandatory. It is the row key AND the JWT `sub`, so a device without
 * one is a device that can never be authenticated — accepting it would leave an
 * unusable row in the table (`error-handling.md` — do not silently swallow store
 * damage).
 *
 * `code` is the error raised for a bad record. Reading from disk raises
 * `store/corrupt`; `addDevice` being handed a malformed record raises
 * `store/invalid-device`. The distinction matters for diagnosis: "devices.json is
 * corrupt" sends an operator to inspect the file, when the real fault is in the
 * caller that built the record.
 *
 * @param {unknown} stored
 * @param {'store/corrupt' | 'store/invalid-device'} [code]
 */
function normalizeDevice(stored, code = 'store/corrupt') {
  /* Only the two documented codes are accepted. `Array.prototype.map` passes the
     INDEX as the second argument, so `devices.map(normalizeDevice)` would have
     produced `error.code === 0` — a stable-string-code contract silently broken.
     Call sites are named arrows now, and this guard means a future one cannot
     reintroduce it. */
  const errorCode = code === 'store/invalid-device' ? code : 'store/corrupt'
  if (stored === null || typeof stored !== 'object') {
    throw storeError(errorCode, 'device record is not an object')
  }
  const id = typeof stored.id === 'string' ? stored.id : ''
  if (id === '') {
    throw storeError(errorCode, 'device record is missing id')
  }
  const tokenHash = typeof stored.tokenHash === 'string' ? stored.tokenHash : ''
  /* Present-but-malformed is refused; absent is fine (a JWT-era row has none). */
  if (tokenHash !== '' && !TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw storeError(errorCode, 'device record tokenHash is not a sha256 hex digest')
  }
  return {
    id,
    name: typeof stored.name === 'string' ? stored.name : '',
    /* Omitted from the object entirely when there is nothing to say, so a fresh
       `devices.json` does not carry `"tokenHash": ""` forever. Field order for an
       old document is preserved because the spread below keeps it. */
    ...(tokenHash === '' ? {} : { tokenHash }),
    ua: typeof stored.ua === 'string' ? stored.ua : '',
    createdAt: asRecordedTime(stored.createdAt),
    lastSeenAt: asRecordedTime(stored.lastSeenAt),
    revokedAt: asRecordedTime(stored.revokedAt),
    capabilities: stored.capabilities ?? null,
  }
}

/**
 * Validate and normalize a whole document that came from disk.
 *
 * Backfills fields a future-but-compatible version may omit, so an old file keeps
 * loading (forward-compatible additions only — see `database-guidelines.md`).
 */
function normalizeDocument(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw storeError('store/corrupt', 'devices.json is not a JSON object')
  }
  const version = parsed.version
  if (version === undefined) throw storeError('store/corrupt', 'devices.json has no version field')
  if (!Number.isInteger(version) || version < 1) {
    throw storeError('store/corrupt', 'devices.json version is not a positive integer')
  }
  if (version > DEVICES_VERSION) {
    throw storeError('store/version-unsupported', 'devices.json was written by a newer plugin version')
  }
  const devices = parsed.devices
  if (!Array.isArray(devices)) throw storeError('store/corrupt', 'devices.json devices field is not an array')

  const settings = parsed.settings !== null && typeof parsed.settings === 'object' ? parsed.settings : {}
  /* Same bounds as the write path: a hand-edited port outside 1-65535 falls back
     to the default rather than making the gateway try to bind something invalid. */
  const port = Number.isInteger(settings.port) && settings.port > 0 && settings.port <= 65535
    ? settings.port
    : DEFAULT_GATEWAY_PORT

  return {
    version: DEVICES_VERSION,
    /* Named arrow, not `devices.map(normalizeDevice)`: `map` passes the INDEX as
       the second argument, which would land in `normalizeDevice`'s `code`
       parameter and produce a numeric error code. */
    devices: devices.map((device) => normalizeDevice(device, 'store/corrupt')),
    settings: {
      enabled: settings.enabled === true,
      port,
      /* Additive and backfilled: a `devices.json` written before this field
         existed loads with the documented defaults instead of needing a
         migration (`database-guidelines.md` §Migrations). */
      access: normalizeAccess(settings.access),
    },
  }
}

/**
 * Remove a temp file, ignoring "already gone" and lock errors.
 *
 * Used only on failure paths, so the original error stays the interesting one.
 */
function unlinkQuietly(filePath) {
  try {
    unlinkSync(filePath)
  } catch {
    /* nothing to clean up, or the platform refused — the thrown error is the news */
  }
}

/**
 * Apply 0600 to a path, tolerating platforms that have no such concept.
 *
 * Windows has no POSIX mode bits; `chmod` there only flips the read-only flag.
 * The spec is explicit that this must never be fatal, so the failure is swallowed
 * WITH a comment — this is not a silent security downgrade, because on that
 * platform there is no 0600 to enforce in the first place.
 */
function applyFileMode(filePath) {
  if (process.platform === 'win32') return
  try {
    chmodSync(filePath, DEVICES_FILE_MODE)
  } catch {
    /* POSIX perms are best-effort here: a filesystem without mode support (some
       network shares / FAT mounts) must not stop the plugin from starting. */
  }
}

/**
 * Create a store bound to one directory.
 *
 * @param {object} [options]
 * @param {string} [options.baseDir] Directory holding `devices.json`. Defaults to {@link defaultBaseDir}.
 * @param {() => number} [options.now] Clock in epoch milliseconds; injectable so tests need not wait.
 * @returns {ReturnType<typeof buildStore>}
 */
export function createStore(options = {}) {
  const baseDir = typeof options.baseDir === 'string' && options.baseDir !== '' ? options.baseDir : defaultBaseDir()
  const now = typeof options.now === 'function' ? options.now : Date.now
  return buildStore(baseDir, now)
}

/** @param {string} baseDir @param {() => number} now */
function buildStore(baseDir, now) {
  const devicesPath = path.join(baseDir, DEVICES_FILE_NAME)
  const stamp = () => new Date(now()).toISOString()

  /** Monotonic temp-file suffix, so two writers in one process never collide. */
  let tempSequence = 0

  /** Create the runtime directory if needed. 0700 is likewise POSIX-only. */
  function ensureDir() {
    try {
      mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    } catch {
      /* A base path that cannot become a directory (the parent is a file, the
         volume is read-only, permissions denied) is a write failure, not an
         unhandled errno escaping to the caller. */
      throw storeError('store/write-failed', 'the remote-control directory could not be created')
    }
  }

  /**
   * Read the document.
   *
   * A missing file is not an error — it is a first run, and returns a fresh empty
   * document. A file that exists but fails to parse is an error.
   */
  function read() {
    let raw
    try {
      raw = readFileSync(devicesPath, 'utf8')
    } catch (error) {
      /* `ENOENT` is "no such file"; `ENOTDIR` is "a component of the path is not a
         directory", which is what Linux reports where Windows reports `ENOENT` for
         the same setup — a base directory that is really a regular file. Both mean
         "no devices.json here yet", so the first run stays a first run on every
         platform and the genuine failure (the directory cannot be made) is reported
         by `ensureDir` as `store/write-failed` instead of being pre-empted here. */
      if (error !== null && typeof error === 'object'
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return emptyDocument()
      throw storeError('store/unreadable', 'devices.json could not be read')
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw storeError('store/corrupt', 'devices.json is not valid JSON')
    }
    return normalizeDocument(parsed)
  }

  /**
   * Replace the document atomically.
   *
   * Temp file in the same directory → write → `fsync` → `rename`. Same directory
   * matters: `rename` is only atomic within one filesystem.
   *
   * @param {{ version?: number, devices: unknown[], settings?: { enabled?: boolean, port?: number, access?: object } }} document
   */
  function write(document) {
    const normalized = normalizeDocument(
      Object.assign({ version: DEVICES_VERSION }, document, { settings: document.settings ?? {} }),
    )
    ensureDir()
    /* The pid and a counter keep two writers from colliding on the temp path; no
       randomness is drawn here (that belongs to tokens.js). */
    tempSequence += 1
    const tempPath = `${devicesPath}.${process.pid}.${tempSequence}.tmp`
    const payload = `${JSON.stringify(normalized, null, 2)}\n`
    /* Encode once and write by offset. `writeSync` may report a SHORT write, and a
       short write here is the exact failure the whole temp-file dance exists to
       prevent: the rename would publish a truncated document. Looping until every
       byte is on disk is the only way to know the file is complete. */
    const payloadBytes = Buffer.from(payload, 'utf8')

    let fd
    try {
      fd = openSync(tempPath, 'w', DEVICES_FILE_MODE)
      let written = 0
      while (written < payloadBytes.length) {
        written += writeSync(fd, payloadBytes, written, payloadBytes.length - written)
      }
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
    } catch {
      /* Close whatever was opened, then drop the partial temp file: the target
         document is still untouched, which is the whole point of the dance. */
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* the descriptor may already be unusable; the unlink below is what matters */
        }
      }
      unlinkQuietly(tempPath)
      throw storeError('store/write-failed', 'devices.json could not be written')
    }
    try {
      renameSync(tempPath, devicesPath)
    } catch {
      /* Leave no temp litter behind when the rename is refused (a locked file on
         Windows, a read-only directory). */
      unlinkQuietly(tempPath)
      throw storeError('store/write-failed', 'devices.json could not be replaced atomically')
    }
    applyFileMode(devicesPath)
    return normalized
  }

  /** Current settings, with defaults applied. */
  function getSettings() {
    return read().settings
  }

  /**
   * Merge a partial settings patch and persist.
   *
   * `enabled` / `port` / `access` are the writable fields; anything else in the
   * patch is ignored, which is what keeps a caller from inventing settings the
   * rest of the package does not read.
   *
   * `access` is replaced WHOLESALE rather than merged. A partial merge would make
   * "delete the third public address" inexpressible without an index-shaped
   * protocol, and the panel always holds the full value anyway (it re-reads
   * `GET /state` after every write). The replacement is normalized first, so a
   * caller that skips `addresses.js` still cannot store an unusable address.
   *
   * @param {{ enabled?: boolean, port?: number, access?: object }} [patch]
   */
  function updateSettings(patch = {}) {
    const document = read()
    const next = {
      enabled: document.settings.enabled,
      port: document.settings.port,
      access: document.settings.access,
    }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (Number.isInteger(patch.port) && patch.port > 0 && patch.port <= 65535) next.port = patch.port
    if (patch.access !== undefined) next.access = normalizeAccess(patch.access)
    document.settings = next
    return write(document).settings
  }

  /** Every device record, in stored order. Includes revoked ones. */
  function listDevices() {
    return read().devices
  }

  /**
   * Find a device by its id, revoked or not. Linear scan: the table is small by design.
   *
   * This is the lookup the gateway performs after verifying a JWT, using the token's
   * `sub` (`research/jwt-device-credential.md` §3.5). Two things follow from that,
   * and both are deliberate:
   *
   *   - **It returns revoked rows.** The verdict is the caller's: a revoked device
   *     must be told apart from an unknown one (`auth.js` answers 401 with a cookie
   *     deletion for the first and a plain 401 for the second), and a lookup that
   *     filtered them out would collapse the two.
   *   - **It does not compare a credential.** The signature comparison already ran
   *     in `tokens.js`, in constant time over digested buffers. An id is not a
   *     secret — it is a `dev_…` row key that a paired device sees in its own audit
   *     trail — so a plain `===` here compares nothing an attacker could use to
   *     narrow a search.
   *
   * A non-string or empty id returns null rather than scanning: it cannot match a
   * record, and every real id comes from a verified claim.
   *
   * @param {unknown} id
   * @returns {ReturnType<typeof normalizeDevice> | null}
   */
  function findDeviceById(id) {
    if (typeof id !== 'string' || id === '') return null
    const match = read().devices.find((device) => device.id === id)
    return match === undefined ? null : match
  }

  /**
   * Append a device record and persist it.
   *
   * `id`, `name` and `ua` all come from the caller: the store mints no randomness.
   * `tokenHash` is accepted only so an old test or an old caller keeps working; the
   * pairing route no longer passes one, because the credential it hands out is a
   * JWT and there is nothing to hash (`research/jwt-device-credential.md` §3.6).
   *
   * A malformed record raises `store/invalid-device`, NOT `store/corrupt`: the
   * file on disk is fine, the caller is not, and the error code is what tells the
   * two apart in a log.
   *
   * @param {{ id: string, name?: string, tokenHash?: string, ua?: string }} device
   */
  function addDevice(device) {
    if (device === null || typeof device !== 'object') {
      throw storeError('store/invalid-device', 'device record is required')
    }
    const document = read()
    const record = normalizeDevice({
      id: device.id,
      name: device.name ?? '',
      tokenHash: device.tokenHash,
      ua: device.ua ?? '',
      createdAt: stamp(),
      lastSeenAt: stamp(),
      revokedAt: null,
      capabilities: null,
    }, 'store/invalid-device')
    if (document.devices.some((existing) => existing.id === record.id)) {
      throw storeError('store/duplicate-device', 'a device with this id already exists')
    }
    document.devices.push(record)
    write(document)
    return record
  }

  /** Mark a device revoked. Idempotent; returns the updated record, or null when unknown. */
  function revokeDevice(id) {
    const document = read()
    const match = document.devices.find((device) => device.id === id)
    if (match === undefined) return null
    if (match.revokedAt === null) match.revokedAt = stamp()
    write(document)
    return match
  }

  /** Record activity for a device. Returns the updated record, or null when unknown. */
  function touchDevice(id) {
    const document = read()
    const match = document.devices.find((device) => device.id === id)
    if (match === undefined) return null
    match.lastSeenAt = stamp()
    write(document)
    return match
  }

  /** Rename a device (the panel allows renaming). Returns the updated record, or null when unknown. */
  function renameDevice(id, name) {
    if (typeof name !== 'string' || name.trim() === '') return null
    const document = read()
    const match = document.devices.find((device) => device.id === id)
    if (match === undefined) return null
    match.name = name.trim()
    write(document)
    return match
  }

  return {
    baseDir,
    devicesPath,
    read,
    write,
    getSettings,
    updateSettings,
    listDevices,
    findDeviceById,
    addDevice,
    revokeDevice,
    touchDevice,
    renameDevice,
  }
}
