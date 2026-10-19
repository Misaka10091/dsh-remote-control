# Changelog

All notable changes to this project are documented here.

Format: `## vX.Y.Z — YYYY-MM-DD`.

## v0.1.0 — 2026-10-17

First release. A pairing-gated remote-access channel for `dsh web`: open the same
session from a phone or another computer on your LAN, with a device panel and a
local audit trail. No relay, no third-party service.

### Added

- **Self-hosted gateway** (`src/host/gateway/`) on its own port. The official
  `dsh web` port stays on `127.0.0.1`, so an unpaired request never reaches DSH.
  Loopback access bypasses the gateway entirely, which keeps behaviour identical
  to a plain `dsh web` when remote access is off.
- **Pairing flow** (PRD R2): the panel mints an 8-character base32 code with a
  120-second lifetime; `GET`/`POST /remote-control/pair` redeem it and hand the
  device a credential. The code travels in the URL **fragment** so it never
  reaches a server log.
- **OAuth-shaped device credential**: one-time code → signed **HS256 JWT**
  (`iss`/`sub`/`aud`/`iat`/`exp`/`jti`/`name`), in a `dsh-rc-jwt` cookie
  (`HttpOnly; SameSite=Lax`). `alg` is checked before the HMAC, `exp` is
  mandatory, and the signature is compared in constant time.
- **Instant revocation**: an in-memory revoked set is consulted per request, and
  revoking a device also closes its live WebSocket connections — a stateless JWT
  alone cannot satisfy this.
- **WebSocket passthrough** for `/api/remote.mux` over raw sockets — no `ws`
  dependency, because the gateway forwards bytes and never parses frames.
- **Management API** (`/remote-control/api/*`) restricted to loopback, served on
  the official port. The gateway refuses that prefix outright so a paired device
  cannot reach it.
- **Audit trail** (PRD R5): JSONL, one file per UTC day, 30-day retention,
  loopback-only export. Records actions and timestamps — never message bodies,
  tool arguments, file contents, tokens or cookies.
- **Client panel** in the sidebar foot: enable switch, port, pairing code with
  copy, device list with last-seen, revoke, audit export.
- **Brute-force limits** on pairing codes: 5 failures destroy the pair, plus an
  independent per-source sliding window so rotating `pairId` does not reset it.

### Security notes

- LAN transport is plain HTTP. A passive listener on the same segment can read
  session traffic. Use a TLS-terminating proxy or a private overlay such as
  Tailscale if that matters to you.
- A device JWT is full control of the session until it expires or is revoked.
  Per-device capability allowlists are designed for but **not implemented**
  (PRD D6).
- The signing key lives at `~/.dsh/remote-control/jwt-key` (mode 0600 on POSIX).
  Anyone who can read that file can mint device credentials — the same trust
  level as "the host is already compromised".

### Known limits

- **No QR code.** The intended flow is a QR beside the text code, but a QR
  encoder needs Reed–Solomon error correction and this package is
  dependency-free (enforced by a test). An encoder that cannot be validated
  without a scanner was judged worse than none. The text code and one-time link
  are the primary path.
- **Not verified on real hardware.** All 479 tests run in Node against real
  sockets on ephemeral ports. The stage-6 chain — phone scans, opens a session,
  sends a message, receives the stream, stops — has **not** been run on a phone.
  Specifically unverified: that mobile Safari/Chrome apply the `Set-Cookie` from
  a `303` before following it, and that the pairing page's inline script behaves
  identically there.
- **No automatic migration.** Devices paired before the JWT switch must re-pair:
  the old `dsh-rc-device` cookie is not read.
- Mobile layout follows upstream; this plugin does not restyle the official UI.
