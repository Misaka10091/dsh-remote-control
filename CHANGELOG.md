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
- **Pairing QR code** (PRD D2), rendered in the panel beside the text code. The
  encoder is hand-written in the browser half — byte mode, error-correction level
  M, versions 1–15, mask chosen by the N1–N4 penalty — and adds **no runtime
  dependency**. It is pinned bit-for-bit against node-qrcode (byte mode forced,
  version and mask fixed) by a committed fixture (`tests/fixtures/qr-reference.json`,
  6 texts × 8 masks, plus 8 auto version/mask entries) and read back by an
  independent decoder (`jsqr`) as a one-off. The symbol is generated in the browser
  because its content is the one-time link, whose fragment holds the pairing code;
  rendering it host-side would mean sending that code to a server. A link past
  v15-M (412 bytes) shows `pair.tooLong` and keeps the text code and the link.
  The symbol is always **dark modules on a light surround**, on a dark theme too:
  it uses the theme-independent members of the design token set
  (`--dsw-static-neutral-bluish-00` for the surround,
  `--dsw-static-neutral-bluish-1000` for the modules — tokens, never a literal
  colour), because the `--dsw-alias-*` pair flips with the theme and drew a
  light-on-dark symbol that some scanners refuse. The four-module quiet zone the
  standard requires is carried by the `viewBox`, so it scales with the version
  instead of shrinking to about one module on a v1 symbol.
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
  copy, device list with last-seen, revoke, audit export — plus an access-address
  choice (LAN dropdown or a public address book).
- **Brute-force limits** on pairing codes: 5 failures destroy the pair, plus an
  independent per-source sliding window so rotating `pairId` does not reset it.
- **Access addresses** (`settings.access`, additive). The panel offers two ways to
  decide what host a pairing link uses:
  - **LAN** — a dropdown over the IPv4 addresses the host enumerates
    (`src/host/addresses.js`). Loopback, `169.254/16` and duplicates are excluded;
    physical adapters sort ahead of virtual switches (Hyper-V/WSL/Docker) and
    `192.168/16` ahead of `10/8`, `172.16/12` and CGNAT, so the default entry is
    the address a phone can actually reach. A real machine proved the need: plain
    "private first" ordering made Hyper-V's `172.29.240.1` the default.
  - **Public** — your own address book of up to 8 entries (home DDNS, an office
    domain, a tunnel hostname, `host:port`), each with an optional label, one
    selected at a time.

  Addresses are **display-layer facts**: they decide one string the panel renders
  and nothing else. A wrong address makes a link that will not open; it never
  affects the gateway bind, the device table or authentication.
- `GET /remote-control/api/state` now also returns
  `addresses: { lan: [{ address, iface, private }] }` beside the stored choice, so
  the panel resolves "the address available right now" itself and never writes the
  fallback back to disk.
- `POST /remote-control/api/settings` accepts `access`. Invalid input (a path, a
  query, userinfo, a non-`http(s)` scheme, a port outside 1–65535, too many
  entries, a duplicate id) is refused with `400 admin/invalid-access` and **nothing
  is written**.
- `pair.publicHint` / `address.publicHint`: a public address needs your own port
  forwarding or TLS reverse proxy, and reachability is **not** checked. Selecting a
  public address no longer implies the link works.
- `pair.loopbackHint` is now shown only when the link really did fall back to the
  page's own host and that host is loopback.
- `src/host/addresses.js` (pure functions: enumeration, parsing, formatting,
  resolution, validation) — listed in `files` and in `check:syntax`, and covered by
  `tests/addresses.test.mjs`.
- **Release automation** (`.github/`, `scripts/`; git-tracked, **not** in the npm
  package). `ci.yml` runs `npm run check:syntax`, `npm test` and `npm pack --dry-run`
  on every push to `main`, every pull request and on demand, with no secrets.
  `npm-publish.yml` runs on a `vX.Y.Z` tag (or manually against an existing tag) and
  goes tag validation → checks → pack **once** → `npm publish` → GitHub Release
  carrying that same `.tgz`. Credentials come from GitHub OIDC (npm Trusted
  Publisher): no `NPM_TOKEN`, no repository secret. Re-running is safe — an npm
  version whose `dist.integrity` matches the freshly packed tarball is skipped and
  the Release is finished instead, a different tarball aborts the run (npm never
  overwrites a version), a `404` from `npm view` publishes, and any other error fails
  loudly.
- **`scripts/prepare-release.mjs`** moves every pre-publish check into one
  unit-testable function (`tests/release.test.mjs`): tag grammar (`vX.Y.Z` /
  `vX.Y.Z-prerelease`, no build metadata), no leading-zero prerelease identifiers,
  package name, tag ↔ `package.json` and tag ↔ `dsh.plugin.json` version agreement,
  `repository.url` (npm provenance binds to it), and a non-empty `## <tag> — `
  section in `CHANGELOG.md`. It emits the Release body (that section plus an install
  line using `--profile web`) and `dist_tag` (`latest` stable, `next` prerelease),
  and can be dry-run locally: `node scripts/prepare-release.mjs v0.1.0 <dir>`.

### Changed

- **The panel is a centred modal**, portalled into `document.body`
  (`createPortal`). As an absolutely positioned child of the sidebar foot it was
  clipped by the sidebar's `overflow` — a defect no `z-index` can reach. The card is
  capped at `min(720px, 100vh - 32px)` and scrolls internally, so it is fully
  visible at 1024×700 and at 601×1731, and in the collapsed rail.
- **`requiresReload` narrowed.** `POST /settings` now answers `true` only when
  `enabled` or `port` actually changed. An `access` write takes effect immediately,
  and the panel says 「已保存」 instead of telling you to restart `dsh` for a
  string. This is the one behaviour change in the API contract.
- **Outside-click dismissal removed.** The panel closes on the close button and
  `Esc` only; clicking the scrim does nothing (`prd.md` D1). A modal that vanishes
  when the mouse wanders is how a pairing code gets lost mid-read.
- **Focus management**: focus moves into the panel on open and returns to the
  trigger on close, and `Tab` / `Shift+Tab` now cycle **inside** the dialog. The
  dialog is `role="dialog"` + `aria-modal="true"` with `aria-labelledby` on its
  visible title; without the trap that attribute was promising assistive technology
  an inert background that the DOM did not provide.
- **Panel readability pass**, measured rather than judged: the 11–12 px hints,
  device meta lines and section titles were `--dsw-alias-label-tertiary` at
  **3.71:1** on the white panel (below the 4.5:1 AA floor for normal text) and now
  use `--dsw-alias-label-secondary` at **5.8:1**; audit values moved to
  `--dsw-alias-label-primary` so the numbers outrank their labels. The switch's
  transition is disabled under `prefers-reduced-motion`. The panel widened from
  560 px to **640 px** (height cap 720 → 760) with the QR growing 152 → 176 px, so
  the pairing card, the user-agent line and the audit grid stop crowding.
- The pairing link is `<scheme>://<address>[:port]/remote-control/pair#<pairId>:<code>`.
  A port written into the address wins over the gateway port; a missing scheme
  means `http`, and an `https://` address is your own proxy terminating TLS in front
  of the plain-HTTP gateway. Switching addresses does not invalidate the pairing
  code, because the code is independent of the link.
- **Panel layout pass.** Pairing is one card in two columns — symbol on the left,
  the code / countdown / link on the right — instead of a single centred column that
  pushed the copy button onto a line of its own. The link field and its button share
  one row. Device rows keep the address and the connection count on a single meta
  line and ellipsise the user agent (it used to wrap the row to three lines and bury
  the device name); a revoked row is dimmed and carries its badge once, not twice.
  Audit counters are a grid of chips under one meta line rather than a run of
  numbers. Sections are separated by a hairline instead of air alone.
- `npm run version` syncs `dsh.plugin.json`'s `version` from `package.json` (and
  stages it), so `npm version X.Y.Z --no-git-tag-version` can no longer leave the two
  manifests disagreeing. `check:syntax` also covers `scripts/prepare-release.mjs`.

### Fixed

- **The web GUI could be taken down by this plugin.** `apply()` read the
  optional `locale` service without declaring it; a Cordis client context is a
  Proxy that throws (`cannot get property "locale" without inject`) for any
  undeclared service, and `serviceOf` only guarded its `ctx.get()` half. The
  throw failed the plugin fiber, and the web boot treats any entry that did not
  activate as fatal — the whole page degraded to `Failed to load plugins — web
  boot: 1 entry did not activate`. Both service reads are now guarded, and
  activation can no longer throw.
- **A missing optional service can no longer park the row as pending.** The
  plugin declares `inject: []` and asks for `locale` / `slots` per use
  (`withServices`), the same shape the sibling panels use. A composition without
  the slot service now renders no panel instead of breaking the GUI.
- **Regression coverage for both.** `tests/client.test.mjs` builds a
  Cordis-shaped context (undeclared reads throw, `inject` grants access, an
  absent service leaves the callback pending) and asserts it really throws
  before asserting the panel still mounts; a second test drives a service that
  explodes mid-mount and asserts `apply` reports instead of rethrowing.

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
- A **public** access address only changes the string in the pairing link. The
  gateway itself still speaks plain HTTP on `0.0.0.0:<port>`; TLS, port
  forwarding and DDNS are yours to run, and the plugin neither checks nor
  guarantees that the address resolves back to this machine.

### Known limits

- **QR pairing is byte-mode only.** The encoder never splits a link into
  numeric / alphanumeric / byte runs, so a symbol can be one or two versions larger
  than the theoretical minimum (the 66-byte LAN link needs v5 here, v4 with
  segmentation). Segmentation would make "compare bit-for-bit against a reference
  encoder" meaningless, which is the only thing that makes a hand-written encoder
  trustworthy.
- **The QR symbol is capped at 200px wide**, and its four-module quiet zone is
  carved out of that budget rather than added to it, so a v11 symbol ends up with
  modules of about 2.9 CSS pixels and is best scanned from closer than a v1 one.
  The cap is what keeps the modal from overflowing a 601px-wide screen.
- **No reachability check and no built-in tunnel.** The plugin does not probe an
  address and does not run frp/cloudflared/DDNS for you (`prd.md` D3). It says so in
  the panel rather than showing a verdict it cannot support.
- **Not verified on real hardware.** The suite runs in Node against real sockets on
  ephemeral ports; the panel geometry, focus hand-off and `Esc` handling were
  additionally verified in a real browser (headless Chrome against a live
  `dsh web`) at 1024×700 and 601×1731. The stage-6 chain — phone scans, opens a
  session, sends a message, receives the stream, stops — has **not** been run on a
  phone. Specifically unverified: that mobile Safari/Chrome apply the `Set-Cookie`
  from a `303` before following it, and that the pairing page's inline script
  behaves identically there.
- **The QR symbol has not been scanned by a real phone camera.** It is verified in
  two other ways, and neither of them is a camera: (1) bit-for-bit identical to
  node-qrcode for 48 fixed version+mask combinations and for 8 automatic
  version+mask choices; (2) read back correctly by an independent decoder (`jsqr`)
  for v1, v4, v5, v11 and a 250-byte link, and for all eight masks of the v5 link.
  A physical scan is still outstanding.
- **No automatic migration.** Devices paired before the JWT switch must re-pair:
  the old `dsh-rc-device` cookie is not read.
- **The release pipeline is unverified.** `0.1.0` must be published by hand first —
  the package does not exist on npm, and Trusted Publisher can only be configured on
  an existing package — and no OIDC publish or GitHub Release has ever run for this
  repository. Only the local layers are proven: the validation unit tests, a real
  local dry run of `prepare-release.mjs`, and that both workflow files parse.
- Mobile layout follows upstream; this plugin does not restyle the official UI.
