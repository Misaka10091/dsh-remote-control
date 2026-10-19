# @misaka10091/dsh-remote-control

Pairing-gated remote access for `dsh web`: open the **same** session from a phone
or another computer on your LAN, with a device panel and a local audit trail.

> **Status: stages 0–5 of 6.** Every host-side piece is implemented and tested: the
> device store, pairing codes, signed device **JWT**s, the **HTTP gateway** (listener, auth,
> Origin fence, inner credential, reverse proxy), the **WebSocket upgrade proxy**,
> the **management API** with the audit trail, and the **pairing flow** on the
> gateway port (`GET`/`POST /remote-control/pair`) that actually redeems a code.
>
> Stage 6 (real-device verification — phone → open the pairing link → open the
> session → send a message → receive the stream → stop) is the remaining work, and
> it needs hardware this test suite cannot provide. Everything below is verified
> over a real gateway on an OS-assigned port; see [Roadmap](#roadmap).

## Why this exists

`dsh web` binds `127.0.0.1`, so the moment you leave your desk the agent becomes
unobservable and un-interruptible. Community options either route traffic through
an external relay (a third party you have to trust) or give every paired device
full access with no boundary to tighten later.

This plugin takes a different route:

- The **official `dsh web` port stays on loopback**. The plugin opens its own
  listener as the *only* remote entry point.
- An unpaired request is rejected **before** it reaches DSH at all.
- Local loopback access never goes through the gateway, so behaviour without
  remote access enabled is identical to a plain `dsh web`.
- The gateway is a plain authenticating reverse proxy. It does not understand DSH
  internals, so a DSH upgrade does not break it.

## Pairing a device

1. Open the device panel (sidebar, bottom) and choose **Add device**. The host
   mints an 8-character base32 code with a 120-second lifetime, shown grouped as
   `XXXX-XXXX` with a copy button, beside a **QR code** of the same pairing link.
2. Scan the QR with the phone camera, or open the link
   `http://<lan-ip>:<port>/remote-control/pair#<pairId>:<code>` on the device, or
   type the code into the manual entry field. The pair lives in the **fragment**,
   which a browser never sends to a server, so the code cannot land in an access
   log.
3. The gateway serves a small self-contained page that reads the fragment
   client-side and POSTs `{ pairId, code }` back to the same path.
4. On success the gateway **signs a JWT** (HS256) carrying `iss`/`sub`/`aud`/`iat`/
   `exp`/`jti`/`name`, answers `303` to `/` with `Set-Cookie: dsh-rc-jwt=…;
   Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`, and records a `pair` audit
   event. The token's `sub` is the device id, which is what the gateway looks up.
5. A wrong code is refused and recorded as `pair_failed`. An expired or
   already-used code is refused **without** a `pair_failed` line — that is normal
   behaviour, and a signal a user learns to ignore is a signal that stops working.

The code is never logged, never audited and never written to disk. Without a
fragment the page shows a manual entry field for the `<pairId>:<code>` pair.

> **The QR code is hand-written and byte-mode only.** No dependency was added: the
> encoder (byte mode, error-correction level M, versions 1–15, mask chosen by the
> N1–N4 penalty) is plain JavaScript in the browser half. It is verified by
> bit-for-bit comparison against node-qrcode — a development-time tool that is
> **not** a dependency — for 6 texts × 8 masks plus 8 automatic version/mask
> choices, and its output was read back by an independent decoder for v1–v11.
> Two consequences worth knowing:
>
> - It never segments a link into numeric / alphanumeric / byte runs, so a symbol
>   can be one or two versions larger than the theoretical minimum. Predictable
>   and verifiable beats smallest.
> - The symbol is always dark modules on a light surround, dark theme included. It
>   uses the theme-independent members of the design token set (never a literal
>   colour), because the theme-following pair inverts the symbol on a dark theme
>   and some scanners refuse a light-on-dark code. Its four-module quiet zone is
>   part of the geometry, so it scales with the symbol instead of disappearing on
>   the smallest one.
>
> A link longer than v15-M can hold (412 bytes) shows a message and keeps the text
> code and the link — nothing is ever truncated. And **no real phone has scanned
> one of these yet**: the automated verification is a reference encoder plus an
> independent decoder, not a camera.

> **Upgrading from an earlier build: every paired device must re-pair.**
>
> The device credential used to be an opaque 32-byte random string verified against
> `sha256` hashes in `devices.json`. It is now a signed JWT, and the cookie is
> `dsh-rc-jwt` instead of `dsh-rc-device`. The old cookie name is **not** accepted:
> a second accepted cookie name would be a second code path through the one
> authorization decision, and the value it holds is not something the JWT verifier
> can check anyway. There is deliberately **no automatic migration** — exchanging
> an old hash for a new JWT would be a trust chain nobody designed
> (`research/jwt-device-credential.md` §3.6). Open the panel and pair each device
> again; the device table itself keeps its rows, names and history.

## How the credential works

```
pair:   one-time code  →  POST /remote-control/pair  →  signed JWT in an HttpOnly cookie
auth:   verify JWT (HS256, iss, aud, exp)  →  look up `sub` in the device table  →  check the revoked set
```

An **OAuth-shaped** flow: a short-lived single-use code is exchanged for a bearer
credential that carries the claims the gateway needs. Two pieces make it work, and
neither is optional:

| Piece | What it answers | Where |
|---|---|---|
| Signed JWT | "which device is this, without scanning a hash table?" | `src/host/tokens.js` |
| Server-side revoked set | "has it been revoked *since* it was signed?" | `src/host/gateway/server.js` |

A **purely stateless** JWT cannot satisfy constraint 5 (吊销必须即时生效): once
signed, a token is valid until `exp`, and nothing but a server-side list can end it
early. So the JWT carries `sub` and the gateway keeps a `Set` of revoked ids,
seeded from `devices.json` at start and updated by `gateway.revokeDevice`. The
per-request cost is one `Set` lookup — **not** a disk read.

Three details are load-bearing:

- **HS256 only, and the header is compared rather than trusted.** Reading `alg` out
  of the token and obliging is the classic algorithm-confusion hole. `alg: none`,
  `HS512`, `RS256` and a lower-case spelling are all refused, before any HMAC is
  computed. Tests in `tests/tokens.test.mjs` pin each of them.
- **The name is read from the store, never from the token.** A JWT is a snapshot:
  a device renamed in the panel would otherwise keep announcing its old label until
  it re-paired.
- **Nothing sensitive is in the payload.** A JWT is signed, not encrypted, so
  `devices.json` is the only place the device's state lives. No inner credential,
  no token hash, no pairing code, no address.

## Install

```bash
dsh plugin --profile <name> add @misaka10091/dsh-remote-control
```

The `dsh.bundle.patch` declaration inserts one loader row
(`id: remote-control`); no profile file needs editing. The web half is served
through `exports["./client"]` and mounted by the browser boot graph.

To install a local checkout instead of the registry package:

```bash
dsh plugin --profile <name> add link:/absolute/path/to/dsh-remote-control
```

> The `desktop` profile is managed by the Electron app and rejects CLI plugin
> commands. Use a CLI profile (`web`) for install verification.

## Security boundary — read this

This is the MVP, and these limits are deliberate. They are documented rather than
hidden because they decide whether the plugin is appropriate for you.

1. **No transport encryption.** The gateway speaks plain HTTP on the LAN, so a
   passive listener on the same network segment can read session traffic. For TLS,
   put your own reverse proxy in front of it, or use Tailscale (or a similar
   private overlay) — the plugin does not build either in.
2. **A device token is full control.** All paired devices are equivalent: there is
   no per-device capability allowlist yet (PRD D6). The data model and the
   judgement point reserve room for one; MVP does not implement it.
3. **`SameSite=Lax` + Origin checks stop cross-site writes**, including requests
   from a malicious page on another origin. They do **not** stop same-site XSS or
   a malicious program already running on the host.
4. **Revocation is forward-looking.** Revoking a device rejects its new requests
   and closes its live connections; it does not undo actions already performed.
5. **Disabled means gone.** Turning the plugin off (or killing the process) closes
   the listener; no port is left behind.
6. **The inner credential never leaves the server.** The gateway must present a
   `dsh-auth-*` cookie to the upstream port (the official port authenticates even
   loopback requests). That cookie is equivalent to full access to the whole DSH
   instance, so it exists only on the gateway → upstream hop and is never sent to
   a client, logged, or placed in an audit record.
7. **Local traffic is not authenticated at the gateway.** A request that both
   arrives over a loopback socket *and* names a loopback `Host` is exempt from
   pairing, which is what keeps the desktop browser and CLI tools working. Both
   halves are required: a loopback socket alone is what DNS rebinding produces.
8. **Guessing is rate-limited, not impossible.** Five wrong codes destroy a pairing
   code; 20 wrong codes per minute block a source address, independently, so
   rotating the pairing id does not reset the budget. Neither limit makes a
   leaked-then-guessed code impossible — it makes a futile search loud and slow.
9. **The pairing route is reachable without a cookie, by construction.** A device
   being paired has no credential yet, so `GET`/`POST /remote-control/pair` are the
   only paths not gated by the request pipeline below. They are still origin-fenced,
   still refused while the switch is off, and still bounded by the same brute-force
   budget — and they never reach the proxy, never mint a device without a valid
   code, and never touch DSH. The exemption waives the credential and nothing else.
10. **The device cookie carries no `Secure` attribute.** The LAN transport is plain
   HTTP; a `Secure` cookie would simply never be sent back, so pairing would appear
   to succeed and then fail on the next request. It is `HttpOnly; SameSite=Lax`,
   which is the strongest combination that works over plain HTTP.
11. **A leaked JWT is that device's full authority until it expires or is revoked.**
   The token is a bearer credential: anyone who copies the cookie gets the same
   access, from anywhere on the LAN, with no second factor. It lives 30 days, so
   the panel's **revoke** button is the way to end it early — and revocation is
   immediate (see the pipeline below), because the gateway holds a server-side
   revoked set rather than trusting the token alone.
12. **The signing key is on disk, and that is the trust anchor.** `jwt-key` in
   `~/.dsh/remote-control` holds 32 raw bytes at mode `0600`. Anyone who can read
   that file can mint a device credential for any `sub` — a forged token needs no
   pairing code. This is the same trust level as "the local account is
   compromised": the device table and the audit trail sit in that directory too,
   and a local attacker who can read one can rewrite the others. The key is
   persisted deliberately — an in-memory key would work perfectly until the next
   restart and then silently invalidate every paired device.
13. **A corrupt or unreadable key file refuses to start remote access.** It is not
   regenerated. Regenerating would invalidate every device *and* hand the decision
   to whoever damaged the file. Delete it by hand if you intend to un-pair
   everything.

## Request pipeline

Every request to the gateway port passes these in order, in exactly one place
(`src/host/gateway/auth.js`):

```
0. /remote-control/pair?                    -> pairing-route.js (no credential yet)
1. loopback socket AND loopback Host?       -> allow (no cookie needed)
2. dsh-rc-jwt verifies?  (HS256/iss/aud/exp) -> continue;  else 401
3. Origin fence:
     Sec-Fetch-Site: cross-site             -> 403 (always)
     write with Origin, mismatch Host       -> 403
     write, no Origin, same-origin/same-site declared -> allow
     write, no Origin, no Sec-Fetch-Site    -> 403
4. sub revoked?                             -> 401 + clear the cookie
   sub unknown to the table?                -> 401
   otherwise                                -> allow, device name read from the store
```

Step 0 is the pairing bootstrap (`gateway/pairing-route.js`) and is the only path
that runs before step 1 — see security boundary note 9. It is matched exactly
(`/remote-control/pair` and its trailing-slash spelling, never a prefix), runs the
same origin fence for its `POST`, re-reads `settings.enabled` per request, and
answers from process memory without forwarding anything upstream.

Writes are everything except `GET` / `HEAD` / `OPTIONS`. The fourth arm is the
CSRF rule `design.md` §3.2 asks for; the third exists because not every
same-origin browser write carries `Origin`, and rejecting those would break
normal use. `Sec-Fetch-Site` is checked first because a page cannot forge it.

An admitted request is then rewritten before it reaches DSH — all three, or the
official port answers 401/403:

| # | Action | Why |
|---|---|---|
| A | `Host` → `127.0.0.1:<official port>` | the official fence accepts a loopback authority |
| B | strip `Origin` / `Sec-Fetch-*` | it compares `origin.host` to `Host`, so a rewritten `Host` with a surviving `Origin` is a guaranteed 403 |
| C | attach the inner `dsh-auth-*` cookie | the official port has no loopback exemption |

A and B are applied in one function (`upstreamHeaders`), because doing one
without the other is precisely the configuration that produces an unexplainable
403.

## What runs where

```
src/
├── index.js              # host entry: Cordis plugin (name / inject / apply)
├── client.js             # client entry: window.__ModuleLoader__.load wrapper
└── host/
    ├── constants.js      # on-disk layout, data-model version, TTLs, JWT claims, file mode
    ├── store.js          # devices.json read/write, atomic write, 0600
    ├── pairing.js        # 8-char base32 codes, 120s TTL, one-time redemption, lockout
    ├── tokens.js         # device credential: HS256 JWT sign/verify, hand-rolled
    ├── jwt-key.js        # loads/creates the 32-byte HS256 key, 0600, loud on damage
    ├── loopback.js       # the loopback predicate shared by both transports
    ├── origin.js         # Origin / Sec-Fetch-Site fence, four arms + upgrade fence
    ├── audit.js          # JSONL audit writer, retention sweep, export
    ├── classify.js       # path + method -> audit event
    ├── api.js            # /remote-control/api/*, loopback only
    └── gateway/
        ├── server.js     # own http.Server, ctx.effect cleanup, status mapping
        ├── auth.js       # the single authorization decision (loopback/JWT/origin/revoke)
        ├── origin.js     # re-export of ../origin.js, kept for the public shape
        ├── inner-auth.js # redeem + cache the upstream dsh-auth-* cookie
        ├── proxy.js      # HTTP reverse proxy: A/B/C rewrites, SSE passthrough
        ├── wsproxy.js    # WebSocket upgrade passthrough, no `ws`
        ├── pairing-route.js # GET/POST /remote-control/pair, the redeem half
        ├── activity.js   # throttled lastSeenAt persistence
        └── wire.js       # response writers, cookie serialization
locale/                   # zh / en dictionaries
tests/                    # node --test
```

Domain modules (`store`, `pairing`, `tokens`, `jwt-key`, `audit`, `loopback`, `origin`) never
import `gateway/*`: they must stay usable from the loopback-only management API and
testable without HTTP.

## Notes from measurement

Two costs were measured rather than guessed, and both shaped the design:

- `store.touchDevice()` costs **7.06 ms** per call (a full atomic write with
  `fsync`). Calling it per request would cap the gateway near 140 req/s, so
  `lastSeenAt` is updated in memory per request and persisted at most once per
  device per 30 s — with a forced flush on revoke, on panel read and on shutdown.
- The official port enforces a **Host/Origin fence plus an authority-bound
  `dsh-auth-*` cookie with no loopback exemption**, so a naive reverse proxy gets
  401/403 no matter how the listener is configured. Hence the A/B/C rewrites.

## Data

| Data | Location | Notes |
|---|---|---|
| Devices and settings | `~/.dsh/remote-control/devices.json` | mode `0600`, atomic write |
| JWT signing key | `~/.dsh/remote-control/jwt-key` | 32 raw bytes, mode `0600`, generated on first use |
| Audit trail (stage 4) | `~/.dsh/remote-control/audit-YYYY-MM-DD.jsonl` | UTC days, 30-day retention |

```jsonc
{
  "version": 1,
  "devices": [
    {
      "id": "dev_xxx",            // this IS the JWT sub; the row key
      "name": "iPhone · Safari",
      "ua": "...",
      "createdAt": "2026-10-17T...",
      "lastSeenAt": "2026-10-17T...",
      "revokedAt": null,
      "capabilities": null        // reserved for a future capability allowlist
    }
  ],
  "settings": { "enabled": false, "port": 3090 }
}
```

**No credential is persisted.** The device holds the token; the file holds the row.
That is a stronger property than "only the digest is stored", and it is the point of
moving to a JWT: the token's authority comes from its signature, so there is
nothing in the file for an attacker to verify guesses against.

`tokenHash` may still appear in a file written by an **earlier build**. It is read,
validated and preserved so `version: 1` parses exactly as before — omitting it from
the shape above is about what this build *writes*, not what it can *read*. Anything
with a `tokenHash` cannot authenticate any more, because nothing compares a hash to
a JWT.

The one comparison that must stay constant-time is the signature check, and it does:
both operands are sha256-digested first, so `crypto.timingSafeEqual` always sees
32-byte buffers. A raw comparison would throw on a length mismatch, turning a
rejected credential into a 500 — a distinguishable signal on an unauthenticated
request.

A `devices.json` that exists but does not parse is a **hard error**
(`store/corrupt`), not an empty device table — treating it as empty would look
exactly like "all devices unpaired" while remote access kept running.

## Requirements

- Node `>= 18`
- dsh `>= 0.2.0-rc.2`
- No runtime dependencies. The WebSocket passthrough uses raw sockets, so even
  `ws` is not needed.

## Development

```bash
node --check src/index.js      # syntax
npm test                       # node:test suite
npm run check:syntax           # every host module
```

Tests never touch the real `~/.dsh`: each one binds a store to its own temp
directory and pins the clock through an injected `now`, so "expired" is asserted
by advancing a number rather than sleeping.

> `node --test tests/` does not work on Node 21+ — directory arguments to `--test`
> are matched as literal glob patterns and the directory is executed as if it were
> a test file ([nodejs/node#64555](https://github.com/nodejs/node/issues/64555)).
> The `test` script passes a glob instead, which works on every version.

### Releasing

`docs/RELEASING.md` is the runbook. Read its first section before anything else:
`0.1.0` must be published by hand, because the package is not on npm yet and npm
Trusted Publisher can only be configured on a package that already exists. From the
next version on, pushing a `vX.Y.Z` tag publishes to npm over OIDC and creates a
GitHub Release with the same `.tgz`, and the doc says exactly which parts of that
path are locally verifiable and which are not.

## Roadmap

- [x] **0** Package skeleton, manifest, bundle patch, one-line load
- [x] **1** Device store, pairing codes, device tokens (now signed JWTs)
- [x] **2** Gateway HTTP: listener, auth, Origin check, inner credential, proxy
  (+ pairing-code lockout, + `lastSeenAt` throttling)
- [x] **3** Gateway WebSocket: upgrade auth, `/api/remote.mux` passthrough
- [x] **4** Management API (`/remote-control/api/*`, loopback only) and audit
- [x] **5** Client panel: enable switch, port, device list, revoke, audit export
  (text code + one-time link + QR — see "Pairing a device")
  (+ the pairing route that redeems the code — `gateway/pairing-route.js`)
- [ ] **6** Real-device verification and documentation

## License

MIT
