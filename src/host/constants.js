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

/**
 * The device-facing cookie name (`design.md` §3.1 step 5, §3.2).
 *
 * Deliberately NOT under the official `dsh-auth-` prefix: that prefix names the
 * inner browser-session credential, which binds to the upstream authority
 * (`research/official-connection-fence.md` §2.2). A device cookie sharing that
 * prefix would be indistinguishable from inner credential material at exactly
 * the hop where the two must never be confused.
 */
export const DEVICE_COOKIE_NAME = 'dsh-rc-device'

/** Lifetime of the device cookie: 30 days, matching the official browser session. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/**
 * Failed redemptions a single pairing id tolerates before it is destroyed
 * (`research/official-connection-fence.md` §7.1 — there is no limit at all
 * otherwise, and a leaked `pairId` turns an 8-character code into a guessable
 * target).
 */
export const PAIRING_MAX_ATTEMPTS = 5

/**
 * Failed redemptions a single source address tolerates per window.
 *
 * Independent of the per-pair counter on purpose: `pairId` is attacker-chosen
 * on a request, so rotating it must not reset the budget. 20 is far above human
 * mistyping (which the per-pair lock already caps at 5) and far below anything
 * that helps an attacker, whose search space is 32^8.
 */
export const PAIRING_IP_MAX_FAILURES = 20

/** Sliding window of the per-source failure budget. */
export const PAIRING_IP_WINDOW_MS = 60_000

/**
 * Bind address of the gateway listener.
 *
 * All interfaces: the whole point is that a phone on the LAN can reach it
 * (`design.md` §2 — `0.0.0.0:<remotePort>`). The official port stays on
 * `127.0.0.1`, so this listener is the only way in and every request through it
 * is authenticated.
 */
export const GATEWAY_BIND_HOST = '0.0.0.0'

/**
 * Prefix of the inner browser-session cookie minted by
 * `@deepseek-ai/dsh-client-connection` (`research/official-connection-fence.md` §2.2).
 *
 * Every cookie with this prefix that a CLIENT sends is dropped before forwarding:
 * the value is bound to the upstream authority, so a client can never hold a
 * usable one, and letting one cross the hop would put client-controlled bytes in
 * the position of instance-wide credential material.
 */
export const INNER_COOKIE_PREFIX = 'dsh-auth-'

/**
 * Minimum spacing between persisted `lastSeenAt` writes per device
 * (`research/official-connection-fence.md` §7.2 — an unthrottled write costs
 * 7.06 ms of fsync, capping throughput near 140 req/s).
 */
export const ACTIVITY_PERSIST_INTERVAL_MS = 30_000

/**
 * How long a failed inner-credential redemption is remembered before another
 * attempt is made. Prevents a per-request redemption storm while DSH is down,
 * without pinning the gateway into permanent degradation.
 */
export const INNER_AUTH_RETRY_INTERVAL_MS = 1_000
