/**
 * dsh-remote-control — the JWT signing key.
 *
 * Owns `~/.dsh/remote-control/jwt-key`: 32 random bytes, mode 0600, generated on
 * first use and persisted (`research/jwt-device-credential.md` §3.3).
 *
 * ## Why the key is a file and not memory
 *
 * An in-memory key would work perfectly until the process restarted, and then
 * every paired device would be silently invalid — the phone still holds a
 * well-formed cookie, the gateway still verifies signatures, and every one of them
 * fails. That is the worst shape of failure this project has: it looks like a bug
 * in the auth code and it happens on every upgrade. So the key is a file, and a
 * key file that cannot be read is a LOUD startup failure (the plugin refuses to
 * enable remote access) rather than a fresh key in memory.
 *
 * ## Why "corrupt" is fatal and not "regenerate"
 *
 * A key file with the wrong length, or one that cannot be read, is either damage
 * or an attack. Regenerating it would (a) silently invalidate every paired device
 * and (b) hand the decision to whoever damaged the file. Both are worse than
 * refusing to start: `error-handling.md` is explicit that a startup precondition
 * failure is fatal and visible.
 *
 * ## What this module does NOT do
 *
 * It does not sign or verify anything — that is `tokens.js` — and it holds no
 * cache. The caller (`gateway/server.js`) reads the key once at start and keeps
 * the Buffer; a per-request disk read would cost more than the whole auth check.
 *
 * ## Mode 0600, and Windows
 *
 * Same treatment as `store.js`'s `applyFileMode`: 0600 is applied at creation so
 * the file is never briefly readable, and the call is a guarded no-op on platforms
 * without POSIX mode bits. `chmod` failing must never stop the plugin from
 * starting (`quality-guidelines.md` §7).
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

import { JWT_KEY_BYTES, JWT_KEY_FILE_MODE, JWT_KEY_FILE_NAME } from './constants.js'

/**
 * Monotonic temp-file suffix, so two writers in ONE process never collide.
 *
 * A timestamp would not do: two calls in the same millisecond would share a temp
 * path, and one of them would unlink the other's file.
 */
let tempSequence = 0

/** Build an Error carrying a stable `code` (see `.trellis/spec/backend/error-handling.md`). */
function keyError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Apply 0600 to a path, tolerating platforms that have no such concept.
 *
 * A copy of `store.js`'s approach on purpose rather than an import: the two files
 * guard different secrets and `store.js` is the device table's module. The rule
 * being duplicated is one line of platform detection, and its failure mode (a
 * throw on Windows) is the thing the specs forbid twice.
 *
 * @param {string} filePath
 */
function applyKeyMode(filePath) {
  if (process.platform === 'win32') return
  try {
    chmodSync(filePath, JWT_KEY_FILE_MODE)
  } catch {
    /* POSIX perms are best-effort here: a filesystem without mode support (some
       network shares / FAT mounts) must not stop the plugin from starting. */
  }
}

/** Remove a temp file, ignoring "already gone" and lock errors. */
function unlinkQuietly(filePath) {
  try {
    unlinkSync(filePath)
  } catch {
    /* nothing to clean up, or the platform refused — the thrown error is the news */
  }
}

/**
 * Resolve the key path for a runtime directory.
 *
 * Takes `baseDir` rather than resolving `~` itself: `store.js` is the only module
 * that resolves the user's home (`directory-structure.md`), and every other module
 * receives the directory it should use. That is also what lets a test point at a
 * temp dir without touching the real `~/.dsh`.
 *
 * @param {string} baseDir
 * @returns {string}
 */
export function jwtKeyPath(baseDir) {
  return path.join(baseDir, JWT_KEY_FILE_NAME)
}

/**
 * Create the runtime directory if needed. 0700 is likewise POSIX-only.
 *
 * @param {string} baseDir
 */
function ensureDir(baseDir) {
  try {
    mkdirSync(baseDir, { recursive: true, mode: 0o700 })
  } catch {
    throw keyError('jwt-key/write-failed', 'the remote-control directory could not be created')
  }
}

/**
 * Write the key, publishing it with an atomic "create if absent".
 *
 * The temp file is written first, `fsync`ed, then **hard-linked** into place.
 * `link` is the primitive that gives "create this name only if it does not exist"
 * atomically: it fails with `EEXIST` rather than replacing, so when two processes
 * start at once exactly one key wins the name and the other adopts it. A plain
 * `rename` would let the second clobber the first, and a plain `open(…, 'w')` would
 * truncate a key another process is already using — both leave two live keys and
 * half the device table broken.
 *
 * `writeFileSync` alone would also be wrong for the earlier reason: it truncates
 * first, so a crash mid-write leaves a short key. Writing to a temp name and
 * linking means a reader sees either no key or a complete one
 * (`quality-guidelines.md` §2 and §15).
 *
 * @param {string} keyPath
 * @param {Buffer} key
 * @returns {boolean} true when this call created the file, false when it already existed.
 */
function writeKeyFile(keyPath, key) {
  tempSequence += 1
  const tempPath = `${keyPath}.${String(process.pid)}.${String(tempSequence)}.tmp`
  let fd
  try {
    fd = openSync(tempPath, 'w', JWT_KEY_FILE_MODE)
    let written = 0
    /* `writeSync` may report a SHORT write, and a short write here would publish a
       truncated key. Loop until every byte is down. */
    while (written < key.length) {
      written += writeSync(fd, key, written, key.length - written)
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* the descriptor may already be unusable; the unlink below is what matters */
      }
    }
    unlinkQuietly(tempPath)
    throw keyError('jwt-key/write-failed', 'the JWT signing key could not be written')
  }

  let created
  try {
    linkSync(tempPath, keyPath)
    created = true
  } catch (error) {
    /* `EEXIST` is the benign race: another process published first and their key is
       the one on disk. Anything else (a read-only directory, a full disk) is a real
       failure and must not be mistaken for "already there" — that would return a
       key this process never wrote and cannot check. */
    if (error === null || typeof error !== 'object' || error.code !== 'EEXIST') {
      unlinkQuietly(tempPath)
      throw keyError('jwt-key/write-failed', 'the JWT signing key could not be installed')
    }
    created = false
  }
  unlinkQuietly(tempPath)
  /* The link shares the temp file's inode, so the mode was already 0600 at
     creation. Applying it again is cheap and covers a filesystem that ignored the
     mode argument. */
  if (created) applyKeyMode(keyPath)
  return created
}

/**
 * Read and validate an existing key file.
 *
 * @param {string} keyPath
 * @returns {Buffer | undefined} `undefined` when the file does not exist.
 */
function readKeyFile(keyPath) {
  let bytes
  try {
    bytes = readFileSync(keyPath)
  } catch (error) {
    /* `ENOENT` is "no such file"; `ENOTDIR` is "a component of the path is not a
       directory". Linux reports the second where Windows reports the first for the
       same setup — a runtime directory that is really a regular file — and both mean
       "there is no key at this path". Narrowing this to `ENOENT` classified the
       failure by platform instead of by cause: on Linux the missing key became
       `jwt-key/unreadable` and the real news never got a chance to surface. */
    if (error !== null && typeof error === 'object'
      && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    /* Permissions, a directory in the way, an I/O error: all of them mean "there is
       a key here that this process cannot use", which is a refusal to start rather
       than a reason to mint a second one. */
    throw keyError('jwt-key/unreadable', 'the JWT signing key could not be read')
  }
  if (bytes.length !== JWT_KEY_BYTES) {
    /* A wrong-length key is damage or an edit. Adopting it would weaken HS256 (a
       1-byte secret), and regenerating it would silently invalidate every device. */
    throw keyError('jwt-key/corrupt', 'the JWT signing key is not 32 bytes')
  }
  return bytes
}

/**
 * Load the signing key, generating and persisting it on first use.
 *
 * Returns a 32-byte Buffer. Throws a coded Error — never returns a fallback — when
 * the file exists but is unusable, which is what makes the failure visible at
 * mount time instead of as "every device is 401" after the next restart.
 *
 * Two processes starting at once is a real case (a host reload overlapping an
 * active one). {@link writeKeyFile} publishes with a hard link, so exactly one key
 * wins the name and the loser adopts it; both processes then verify each other's
 * tokens. The alternative — a process keeping the key it minted — would leave two
 * live signing keys and half the device table rejected.
 *
 * @param {object} options
 * @param {string} options.baseDir Runtime directory (same one the store uses).
 * @param {(size: number) => Buffer} [options.random] Random-byte source; injectable for tests.
 * @returns {Buffer}
 */
export function loadOrCreateJwtKey(options) {
  const baseDir = options !== null && typeof options === 'object' && typeof options.baseDir === 'string'
    ? options.baseDir
    : ''
  if (baseDir === '') {
    throw keyError('jwt-key/invalid', 'a runtime directory is required to load the signing key')
  }
  const keyPath = jwtKeyPath(baseDir)

  const existing = readKeyFile(keyPath)
  if (existing !== undefined) return existing

  const random = typeof options.random === 'function' ? options.random : randomBytes
  const bytes = random(JWT_KEY_BYTES)
  /* Rule 5 of the pairing module applies here too: an injected source returning a
     short buffer would otherwise persist a weak key without a word. */
  if (!(bytes instanceof Uint8Array) || bytes.length < JWT_KEY_BYTES) {
    throw keyError('jwt-key/entropy', 'the random source returned too few bytes')
  }
  const key = Buffer.from(bytes)

  ensureDir(baseDir)
  const created = writeKeyFile(keyPath, key)
  if (!created) {
    /* Another process published first. Its key is the one every verifier will see,
       so adopting it is the only outcome that keeps one key live. */
    const theirs = readKeyFile(keyPath)
    if (theirs !== undefined) return theirs
    throw keyError('jwt-key/write-failed', 'the JWT signing key could not be read back')
  }

  /* Re-read rather than returning `key`: whatever is on disk is the truth, and a
     key that did not survive its own write is a failure worth refusing to start
     over. */
  const persisted = readKeyFile(keyPath)
  if (persisted === undefined) {
    throw keyError('jwt-key/write-failed', 'the JWT signing key did not survive its own write')
  }
  return persisted
}
