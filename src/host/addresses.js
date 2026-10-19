/**
 * dsh-remote-control — access addresses (pure functions, no IO).
 *
 * The pairing link used to take its hostname from the page that rendered it
 * (`document.baseURI`), which on the desktop is always `127.0.0.1` — a link no
 * phone can open. `prd.md` R2/R3 replace that with an address the user chooses:
 * one of this machine's LAN IPv4 addresses, or one of their own public addresses
 * (a DDNS name, a tunnel hostname, `public.example.com:8443`, …).
 *
 * ## What an address is, and is not
 *
 * It is a DISPLAY-LAYER fact (`prd.md` constraint 4). It decides the hostname in
 * one string the panel renders; it never reaches the gateway's binding, is never
 * compared against a device, and is never an authorization input. So a wrong
 * address costs a broken link and nothing else — which is exactly why the bounds
 * below are about keeping the stored text sane rather than about defending a
 * trust boundary. Nothing here touches the filesystem, the clock or the network
 * (the default `networkInterfaces()` read is the one injected seam).
 *
 * ## Why this module has more than the four functions `design.md` §2.1 lists
 *
 * `listLanAddresses` / `parseAddress` / `formatAddress` / `effectiveAddress` are
 * the link path. The other two exist so the ACCEPTANCE RULES live in exactly one
 * place:
 *
 *   - `defaultAccess()` — the shape an old `devices.json` is backfilled with and
 *     the shape `POST /settings` falls back to. Spelled once, not per caller.
 *   - `validateAccess()` — the same rules in strict form. `store.js` calls it and
 *     falls back to the default (a hand-edited file must never fail to load —
 *     `database-guidelines.md` forward-compatible additions); `api.js` calls it
 *     and answers `400 admin/invalid-access` (a caller must not have its input
 *     silently rewritten). If the two had their own copies of the rules, one of
 *     them would drift and the divergence would be invisible.
 */
import { networkInterfaces } from 'node:os'

import {
  ACCESS_MODES,
  ADDRESS_TEXT_MAX,
  PUBLIC_ADDRESS_MAX,
  PUBLIC_LABEL_MAX,
} from './constants.js'

/**
 * A DNS name or a dotted-quad IPv4, in presentation form.
 *
 * Each label is 1-63 characters and may not start or end with a hyphen
 * (RFC 1123 §2.1). Deliberately does not distinguish "hostname" from "IPv4":
 * `1.2.3.4` is a legal host name by this grammar and no consumer here needs the
 * difference. It does reject an empty label (`a..b`), a trailing dot and a
 * leading hyphen, which is what makes a half-typed address refuse to save.
 */
const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

/** Characters allowed inside `[...]` — an IPv6 literal, unvalidated beyond its alphabet. */
const IPV6_LITERAL_PATTERN = /^[0-9A-Fa-f:.]+$/

/** `host:port` style port text. The value is range-checked after this. */
const PORT_TEXT_PATTERN = /^[0-9]{1,5}$/

/**
 * Shape of a public-address row id.
 *
 * The panel mints these (`pub_` + a few random base-36 characters) and they are
 * only ever compared for equality, so the pattern is about keeping a hand-edited
 * file from producing an id that cannot be expressed in `POST /settings` JSON.
 */
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Octet-by-octet IPv4 test. Rejects `1.2.3` and `1.2.3.256`. */
function isIPv4(text) {
  if (typeof text !== 'string') return false
  const parts = text.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return false
    const value = Number.parseInt(part, 10)
    if (value < 0 || value > 255) return false
  }
  return true
}

/**
 * Whether an IPv4 address sits in a private range.
 *
 * RFC 1918 only (10/8, 172.16/12, 192.168/16). CGNAT `100.64/10` is NOT treated as
 * private: on a host reached through a carrier-grade NAT that address is the one
 * a phone can actually use, and demoting it would sort it behind a loopback-adjacent
 * oddity for no benefit.
 */
function isPrivateIPv4(address) {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  return false
}

/** `169.254/16` — link-local. Reachable only on the local segment, so never a pairing host. */
function isLinkLocalIPv4(address) {
  return address.startsWith('169.254.')
}

/**
 * `127/8` — the loopback range.
 *
 * `internal` is Node's signal for this and is what the enumeration filters on,
 * but the acceptance rule is stated as "non-loopback" (`prd.md` acceptance 3), so
 * the range is also checked by address: a `127.0.0.1` row is a link no other
 * device can open, and offering it in the dropdown would make the default
 * selection exactly the address the panel exists to get away from.
 */
function isLoopbackIPv4(address) {
  return address.startsWith('127.')
}

/**
 * Interface names that describe a virtual switch rather than the LAN a phone sits on.
 *
 * A Windows host routinely carries Hyper-V's `vEthernet (Default Switch)` and a WSL
 * `vEthernet` beside the real NIC, and both are private-range addresses. Ordering by
 * "private first, then address" therefore made `172.29.240.1` the DEFAULT selection
 * on a real machine (2026-10-19) — an address no phone can open. The adapter name is
 * the only signal Node exposes, so physical-looking adapters go first and anything
 * that smells virtual afterwards; guessing wrong costs one row's position, never a
 * hidden option.
 *
 * `Tailscale` / `ZeroTier` are deliberately NOT in the list: a 100.64/10 address is
 * exactly what a remote device uses on those overlays (`prd.md` recommends them).
 */
const VIRTUAL_IFACE_PATTERN = /vEthernet|Hyper-V|WSL|Default Switch|Docker|VMware|VirtualBox|Npcap|Loopback|Bluetooth/i

/** True when the interface name looks like a virtual adapter. */
function isVirtualIface(iface) {
  return typeof iface === 'string' && VIRTUAL_IFACE_PATTERN.test(iface)
}

/**
 * How likely a phone on the same network is to reach this address. Lower sorts first.
 *
 * `192.168/16` is the home-LAN default, `10/8` the common office/VPN range, then
 * `172.16/12` (also where Hyper-V and Docker live), then CGNAT `100.64/10`
 * (Tailscale), and anything public-range last — still offered, it just should not
 * win the default slot.
 */
function reachRank(address) {
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('10.')) return 1
  const first = Number.parseInt(address.split('.')[0], 10)
  if (first === 172) return 2
  if (first === 100) return 3
  return 4
}

/**
 * This machine's usable IPv4 addresses, most useful first.
 *
 * Filtered to what a phone on the same network could plausibly open:
 * IPv4 only (the link is built with a name, not a bracketed literal), not
 * `internal` (Node's loopback signal), not the `127/8` range, not link-local,
 * deduplicated (one address can appear on two interfaces — a bridge and its
 * member — and a duplicate row in the dropdown that selects the same thing is
 * noise).
 *
 * Sorted so the first entry is the one a phone can actually reach: physical
 * adapters before virtual ones, then home LAN before office/VPN before the
 * Hyper-V ranges. Ties break by address string so the order is stable across
 * calls (a dropdown whose options shuffle between polls is unusable).
 *
 * @param {ReturnType<typeof networkInterfaces>} [interfaces] Injectable seam: tests
 *   must not depend on the machine they run on.
 * @returns {{ address: string, iface: string, private: boolean }[]}
 */
export function listLanAddresses(interfaces = networkInterfaces()) {
  if (interfaces === null || typeof interfaces !== 'object') return []

  const seen = new Set()
  const entries = []
  for (const iface of Object.keys(interfaces)) {
    const list = interfaces[iface]
    if (!Array.isArray(list)) continue
    for (const info of list) {
      if (info === null || typeof info !== 'object') continue
      /* Node 18 reports `family: 'IPv4'`; very old releases used the number 4. */
      if (info.family !== 'IPv4' && info.family !== 4) continue
      if (info.internal === true) continue
      const address = typeof info.address === 'string' ? info.address : ''
      if (!isIPv4(address) || isLinkLocalIPv4(address) || isLoopbackIPv4(address)) continue
      if (seen.has(address)) continue
      seen.add(address)
      entries.push({ address, iface, private: isPrivateIPv4(address) })
    }
  }

  entries.sort((left, right) => {
    const leftKey = (isVirtualIface(left.iface) ? 10 : 0) + reachRank(left.address)
    const rightKey = (isVirtualIface(right.iface) ? 10 : 0) + reachRank(right.address)
    if (leftKey !== rightKey) return leftKey - rightKey
    if (left.address === right.address) return 0
    return left.address < right.address ? -1 : 1
  })
  return entries
}

/**
 * Parse one access address, or refuse it.
 *
 * Accepted (the whole point is that a user can type what they already know):
 *
 * ```
 * 192.168.1.5              host
 * 192.168.1.5:3090         host:port
 * http://dsh.lan           http(s)://host[:port]
 * https://dsh.example.net:8443
 * [::1]:3090               a bracketed IPv6 literal, with or without a port
 * ```
 *
 * Refused, with no attempt to repair: an empty or over-long string, embedded
 * whitespace, anything with a userinfo / path / query / fragment (this is an
 * AUTHORITY — accepting a path would let `https://x/a#b` be stored and then
 * rendered next to the pairing fragment), a non-`http(s)` scheme, an explicit
 * port that is not 1-65535, and an unbracketed multi-colon string (its port is
 * ambiguous, and guessing is how a link ends up on the wrong one).
 *
 * @param {unknown} text
 * @returns {{ scheme: 'http' | 'https' | null, host: string, port: number | null } | null}
 */
export function parseAddress(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > ADDRESS_TEXT_MAX) return null
  /* Whitespace inside an authority never means anything: `192.168.1.5 3090` must
     be refused, not silently read as the first half. */
  if (/\s/.test(trimmed)) return null

  let scheme = null
  let rest = trimmed
  /* `String.prototype.match`, not `RegExp.prototype.exec`: a `\bexec\(` in a host
     module trips the "the host half never shells out" invariant in
     `tests/package.test.mjs`, which exists to catch `child_process`. Keeping that
     assertion sharp matters more than the style of one call here. */
  const schemeMatch = rest.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//)
  if (schemeMatch !== null) {
    const name = schemeMatch[1].toLowerCase()
    if (name !== 'http' && name !== 'https') return null
    scheme = name
    rest = rest.slice(schemeMatch[0].length)
  }
  if (rest === '' || /[@/?#\\]/.test(rest)) return null

  let host
  let portText = null
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close < 0) return null
    const inner = rest.slice(1, close)
    if (!IPV6_LITERAL_PATTERN.test(inner)) return null
    host = rest.slice(0, close + 1)
    const tail = rest.slice(close + 1)
    if (tail !== '') {
      if (!tail.startsWith(':')) return null
      portText = tail.slice(1)
    }
  } else {
    const colon = rest.indexOf(':')
    if (colon < 0) {
      host = rest
    } else {
      /* A second colon without brackets: the port cannot be identified, and
         guessing would put the link on a port the user never meant. */
      if (rest.indexOf(':', colon + 1) >= 0) return null
      host = rest.slice(0, colon)
      portText = rest.slice(colon + 1)
    }
    if (!HOSTNAME_PATTERN.test(host)) return null
  }

  let port = null
  if (portText !== null) {
    if (!PORT_TEXT_PATTERN.test(portText)) return null
    const value = Number.parseInt(portText, 10)
    if (!Number.isInteger(value) || value < 1 || value > 65535) return null
    port = value
  }

  return { scheme, host, port }
}

/**
 * Normalize a parsed address back to the string that gets stored and shown.
 *
 * `scheme` is dropped when it is absent rather than defaulted to `http`: the
 * panel decides the default at link time, and storing a guess would make a later
 * change to that default invisible in the file.
 *
 * @param {{ scheme?: string | null, host?: string, port?: number | null } | null} parsed
 * @returns {string} The normalized address, or `''` for an unusable input.
 */
export function formatAddress(parsed) {
  if (parsed === null || typeof parsed !== 'object') return ''
  const host = typeof parsed.host === 'string' ? parsed.host.trim() : ''
  if (host === '') return ''
  const scheme = parsed.scheme === 'http' || parsed.scheme === 'https' ? parsed.scheme : null
  const port = Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65535
    ? parsed.port
    : null
  return (scheme === null ? '' : `${scheme}://`) + host + (port === null ? '' : `:${port}`)
}

/**
 * The address that should be used for a link RIGHT NOW, or null when there is none.
 *
 * The stored value is the user's CHOICE; this is "the one available at this
 * moment" (`design.md` §1.2). They differ because a LAN interface can be down:
 *
 * | mode     | effective address                                                |
 * |----------|------------------------------------------------------------------|
 * | `lan`    | stored `lanAddress` if the NIC list still contains it, else the   |
 * |          | first listed address; empty list → none                           |
 * | `public` | the row `selectedPublicId` names, else the first; empty → none    |
 *
 * The fallback happens HERE and only here — never on the write path. A cable that
 * was unplugged for a minute must not quietly rewrite the user's selection, and
 * the panel can still say "the address you chose is not on this machine" because
 * `GET /state` returns the stored value unchanged.
 *
 * @param {object | null} access `settings.access`, as stored (possibly malformed).
 * @param {{ address?: string }[]} [lan] Output of {@link listLanAddresses}; entries
 *   without a string `address` are skipped, never used as the fallback.
 * @returns {string | null} Address text, or null when nothing is available.
 */
export function effectiveAddress(access, lan) {
  const settings = access !== null && typeof access === 'object' ? access : {}
  /* An entry WITHOUT a string `address` is dropped instead of becoming the
     "first entry": `listLanAddresses` never emits one, but this function also
     documents the rule the browser copy implements, and the browser copy reads
     `GET /state` JSON it did not necessarily produce. Skipping the unusable row
     and taking the next one is the same policy both halves must apply — the
     parity test in `tests/client.test.mjs` runs this exact matrix through both. */
  const list = Array.isArray(lan)
    ? lan.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.address === 'string')
    : []

  if (settings.mode === 'public') {
    const book = Array.isArray(settings.public)
      ? settings.public.filter((entry) => entry !== null && typeof entry === 'object')
      : []
    if (book.length === 0) return null
    const wanted = typeof settings.selectedPublicId === 'string' ? settings.selectedPublicId : ''
    const chosen = book.find((entry) => entry.id === wanted) ?? book[0]
    const text = typeof chosen.address === 'string' ? chosen.address.trim() : ''
    return text === '' ? null : text
  }

  if (list.length === 0) return null
  const stored = typeof settings.lanAddress === 'string' ? settings.lanAddress : ''
  const match = stored === '' ? undefined : list.find((entry) => entry.address === stored)
  const chosen = match ?? list[0]
  const text = typeof chosen.address === 'string' ? chosen.address.trim() : ''
  return text === '' ? null : text
}

/**
 * The access settings a fresh document carries, and the fallback for invalid input.
 *
 * A FRESH object every call: `store.js` puts this into a document that is then
 * written and read back, and a shared literal would let one caller's mutation
 * appear in another's settings.
 *
 * @returns {{ mode: 'lan' | 'public', lanAddress: string, public: object[], selectedPublicId: string | null }}
 */
export function defaultAccess() {
  return { mode: 'lan', lanAddress: '', public: [], selectedPublicId: null }
}

/**
 * Read one `settings.access` value field by field, collecting what was wrong.
 *
 * One traversal, two policies — and that is the entire point of this shape:
 *
 *   - {@link normalizeAccess} ignores `errors` and keeps whatever survived
 *     (dropped rows, cleared fields, `lan` instead of an unknown mode). A
 *     `devices.json` on disk must NEVER fail to load because of a hand edit
 *     (`database-guidelines.md`: forward-compatible additions, defaults for
 *     missing fields); a broken address book is a broken LINK, not a broken
 *     plugin.
 *   - {@link validateAccess} turns the first error into a refusal. `POST
 *     /settings` must tell the caller instead of quietly rewriting its input,
 *     or the panel and the user would disagree about what was saved.
 *
 * If the two had their own copies of the rules one of them would drift, and the
 * divergence would be invisible from both sides.
 *
 * @param {unknown} input
 * @returns {{ access: object, errors: string[] }}
 */
function readAccess(input) {
  const errors = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    errors.push('the access setting must be an object')
    return { access: defaultAccess(), errors }
  }

  const rawMode = typeof input.mode === 'string' ? input.mode.trim() : ''
  /* Absent (or empty) means LAN — the mode whose reachability this plugin can
     actually reason about. Never `public` by default: that mode is the user's own
     port mapping, and defaulting into it would present an unchecked link as the
     normal case. An unrecognized value also lands on `lan`, but is recorded, so the
     strict reader can refuse it instead of silently downgrading. */
  let mode = 'lan'
  if (rawMode !== '') {
    if (ACCESS_MODES.includes(rawMode)) mode = rawMode
    else errors.push(`the access mode must be one of ${ACCESS_MODES.join(' / ')}`)
  }

  let lanAddress = ''
  if (input.lanAddress !== undefined && input.lanAddress !== null) {
    if (typeof input.lanAddress !== 'string') {
      errors.push('the LAN address must be a string')
    } else {
      const trimmed = input.lanAddress.trim()
      if (trimmed !== '') {
        /* A bare host only: this value is compared against the NIC list, which
           holds plain IPv4 literals. A scheme or port here could never match, and
           storing something that can never match is a setting that lies. */
        const parsed = parseAddress(trimmed)
        if (parsed === null || parsed.scheme !== null || parsed.port !== null) {
          errors.push('the LAN address must be a bare address such as 192.168.1.5')
        } else {
          lanAddress = parsed.host
        }
      }
    }
  }

  const rawBook = input.public === undefined || input.public === null ? [] : input.public
  const book = []
  const ids = new Set()
  if (!Array.isArray(rawBook)) {
    errors.push('the public address book must be an array')
  } else {
    if (rawBook.length > PUBLIC_ADDRESS_MAX) {
      errors.push(`at most ${PUBLIC_ADDRESS_MAX} public addresses are allowed`)
    }
    /* Over-long lists are TRUNCATED here rather than iterated: the cap exists so a
       dropdown stays usable, and the first N rows are the ones the user ordered. */
    for (const entry of rawBook.slice(0, PUBLIC_ADDRESS_MAX)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push('each public address must be an object')
        continue
      }
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      if (!PUBLIC_ID_PATTERN.test(id)) {
        errors.push('each public address needs an id of letters, digits, dash or underscore')
        continue
      }
      if (ids.has(id)) {
        errors.push('two public addresses share an id')
        continue
      }
      const label = typeof entry.label === 'string' ? entry.label.trim() : ''
      if (label.length > PUBLIC_LABEL_MAX) {
        errors.push(`a public address label is longer than ${PUBLIC_LABEL_MAX} characters`)
        continue
      }
      const parsed = parseAddress(typeof entry.address === 'string' ? entry.address : '')
      if (parsed === null) {
        errors.push('a public address must be a host, host:port or http(s)://host[:port] with no path')
        continue
      }
      ids.add(id)
      book.push({ id, label, address: formatAddress(parsed) })
    }
  }

  const wanted = typeof input.selectedPublicId === 'string' ? input.selectedPublicId.trim() : ''
  return {
    access: {
      mode,
      lanAddress,
      public: book,
      /* A selection that names no row becomes null, which readers resolve to the
         first row. This is the "the user deleted the row they had selected" case,
         and refusing it would make a delete impossible to express in one call. */
      selectedPublicId: wanted !== '' && ids.has(wanted) ? wanted : null,
    },
    errors,
  }
}

/**
 * Normalize one `settings.access` value, keeping everything usable.
 *
 * The LENIENT reader: never throws, never returns a partial object, and never
 * fails on input it can merely drop. See {@link readAccess} for why this and
 * {@link validateAccess} share one traversal.
 *
 * @param {unknown} input
 * @returns {{ mode: 'lan' | 'public', lanAddress: string, public: object[], selectedPublicId: string | null }}
 */
export function normalizeAccess(input) {
  return readAccess(input).access
}

/**
 * Validate one `settings.access` value, refusing anything that needed repairing.
 *
 * The STRICT reader, used by `POST /settings` (`400 admin/invalid-access`). Same
 * rules as {@link normalizeAccess}; the difference is the policy, not the
 * grammar.
 *
 * @param {unknown} input
 * @returns {{ ok: true, access: object } | { ok: false, message: string }}
 */
export function validateAccess(input) {
  const { access, errors } = readAccess(input)
  return errors.length === 0 ? { ok: true, access } : { ok: false, message: errors[0] }
}
