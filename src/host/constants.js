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

/**
 * The only accepted shape of a persisted `tokenHash`: lower-case hex sha256,
 * exactly 64 characters (`design.md` §5 — "不存明文令牌").
 *
 * LEGACY FIELD. The device credential is a signed JWT now
 * (`research/jwt-device-credential.md`), so no new row carries a `tokenHash` and
 * nothing authenticates against one. `store.js` still validates the field when an
 * OLD `devices.json` has one, so the load path cannot quietly admit a value that
 * is not a digest — `version: 1` keeps parsing byte-for-byte as before, and a
 * hand-edited file is still refused rather than half-understood.
 *
 * Deliberately flag-free: `/g` would carry `lastIndex` across `.test()` calls
 * and make consecutive checks alternate for no reason.
 */
export const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/

/** Default port of the self-hosted gateway when `settings.port` is absent. */
export const DEFAULT_GATEWAY_PORT = 3090

/* ------------------------------------------------------------------ *
 * Access addresses (`settings.access`, `prd.md` R2/R3/R5)
 *
 * The pairing link's hostname comes from an address the user picks, not from the
 * page's own origin — a desktop browser on `127.0.0.1` would otherwise hand a
 * phone a link it can never open. These are DISPLAY-LAYER facts: a wrong address
 * makes a link unusable and changes nothing else. It is never an authorization
 * input (never compared against a device, never gates the listener), so the
 * bounds below exist to keep storage and the panel sane, not to defend a trust
 * boundary.
 * ------------------------------------------------------------------ */

/**
 * Most entries the user's public-address book may hold.
 *
 * The list is hand-maintained (a home DDNS name, an office domain, a tunnel
 * hostname…) and every row has to be individually selectable in the panel, so the
 * cap is about the UI staying usable rather than about abuse. Truncation is the
 * store's fallback; the API refuses an oversized list outright.
 */
export const PUBLIC_ADDRESS_MAX = 8

/** Longest free-text label on one public-address row. A note, not a description. */
export const PUBLIC_LABEL_MAX = 40

/**
 * Longest accepted access-address string.
 *
 * 253 is the DNS name length limit (RFC 1035 §2.3.4, in presentation form), which
 * is the natural ceiling for `host[:port]` / `scheme://host[:port]`. Rejecting
 * longer input keeps a pasted log line from becoming a stored address.
 */
export const ADDRESS_TEXT_MAX = 253

/**
 * Accepted values of `settings.access.mode`.
 *
 * `lan` is the default and the safer one. `tunnel` (2026-10-20) names the address
 * a managed Cloudflare Tunnel is currently reachable at: unlike `public` it is not
 * a stored string but a runtime fact, so `effectiveAddress` takes it as an extra
 * argument instead of reading it out of `settings.access`.
 */
export const ACCESS_MODES = Object.freeze(['lan', 'public', 'tunnel'])

/* ------------------------------------------------------------------ *
 * Cloudflare Tunnel (`settings.tunnel`, `prd.md` R1-R5)
 *
 * The plugin supervises exactly one external program — `cloudflared` — and only
 * in `src/host/tunnel.js`. Everything here is either a bound on that program's
 * lifecycle or a name that the panel, the store and the API must agree on.
 * ------------------------------------------------------------------ */

/** Accepted values of `settings.tunnel.mode`. */
export const TUNNEL_MODES = Object.freeze(['quick', 'token'])

/** Leaf name of the tunnel credential file inside the runtime directory. */
export const TUNNEL_TOKEN_FILE_NAME = 'cloudflared-token'

/**
 * Longest accepted tunnel token.
 *
 * A dashboard token is a base64 blob of a few hundred bytes. The bound exists so
 * a pasted page of text cannot become a file this process writes on every save,
 * not because any real token is near it.
 */
export const TUNNEL_TOKEN_MAX = 8_192

/** Longest accepted custom `cloudflared` path. Windows paths plus argument-free names fit easily. */
export const TUNNEL_BINARY_PATH_MAX = 512

/** Leaf name of the binary this plugin downloads into the runtime directory. `.exe` is appended on Windows. */
export const TUNNEL_BINARY_FILE_NAME = 'cloudflared'

/** How long a quick tunnel may take to print its public URL before the start is failed. */
export const TUNNEL_START_TIMEOUT_MS = 30_000

/**
 * Grace period for a token-mode tunnel after spawn.
 *
 * A dashboard token can be malformed, and `cloudflared` then exits within a second
 * or two; reporting `running` before that window closes would make the panel say
 * "up" for a process that was never usable. Same idea as the URL wait for quick
 * tunnels, just with a much smaller bound.
 */
export const TUNNEL_READY_GRACE_MS = 1_500

/** Bound on the graceful stop before the process is killed outright. */
export const TUNNEL_STOP_TIMEOUT_MS = 5_000

/** Deadline for one release-metadata request and one asset download. */
export const TUNNEL_DOWNLOAD_TIMEOUT_MS = 120_000

/**
 * Refuse an asset larger than this.
 *
 * `cloudflared` is roughly 40-60 MB per platform. The cap keeps a mis-selected
 * asset (or a hostile proxy that is not on the pinned hosts anyway) from turning
 * a "download" click into an unbounded allocation.
 */
export const TUNNEL_DOWNLOAD_MAX_BYTES = 160 * 1024 * 1024

/**
 * Output lines kept in memory for diagnostics.
 *
 * They are NEVER returned by the API and never audited: `cloudflared`'s output is
 * free text, and the only thing this plugin may show a caller is a stable error
 * code. The buffer exists so a later `--verbose` style debugging aid has somewhere
 * to read without changing the process wiring.
 */
export const TUNNEL_LOG_LINES_MAX = 40

/**
 * The GitHub release endpoint the binary download is pinned to.
 *
 * A constant, not a setting (`prd.md` constraint 7): the download is the one
 * action that writes an executable to disk, and it must not be redirectable to a
 * host the panel could be tricked into naming.
 */
export const TUNNEL_RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest'

/** Host of a downloadable asset. Checked before a byte is written. */
export const TUNNEL_ASSET_HOST = 'github.com'

/** Hostname suffix a quick tunnel is created under. Used only to recognise the URL in output. */
export const TUNNEL_QUICK_HOST_SUFFIX = '.trycloudflare.com'

/**
 * Header Cloudflare's edge stamps on every proxied request with the real peer
 * address. Trusted only when the socket half is loopback (`loopback.js#clientAddress`).
 */
export const CF_CONNECTING_IP_HEADER = 'cf-connecting-ip'

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
 *
 * The value is a signed JWT (`research/jwt-device-credential.md` §3.2), so the
 * name says so. The old `dsh-rc-device` name is NOT accepted any more: a second
 * accepted cookie name would be a second code path through the one authorization
 * decision, and the whole point of `gateway/auth.js` is that there is exactly one.
 * Existing paired devices must re-pair — documented in the README.
 */
export const DEVICE_COOKIE_NAME = 'dsh-rc-jwt'

/**
 * The cookie name used before the JWT switch.
 *
 * Exported for exactly one purpose: the gateway's authorization contract has to
 * be testable against the credential it REJECTS. A device still holding an old
 * `dsh-rc-device` cookie is simply unauthenticated, which is the honest answer —
 * the value cannot be verified and must not be silently translated into a new
 * one (`research/jwt-device-credential.md` §3.6, no automatic migration).
 *
 * The gateway does NOT read this name. It exists so `tests/gateway-auth.test.mjs`
 * can prove the old credential is refused, and so a bare string literal is not
 * how two spellings of the retired name start to drift.
 */
export const LEGACY_DEVICE_COOKIE_NAME = 'dsh-rc-device'

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

/**
 * Deadline for one inner-credential exchange.
 *
 * The exchange is a `fetch` to loopback that answers in single-digit milliseconds
 * when healthy. Without a deadline a socket that accepts and then goes quiet
 * blocks the exchange forever, and since concurrent callers are coalesced onto one
 * in-flight exchange, that single stall stops every remote request — measured.
 * Five seconds is far above a healthy exchange and far below a user's patience.
 */
export const INNER_AUTH_EXCHANGE_TIMEOUT_MS = 5_000

/**
 * Deadline for the upstream to answer a WebSocket upgrade with a response head.
 *
 * Same rule as the HTTP head timeout, and the same reason: an upstream that
 * accepts the TCP connection and then says nothing must not hold a gateway socket
 * open forever (`quality-guidelines.md` §10). Shorter than the HTTP one because a
 * healthy loopback handshake is a single round trip; a minute of silence is a
 * fault, not a slow stream. It bounds ONLY the wait for the head — once `101`
 * arrives the connection is long-lived by design and must not be timed out.
 */
export const UPGRADE_HEAD_TIMEOUT_MS = 10_000

/**
 * Longest `Sec-WebSocket-Protocol` list the gateway forwards.
 *
 * The value is attacker-reachable and is copied into a header this hop
 * synthesizes, so it is bounded rather than trusted: a subprotocol list longer
 * than this is dropped (the client gets no protocol, never a corrupted handshake).
 * Real clients send at most one or two short tokens.
 */
export const UPGRADE_MAX_SUBPROTOCOL_LENGTH = 512

/* ------------------------------------------------------------------ *
 * Audit trail (`design.md` §6, `prd.md` R5)
 * ------------------------------------------------------------------ */

/**
 * File-name prefix of one day's audit file.
 *
 * The full name is `audit-<YYYY-MM-DD>.jsonl`; `audit.js`'s retention sweep
 * matches that pattern EXACTLY and deletes nothing else, so this prefix is also
 * the fence between "our data" and "whatever else is in the directory".
 */
export const AUDIT_FILE_PREFIX = 'audit-'

/** POSIX mode for a day file — the audit names devices and their addresses. A no-op on Windows. */
export const AUDIT_FILE_MODE = 0o600

/** Days of audit history kept (`prd.md` R5 / `design.md` §6: 30). */
export const AUDIT_RETENTION_DAYS = 30

/**
 * How often the daily retention sweep runs while the process stays up.
 *
 * The sweep also runs once at startup, which handles the normal case (a desktop
 * host is restarted far more often than it runs for a day). This interval covers
 * the long-lived process. Six hours rather than 24 so a machine that stays up for
 * days still prunes within half a day of a file expiring, and so the timer is
 * cheap either way: the sweep lists one directory and stats a handful of files.
 */
export const AUDIT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Events one audit-detail page carries by default (`prd.md` R5, `design.md` §2.1).
 *
 * The panel omits `limit` on its first request on purpose, so THIS number — not a
 * copy in `src/client.js` — decides how many records the first screen shows. A
 * second literal is how a "50" in the UI and a "20" on the server end up
 * disagreeing with no test noticing.
 */
export const AUDIT_EVENTS_PAGE_SIZE = 50

/**
 * Hard cap on one audit-detail page.
 *
 * The bound is a denial-of-service bound, not a UX one: every record costs a
 * `JSON.parse` and an object projection, and this API is loopback-only but
 * reachable by any local script. Beyond 200 the panel would also have to scroll a
 * list nobody can read.
 */
export const AUDIT_EVENTS_MAX_PAGE = 200

/**
 * Separator between the two halves of an audit paging cursor.
 *
 * A cursor is `"<ts>.<seq>"` — epoch milliseconds plus the record's line number
 * inside its day file (`prd.md` constraint 5). A bare timestamp is NOT enough: two
 * events can share one millisecond, and a timestamp-only cursor then either
 * repeats or swallows the second one depending on which side of the page
 * boundary it lands.
 */
export const AUDIT_CURSOR_SEPARATOR = '.'

/**
 * Route prefix the admin API claims on the OFFICIAL `dsh web` server.
 *
 * Deliberately not under `/api`: `/api` is the connection plugin's prefix
 * (`dsh-client-connection` mounts it with its own Host/Origin fence and browser
 * cookie, `research/official-connection-fence.md` §2), and a route under it
 * would either be shadowed by that registration or inherit a credential check
 * this API must not require. A dedicated prefix is served on the same official
 * port, on the desktop browser's normal origin, and is matched by
 * `webserver.register({ kind: 'prefix', … })` before any fallback.
 */
export const ADMIN_API_PREFIX = '/remote-control/api'

/**
 * Request header the panel's own client stamps on every admin API call.
 *
 * ## Why the fence needs a marker at all
 *
 * The dsh DESKTOP app (`dsh-app://app`) does not let the renderer talk to the
 * loopback Host directly: it registers a privileged custom scheme and forwards
 * every non-static request to the Host itself, with `host`, `origin`,
 * `cookie` and `sec-fetch-site` DELETED (measured in the shipped Electron main
 * bundle; the shell re-adds its own Host cookie). So an admin write issued from
 * the desktop panel arrives with no `Origin` and no `Sec-Fetch-Site` — the exact
 * shape `origin.js` arm 4 refuses — and `POST /remote-control/api/settings`
 * answered `403 admin/cross-origin` there while the same click worked in a
 * browser. Reads were unaffected (the read arm asks for nothing), which is why
 * the panel looked alive but could not save.
 *
 * The shell is not ours to change, so the proof has to travel in the one place
 * the shell passes through untouched: an ordinary request header, stamped by the
 * panel client in `src/client.js` (the literal is duplicated there, because the
 * browser half has no `import`; `tests/client.test.mjs` asserts the two agree).
 *
 * ## Why a header is proof enough
 *
 * A cross-site page cannot set it: a custom request header makes the request
 * non-simple, so the browser sends a CORS preflight first, and this API answers
 * no preflight with an `access-control-allow-*` header (see `sendJson` in
 * `api.js`) — the preflight fails and the real request is never sent. It is the
 * same double-submit style defence every framework uses for CSRF, and it is
 * STRICTLY narrower than deleting arm 4: `checkAdminOrigin` accepts the marker
 * only when `Origin` is absent entirely, so a browser-shaped request (which
 * always carries `Origin`) is still judged by arms 1-4 unchanged.
 */
export const PANEL_MARKER_HEADER = 'x-dsh-remote-control-panel'

/** Value {@link PANEL_MARKER_HEADER} must carry. Mirrored in `src/client.js`. */
export const PANEL_MARKER_VALUE = 'panel'

/**
 * The pairing bootstrap path, served on the GATEWAY port (`gateway/pairing-route.js`).
 *
 * Shared with `api.js` — which puts it in the QR payload's `pairPath` — because the
 * link the panel builds and the route that serves it must be the same string. A
 * duplicated literal is how a QR code ends up pointing at a 404, which is exactly
 * the defect this constant closes: `api.js` advertised `/remote-control/pair` for
 * two stages while nothing served it.
 *
 * On the gateway and NOT under {@link ADMIN_API_PREFIX}, because a device being
 * paired has no credential yet: it cannot reach a loopback-only API, and the
 * gateway is the only listener a phone can talk to.
 */
export const PAIRING_ROUTE_PATH = '/remote-control/pair'

/* ------------------------------------------------------------------ *
 * Device credential: a signed JWT (`research/jwt-device-credential.md`)
 * ------------------------------------------------------------------ */

/**
 * `iss` claim. Fixed and checked on every verification: a JWT signed with this
 * key but minted for another audience must not be accepted here.
 */
export const JWT_ISSUER = 'dsh-remote-control'

/** `aud` claim. The one audience this credential is valid for. */
export const JWT_AUDIENCE = 'dsh-gateway'

/**
 * The ONLY accepted `alg`. A verifier that reads the algorithm out of the token
 * is the classic JWT algorithm-confusion hole — `alg: none` is the trivial case,
 * and HS256-verified-with-an-RSA-public-key is the one that actually ships. The
 * header's `alg` is compared against this constant and nothing else.
 */
export const JWT_ALGORITHM = 'HS256'

/**
 * Clock-skew allowance when comparing `exp` / `nbf`, in seconds.
 *
 * A phone whose clock is a minute fast would otherwise be refused a token it
 * just received — and the symptom ("paired, then 401") points at the credential
 * rather than at the clock. The allowance is one-sided in effect: it can only
 * make a token live slightly longer than `exp` says, never let a long-expired
 * one through, because 60 s is far below the 30-day lifetime.
 */
export const JWT_CLOCK_SKEW_SECONDS = 60

/** Leaf name of the HS256 signing key inside the runtime directory. */
export const JWT_KEY_FILE_NAME = 'jwt-key'

/**
 * Bytes of entropy behind the signing key. 32 bytes = 256 bits, which is exactly
 * what HS256 needs: the HMAC block size is 64 bytes, so any key shorter than
 * that is padded to it anyway, and a shorter secret would give less than the
 * algorithm's full strength.
 */
export const JWT_KEY_BYTES = 32

/** POSIX mode for the signing key file. A no-op on Windows, like `DEVICES_FILE_MODE`. */
export const JWT_KEY_FILE_MODE = 0o600

/**
 * Longest JWT the verifier will look at.
 *
 * A device credential is under 400 bytes. The bound exists so a hostile cookie
 * cannot make verification expensive: splitting a megabyte on `.` and hashing its
 * segments is work an unauthenticated caller would otherwise choose for us. It is
 * generous enough that adding a claim later cannot trip it by accident.
 */
export const JWT_MAX_LENGTH = 2_048

