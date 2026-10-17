# @misaka10091/dsh-remote-control

Pairing-gated remote access for `dsh web`: open the **same** session from a phone
or another computer on your LAN, with a device panel and a local audit trail.

> **Status: stages 0–2 of 6.** The package skeleton, the device store, pairing codes,
> device tokens and the **HTTP gateway** (listener, auth, Origin fence, inner
> credential, reverse proxy) are implemented and tested. The WebSocket upgrade proxy,
> the management API, the audit writer and the panel are not written yet — see
> [Roadmap](#roadmap).
>
> A started gateway forwards **HTTP only** in this build. The live stream rides
> `/api/remote.mux`, a WebSocket upgrade that stage 3 adds, so a browser that
> connects today can load and read but its streaming channel will not establish.

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

## Request pipeline

Every request to the gateway port passes these in order, in exactly one place
(`src/host/gateway/auth.js`):

```
1. loopback socket AND loopback Host?  -> allow (no cookie needed)
2. valid device cookie?                -> continue;  else 401
3. Origin fence:
     Sec-Fetch-Site: cross-site        -> 403 (always)
     write with Origin, mismatch Host  -> 403
     write, no Origin, same-origin/same-site declared -> allow
     write, no Origin, no Sec-Fetch-Site -> 403
4. device not revoked?                 -> allow;  else 401 + clear the cookie
```

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
    ├── constants.js      # on-disk layout, data-model version, TTLs, file mode
    ├── store.js          # devices.json read/write, atomic write, 0600
    ├── pairing.js        # 8-char base32 codes, 120s TTL, one-time redemption, lockout
    ├── tokens.js         # 32-byte token, sha256 at rest, constant-time compare
    └── gateway/
        ├── server.js     # own http.Server, ctx.effect cleanup, status mapping
        ├── auth.js       # the single authorization decision (loopback/cookie/origin/revoke)
        ├── origin.js     # Origin / Sec-Fetch-Site fence, four arms
        ├── inner-auth.js # redeem + cache the upstream dsh-auth-* cookie
        ├── proxy.js      # HTTP reverse proxy: A/B/C rewrites, SSE passthrough
        ├── activity.js   # throttled lastSeenAt persistence
        └── wire.js       # response writers, cookie serialization
locale/                   # zh / en dictionaries
tests/                    # node --test
```

Domain modules (`store`, `pairing`, `tokens`) never import `gateway/*`: they must
stay usable from the loopback-only management API and testable without HTTP.

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
| Audit trail (stage 4) | `~/.dsh/remote-control/audit-YYYY-MM-DD.jsonl` | UTC days, 30-day retention |

```jsonc
{
  "version": 1,
  "devices": [
    {
      "id": "dev_xxx",
      "name": "iPhone · Safari",
      "tokenHash": "<sha256>",   // the clear token is never stored
      "ua": "...",
      "createdAt": "2026-10-17T...",
      "lastSeenAt": "2026-10-17T...",
      "revokedAt": null,
      "capabilities": null       // reserved for a future capability allowlist
    }
  ],
  "settings": { "enabled": false, "port": 3090 }
}
```

A device token is shown to the device exactly once, in the pairing response. Only
its sha256 is persisted. Comparison hashes the presented token, then runs
`crypto.timingSafeEqual` over both digests — so a wrong-length token fails cleanly
instead of throwing, and no comparison leaks a length.

The stored side is validated before it is compared or persisted: a `tokenHash`
that is not a 64-character lower-case hex digest is a **hard error**
(`store/corrupt` on load, `store/invalid-device` from `addDevice`). This is not
pedantry — if a malformed value were folded through the hash like a token, then
presenting that same literal string would authenticate against it, so a hand-edited
`devices.json` would turn its own contents into a credential.

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

## Roadmap

- [x] **0** Package skeleton, manifest, bundle patch, one-line load
- [x] **1** Device store, pairing codes, device tokens
- [x] **2** Gateway HTTP: listener, auth, Origin check, inner credential, proxy
  (+ pairing-code lockout, + `lastSeenAt` throttling)
- [ ] **3** Gateway WebSocket: upgrade auth, `/api/remote.mux` passthrough
- [ ] **4** Management API (`/remote-control/api/*`, loopback only) and audit
- [ ] **5** Client panel: enable switch, port, QR pairing, device list, revoke
- [ ] **6** Real-device verification and documentation

## License

MIT
