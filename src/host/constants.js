/**
 * dsh-remote-control — host-side constants.
 *
 * One place for every literal that more than one host module needs: the on-disk
 * layout, the data-model version, the pairing TTL and the store file mode. A
 * duplicated constant is how a store and a pairing module silently disagree
 * (see `.trellis/spec/backend/directory-structure.md` — "Constants defined in
 * one place").
 *
 * Nothing here reads the filesystem or the environment; `store.js` owns the
 * `os.homedir()` resolution, everything else receives a path.
 */

/** Sub-directory under the DSH home that holds the device table and the audit trail. */
export const RUNTIME_DIR_NAME = 'remote-control'

/** Leaf name of the device table document. */
export const DEVICES_FILE_NAME = 'devices.json'

/** Data-model version of `devices.json`. A HIGHER version on disk is refused, never "best-effort parsed". */
export const DEVICES_VERSION = 1

/** POSIX permission bits for `devices.json` — owner read/write only. A no-op on Windows. */
export const DEVICES_FILE_MODE = 0o600

/** Lifetime of a pairing code. Short on purpose: the code is redeemed within seconds of the scan. */
export const PAIRING_TTL_MS = 120_000

/** Characters of a pairing code. `design.md` §3.1 fixes this at 8. */
export const PAIRING_CODE_LENGTH = 8

/** RFC 4648 base32 alphabet, upper-case, no padding. Codes are read out loud and typed by hand. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Bytes of entropy behind a device token. 32 bytes = 256 bits. */
export const DEVICE_TOKEN_BYTES = 32

/**
 * The only accepted shape of a persisted `tokenHash`: lower-case hex sha256,
 * exactly 64 characters (`design.md` §5 — "不存明文令牌").
 *
 * Shared by `tokens.js` (will it authenticate?) and `store.js` (may it be
 * persisted/loaded at all?). One definition, because two regexes drifting apart
 * is how a store starts accepting a credential-shaped value the verifier would
 * treat as a token.
 *
 * Deliberately flag-free: `/g` would carry `lastIndex` across `.test()` calls
 * and make consecutive checks alternate for no reason.
 */
export const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/

/** Default port of the self-hosted gateway when `settings.port` is absent. */
export const DEFAULT_GATEWAY_PORT = 3090

/** Leading string of every device id, so an id can never be mistaken for a token hash. */
export const DEVICE_ID_PREFIX = 'dev_'
