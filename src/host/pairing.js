/**
 * dsh-remote-control — pairing codes.
 *
 * `design.md` §3.1: the desktop panel shows a QR whose fragment carries
 * `<pairId>:<code>`; the remote device POSTs that pair back and receives its
 * device token in a `Set-Cookie`. This module owns the *lifetime* of that pair
 * and nothing else — it holds no devices, touches no filesystem, and mints no
 * tokens. `store.js` owns persistence, `tokens.js` owns credentials; the API
 * layer (stage 4) stitches the two together on a successful redemption.
 *
 * Invariants:
 *
 *   - One-time: a redeemed pair is marked consumed and can never be redeemed
 *     again, even by a caller holding the correct code.
 *   - Short-lived: `PAIRING_TTL_MS` (120s) from creation. Expired pairs are
 *     dropped lazily on access, so no timer and therefore no disposer is needed.
 *   - Bounded memory: pending pairs live in a Map that is swept on every create,
 *     so an abandoned code cannot accumulate.
 *   - The code is compared in constant time, and the comparison never throws.
 *
 * Everything observable is injectable (`now`, `random`) so tests can expire a
 * code without waiting two minutes and mint a deterministic code.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
} from './constants.js'

/** Prefix on every pairing id, so it can never be confused with a device id. */
const PAIR_ID_PREFIX = 'pair_'

/** Bytes of entropy behind a pairing id: 9 bytes = 72 bits, unguessable. */
const PAIR_ID_BYTES = 9

/**
 * A fresh, unguessable pairing id (72 bits of entropy, base64url).
 *
 * Takes the same injected `random` as the code generator: a module with one
 * injected entropy source and one global one is a trap, because a caller that
 * pinned `random` for a deterministic test still gets random ids and cannot
 * assert on them (`.trellis/spec/backend/quality-guidelines.md` — every side
 * effect is a parameter).
 *
 * @param {(size: number) => Buffer} random
 * @returns {string}
 */
function defaultPairId(random) {
  return PAIR_ID_PREFIX + drawBytes(random, PAIR_ID_BYTES).toString('base64url')
}

/**
 * Draw exactly `size` bytes from the injected source, or fail loudly.
 *
 * A short buffer would not throw on its own: `bytes[i]` past the end is
 * `undefined`, and `PAIRING_CODE_ALPHABET[undefined % 32]` is the string
 * `"undefined"` — a 64-character "code" containing literal `undefined`
 * fragments. That is a malformed credential produced in silence, so the seam the
 * spec requires be injectable is also the seam that has to be checked.
 *
 * @param {(size: number) => Buffer} random
 * @param {number} size
 * @returns {Buffer}
 */
function drawBytes(random, size) {
  const bytes = random(size)
  if (!(bytes instanceof Uint8Array) || bytes.length < size) {
    throw pairingError('pairing/entropy', 'the random source returned too few bytes')
  }
  return bytes
}

/**
 * One pairing code: `PAIRING_CODE_LENGTH` characters from the RFC 4648 base32
 * alphabet (A-Z, 2-7 — no `0`/`1`/`8`/`9`, so `O`/`I` confusion cannot happen
 * when the code is read out loud).
 *
 * 32 divides 256 evenly, so `byte % 32` is uniform: no modulo bias.
 *
 * @param {(size: number) => Buffer} random
 * @returns {string}
 */
function defaultCode(random) {
  const bytes = drawBytes(random, PAIRING_CODE_LENGTH)
  let code = ''
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_CODE_ALPHABET[bytes[index] % PAIRING_CODE_ALPHABET.length]
  }
  return code
}

/**
 * Fold typed input back onto the canonical form.
 *
 * Users type the code by hand, so lower case, spaces and dashes are accepted;
 * everything outside the alphabet is dropped. This can only ever *narrow* the
 * input, never smuggle a different code in.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePairingCode(value) {
  if (typeof value !== 'string') return ''
  return value.toUpperCase().replace(/[^A-Z2-7]/g, '')
}

/** Constant-time equality on two already-canonical short strings; never throws. */
function sameCode(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = createHash('sha256').update(left, 'utf8').digest()
  const b = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** Build an Error carrying a stable `code` (see `.trellis/spec/backend/error-handling.md`). */
function pairingError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Create an in-memory pairing store.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] Clock in epoch milliseconds. Injectable so a test can expire a code.
 * @param {(size: number) => Buffer} [options.random] Random-byte source. Injectable so a test can pin the id and the code.
 * @param {number} [options.ttlMs] Lifetime of a code; defaults to `PAIRING_TTL_MS`.
 * @returns {{
 *   create: (options?: { label?: string }) => { pairId: string, code: string, createdAt: number, expiresAt: number, label: string | null },
 *   redeem: (pairId: unknown, code: unknown) => { pairId: string, label: string | null, createdAt: number, expiresAt: number },
 *   sweep: () => number,
 *   pending: () => number,
 * }}
 */
export function createPairingStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const random = typeof options.random === 'function' ? options.random : randomBytes
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : PAIRING_TTL_MS

  /** @type {Map<string, { pairId: string, code: string, label: string | null, createdAt: number, expiresAt: number, usedAt: number | null }>} */
  const entries = new Map()

  /** Drop expired entries. A consumed entry dies with its TTL, so duplicates can still report `pairing/used`. */
  function sweep() {
    const at = now()
    let removed = 0
    for (const [pairId, entry] of entries) {
      if (at >= entry.expiresAt) {
        entries.delete(pairId)
        removed += 1
      }
    }
    return removed
  }

  /**
   * Mint a fresh pair. The clear `code` is returned exactly once — the caller
   * puts it in the QR fragment and must not log it.
   */
  function create(createOptions = {}) {
    sweep()
    const pairId = defaultPairId(random)
    const code = defaultCode(random)
    const createdAt = now()
    const expiresAt = createdAt + ttlMs
    const entry = {
      pairId,
      code,
      label: typeof createOptions.label === 'string' && createOptions.label !== '' ? createOptions.label : null,
      createdAt,
      expiresAt,
      usedAt: null,
    }
    entries.set(pairId, entry)
    return { pairId, code, createdAt, expiresAt, label: entry.label }
  }

  /**
   * Consume a pair.
   *
   * @param {unknown} pairId
   * @param {unknown} code
   * @returns {{ pairId: string, label: string | null, createdAt: number, expiresAt: number }}
   * @throws {Error} `pairing/unknown` | `pairing/expired` | `pairing/used` | `pairing/invalid-code`
   */
  function redeem(pairId, code) {
    const entry = typeof pairId === 'string' ? entries.get(pairId) : undefined
    if (entry === undefined) throw pairingError('pairing/unknown', 'pairing code not found')
    if (now() >= entry.expiresAt) {
      entries.delete(entry.pairId)
      throw pairingError('pairing/expired', 'pairing code expired')
    }
    if (entry.usedAt !== null) throw pairingError('pairing/used', 'pairing code already redeemed')
    const presented = normalizePairingCode(code)
    if (presented === '' || !sameCode(presented, entry.code)) {
      throw pairingError('pairing/invalid-code', 'pairing code mismatch')
    }
    entry.usedAt = now()
    return { pairId: entry.pairId, label: entry.label, createdAt: entry.createdAt, expiresAt: entry.expiresAt }
  }

  /**
   * Number of *redeemable* pairs — used by the panel and by tests.
   *
   * Consumed entries are deliberately kept in the map until their TTL so a
   * second redemption can report `pairing/used` rather than `pairing/unknown`,
   * which is why this counts live-and-unused rather than `entries.size`. A
   * consumed pair reported as "pending" would have the panel show a code that
   * can no longer be redeemed.
   */
  function pending() {
    sweep()
    let redeemable = 0
    for (const entry of entries.values()) {
      if (entry.usedAt === null) redeemable += 1
    }
    return redeemable
  }

  return { create, redeem, sweep, pending }
}
