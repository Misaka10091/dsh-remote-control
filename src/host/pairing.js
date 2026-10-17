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
 *   - GUESSING IS BOUNDED (`research/official-connection-fence.md` §7.1). Before
 *     this module had any limit, five wrong codes against one `pairId` left the
 *     pair intact and the right code still redeemable. Two independent limits
 *     now apply, and they must stay independent:
 *       · per-pair: `PAIRING_MAX_ATTEMPTS` wrong codes destroy the pair;
 *       · per-source-address: `PAIRING_IP_MAX_FAILURES` wrong codes per
 *         `PAIRING_IP_WINDOW_MS`. `pairId` is attacker-supplied, so a per-pair
 *         limit alone is bypassed by simply varying it.
 *
 * Everything observable is injectable (`now`, `random`, and the three limits) so
 * tests can expire a code without waiting two minutes, mint a deterministic code,
 * and exhaust a budget without 20 round trips.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_IP_MAX_FAILURES,
  PAIRING_IP_WINDOW_MS,
  PAIRING_MAX_ATTEMPTS,
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
 * @param {number} [options.maxAttempts] Wrong codes one pair tolerates; defaults to `PAIRING_MAX_ATTEMPTS`.
 * @param {number} [options.ipMaxFailures] Wrong codes one source address tolerates per window; defaults to `PAIRING_IP_MAX_FAILURES`.
 * @param {number} [options.ipWindowMs] Length of that window; defaults to `PAIRING_IP_WINDOW_MS`.
 * @returns {{
 *   create: (options?: { label?: string }) => { pairId: string, code: string, createdAt: number, expiresAt: number, label: string | null },
 *   redeem: (pairId: unknown, code: unknown, options?: { source?: string }) => { pairId: string, label: string | null, createdAt: number, expiresAt: number },
 *   sweep: () => number,
 *   pending: () => number,
 *   resetSource: (source: unknown) => boolean,
 * }}
 */
export function createPairingStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const random = typeof options.random === 'function' ? options.random : randomBytes
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : PAIRING_TTL_MS
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : PAIRING_MAX_ATTEMPTS
  const ipMaxFailures = Number.isInteger(options.ipMaxFailures) && options.ipMaxFailures > 0
    ? options.ipMaxFailures
    : PAIRING_IP_MAX_FAILURES
  const ipWindowMs = Number.isFinite(options.ipWindowMs) && options.ipWindowMs > 0
    ? options.ipWindowMs
    : PAIRING_IP_WINDOW_MS

  /**
   * @type {Map<string, {
   *   pairId: string,
   *   code: string,
   *   label: string | null,
   *   createdAt: number,
   *   expiresAt: number,
   *   usedAt: number | null,
   *   failures: number,
   * }>}
   */
  const entries = new Map()

  /**
   * Per-source failure budget: address → failure timestamps inside the window.
   *
   * Timestamps, not a count, so the window can slide: a burst of failures does
   * not lock an address out for a full window after the burst has aged out.
   *
   * @type {Map<string, number[]>}
   */
  const sourceFailures = new Map()

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

  /** Drop failure timestamps that have aged out of the window. */
  function pruneSource(source, at) {
    const recorded = sourceFailures.get(source)
    if (recorded === undefined) return []
    const fresh = recorded.filter((stamp) => at - stamp < ipWindowMs)
    if (fresh.length === 0) sourceFailures.delete(source)
    else sourceFailures.set(source, fresh)
    return fresh
  }

  /**
   * Record one failed redemption against its source.
   *
   * @param {string | undefined} source Caller-supplied address, or `undefined` when unknowable.
   */
  function recordSourceFailure(source, at) {
    if (source === undefined || source === '') return
    const recorded = pruneSource(source, at)
    recorded.push(at)
    sourceFailures.set(source, recorded)
  }

  /** Whether this source has already spent its failure budget. */
  function isSourceLockedOut(source, at) {
    if (source === undefined || source === '') return false
    return pruneSource(source, at).length >= ipMaxFailures
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
      failures: 0,
    }
    entries.set(pairId, entry)
    return { pairId, code, createdAt, expiresAt, label: entry.label }
  }

  /**
   * Consult the per-pair lockout without touching it.
   *
   * @param {object | undefined} entry
   * @returns {boolean}
   */
  function isPairLockedOut(entry) {
    return entry !== undefined && entry.failures >= maxAttempts
  }

  /**
   * Spend both failure budgets for one wrong guess, and report the headline.
   *
   * Both limits are debited in the SAME call, so they cannot drift apart: every
   * path that counts a guess counts it exactly once against each budget. The
   * default headline is `fallback` — the pair's own state, which is what the
   * caller asked about — but a guess that exhausts the per-source budget
   * overrides it with `pairing/source-locked`: that state outlives the pair,
   * applies to the next request regardless of which pair it names, and telling
   * the user about a burned code while their address is also blocked would send
   * them chasing the narrower problem.
   *
   * @param {string | undefined} source
   * @param {number} at
   * @param {object | undefined} entry Pair to debit; undefined when no pair was found.
   * @param {string} fallback Error code describing the pair's own state.
   * @returns {string}
   */
  function registerFailure(source, at, entry, fallback) {
    if (entry !== undefined) entry.failures += 1
    recordSourceFailure(source, at)
    if (isSourceLockedOut(source, at)) return 'pairing/source-locked'
    return fallback
  }

  /**
   * Consume a pair.
   *
   * The order of the checks is deliberate and must not be reshuffled:
   *
   *   1. source lockout — true regardless of the pair named, so an address that
   *      has spent its budget learns nothing more about any pair;
   *   2. per-pair lockout — the pair is already destroyed; say so rather than
   *      pretending it never existed, which would send the user hunting for a
   *      typo in a code that was burned on purpose;
   *   3. unknown / expired / used — the pair's own state;
   *   4. the code itself — the only constant-time comparison in the sequence.
   *
   * Every GUESS spends budget (unknown pairId included — it is a free one-bit
   * oracle otherwise). An expired or already-redeemed pair is not a guess and
   * does not: the caller presented the right code, or no code at all.
   *
   * A locked pair is KEPT in the map until its TTL expires and reports
   * `pairing/locked` on every later attempt. Deleting it outright would make the
   * next attempt report `pairing/unknown`, i.e. the error would silently change
   * meaning the moment the limit was hit. Its TTL is at most two minutes, so
   * keeping the tombstone is bounded memory, not a leak.
   *
   * @param {unknown} pairId
   * @param {unknown} code
   * @param {{ source?: string }} [redeemOptions] Caller address, for the per-source budget.
   * @returns {{ pairId: string, label: string | null, createdAt: number, expiresAt: number }}
   * @throws {Error} `pairing/source-locked` | `pairing/locked` | `pairing/unknown` |
   *   `pairing/expired` | `pairing/used` | `pairing/invalid-code`
   */
  function redeem(pairId, code, redeemOptions = {}) {
    const at = now()
    const source = typeof redeemOptions.source === 'string' ? redeemOptions.source : undefined

    if (isSourceLockedOut(source, at)) {
      throw pairingError('pairing/source-locked', 'too many failed pairing attempts from this address')
    }

    const entry = typeof pairId === 'string' ? entries.get(pairId) : undefined
    if (entry === undefined) {
      throw pairingError(
        registerFailure(source, at, undefined, 'pairing/unknown'),
        'pairing code not found',
      )
    }
    if (isPairLockedOut(entry)) {
      throw pairingError(
        registerFailure(source, at, undefined, 'pairing/locked'),
        'too many failed attempts for this pairing code',
      )
    }
    if (at >= entry.expiresAt) {
      entries.delete(entry.pairId)
      throw pairingError('pairing/expired', 'pairing code expired')
    }
    if (entry.usedAt !== null) throw pairingError('pairing/used', 'pairing code already redeemed')
    const presented = normalizePairingCode(code)
    if (presented === '' || !sameCode(presented, entry.code)) {
      /* The attempt that reaches the per-pair limit reports the lockout itself,
         not `invalid-code`: at that instant the pair is destroyed, and leaving the
         caller to discover it on the next request would mean the response to their
         own guess never mentions what it did. */
      const exhausted = entry.failures + 1 >= maxAttempts
      throw pairingError(
        registerFailure(source, at, entry, exhausted ? 'pairing/locked' : 'pairing/invalid-code'),
        exhausted ? 'too many failed attempts for this pairing code' : 'pairing code mismatch',
      )
    }
    entry.usedAt = at
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
   *
   * A locked pair is excluded for the same reason: it can never be redeemed, so
   * offering it in the panel would be a lie.
   */
  function pending() {
    sweep()
    let redeemable = 0
    for (const entry of entries.values()) {
      if (entry.usedAt === null && entry.failures < maxAttempts) redeemable += 1
    }
    return redeemable
  }

  /**
   * Forget an address's failure history.
   *
   * Exists so a legitimate user who mistyped a few codes on a shared LAN address
   * can be unblocked — from the desktop panel, which is loopback-only, without
   * restarting the process. Returns whether anything was actually cleared.
   *
   * @param {unknown} source
   * @returns {boolean}
   */
  function resetSource(source) {
    if (typeof source !== 'string' || source === '') return false
    return sourceFailures.delete(source)
  }

  return { create, redeem, sweep, pending, resetSource }
}
