/**
 * Pairing codes: shape, one-time redemption, expiry.
 *
 * `implement.md` stage 1 acceptance: successful redemption, duplicate redemption
 * fails, expired code fails. The clock is pinned through the injected `now`, so
 * "expired" is asserted by advancing a number, never by sleeping.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
} from '../src/host/constants.js'
import { createPairingStore, normalizePairingCode } from '../src/host/pairing.js'
import { makePairing } from './helpers.mjs'

/** Assert a thrown error carries the documented stable `code`. */
function assertCode(fn, expected) {
  let thrown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof Error, `expected a thrown Error with code ${expected}`)
  assert.equal(thrown.code, expected)
}

test('create mints an 8-character base32 code and a distinct pairId', () => {
  const pairing = createPairingStore()
  const pair = pairing.create()

  assert.equal(pair.code.length, PAIRING_CODE_LENGTH)
  for (const character of pair.code) {
    assert.ok(PAIRING_CODE_ALPHABET.includes(character), `unexpected code character ${character}`)
  }
  assert.match(pair.pairId, /^pair_[A-Za-z0-9_-]+$/)
  assert.notEqual(pair.pairId, pair.code)
  assert.equal(pair.expiresAt - pair.createdAt, PAIRING_TTL_MS)
})

test('two codes minted back to back differ', () => {
  const pairing = createPairingStore()
  const codes = new Set(Array.from({ length: 16 }, () => pairing.create().code))
  /* 16 draws from a 32^8 space: a collision means the generator is not random. */
  assert.equal(codes.size, 16)
})

test('redeeming a fresh pair succeeds and reports the pair metadata', () => {
  const { pairing, clock } = makePairing()
  const pair = pairing.create({ label: 'iPhone' })

  const redeemed = pairing.redeem(pair.pairId, pair.code)

  assert.equal(redeemed.pairId, pair.pairId)
  assert.equal(redeemed.label, 'iPhone')
  assert.equal(redeemed.createdAt, pair.createdAt)
  assert.equal(redeemed.expiresAt, pair.expiresAt)
  /* Redeeming must not consume wall-clock time beyond the injected clock. */
  assert.equal(clock.now, pair.createdAt)
})

test('a pair without a label redeems with a null label', () => {
  const { pairing } = makePairing()
  const pair = pairing.create()
  assert.equal(pairing.redeem(pair.pairId, pair.code).label, null)
})

test('duplicate redemption of the same pair fails', () => {
  const { pairing } = makePairing()
  const pair = pairing.create()

  pairing.redeem(pair.pairId, pair.code)

  assertCode(() => pairing.redeem(pair.pairId, pair.code), 'pairing/used')
})

test('a consumed pair stays used even after the code is presented again by a different caller', () => {
  const { pairing, clock } = makePairing()
  const pair = pairing.create()
  pairing.redeem(pair.pairId, pair.code)

  clock.now += 1_000
  assertCode(() => pairing.redeem(pair.pairId, pair.code), 'pairing/used')
})

test('an expired code fails and is dropped', () => {
  const { pairing, clock } = makePairing()
  const pair = pairing.create()

  clock.now = pair.expiresAt - 1
  assert.equal(pairing.pending(), 1, 'still live one millisecond before expiry')

  clock.now = pair.expiresAt
  assertCode(() => pairing.redeem(pair.pairId, pair.code), 'pairing/expired')
  assert.equal(pairing.pending(), 0, 'the expired entry is swept on access')
})

test('an expired code cannot be redeemed twice either', () => {
  const { pairing, clock } = makePairing()
  const pair = pairing.create()
  clock.now = pair.expiresAt + 1

  assertCode(() => pairing.redeem(pair.pairId, pair.code), 'pairing/expired')
  assertCode(() => pairing.redeem(pair.pairId, pair.code), 'pairing/unknown')
})

test('a wrong code fails and does not consume the pair', () => {
  const { pairing } = makePairing(undefined, 0)
  const pair = pairing.create()
  /* Every byte is 0, so the minted code is the first alphabet character repeated. */
  const wrong = pair.code === 'AAAAAAAA' ? 'AAAAAAAB' : 'AAAAAAAA'

  assertCode(() => pairing.redeem(pair.pairId, wrong), 'pairing/invalid-code')
  assert.equal(pairing.pending(), 1, 'a failed attempt must not burn the code')
  assert.ok(pairing.redeem(pair.pairId, pair.code), 'the real code still works after a bad attempt')
})

test('an unknown pairId fails', () => {
  const { pairing } = makePairing()
  pairing.create()
  assertCode(() => pairing.redeem('pair_nope', 'AAAAAAAA'), 'pairing/unknown')
})

test('non-string pairIds and codes fail without throwing a TypeError', () => {
  const { pairing } = makePairing()
  const pair = pairing.create()

  for (const pairId of [undefined, null, 0, {}, [], pair]) {
    assertCode(() => pairing.redeem(pairId, pair.code), 'pairing/unknown')
  }
  for (const code of [undefined, null, 0, {}, []]) {
    assertCode(() => pairing.redeem(pair.pairId, code), 'pairing/invalid-code')
  }
})

test('redeem tolerates hand-typed codes: lower case, spaces and hyphens', () => {
  const { pairing } = makePairing()
  const pair = pairing.create()

  const typed = pair.code.toLowerCase().split('').join(' ')
  const redeemed = pairing.redeem(pair.pairId, typed)
  assert.equal(redeemed.pairId, pair.pairId)
})

test('normalizePairingCode folds input onto the canonical alphabet', () => {
  assert.equal(normalizePairingCode(' abcd-2345 '), 'ABCD2345')
  assert.equal(normalizePairingCode('A0B1C8D9'), 'ABCD', 'digits outside base32 are dropped')
  assert.equal(normalizePairingCode(undefined), '')
  assert.equal(normalizePairingCode(123), '')
})

test('sweep drops only expired pairs and keeps live ones', () => {
  const { pairing, clock } = makePairing()
  const first = pairing.create()
  /* A distinct constant for the second pair, so the two ids differ: the store
     keys pairs by id, and a pinned random source would otherwise mint the same
     id twice and the second create would overwrite the first. */
  clock.advance()
  clock.now += PAIRING_TTL_MS
  const second = pairing.create()

  assert.notEqual(second.pairId, first.pairId)
  assert.equal(pairing.pending(), 1, 'the first pair expired, the second is live')
  assert.equal(pairing.sweep(), 0, 'sweeping again removes nothing')
  assert.ok(pairing.redeem(second.pairId, second.code))
  assertCode(() => pairing.redeem(first.pairId, first.code), 'pairing/unknown')
})

test('each independent pairing store keeps its own codes', () => {
  const one = createPairingStore()
  const two = createPairingStore()
  const pair = one.create()

  assertCode(() => two.redeem(pair.pairId, pair.code), 'pairing/unknown')
})

test('a random source that returns too few bytes fails loudly instead of minting a broken code', () => {
  /* `bytes[i]` past the end is undefined, and `PAIRING_CODE_ALPHABET[undefined %
     32]` is the string "undefined" — a silently malformed credential. The
     injection seam has to be checked as well as injectable. */
  const short = createPairingStore({ now: () => 0, random: () => Buffer.alloc(1, 65) })
  assertCode(() => short.create(), 'pairing/entropy')

  const notBytes = createPairingStore({ now: () => 0, random: () => 'nope' })
  assertCode(() => notBytes.create(), 'pairing/entropy')
})

test('a default pairing store produces distinct pair ids from the real CSPRNG', () => {
  /* Guards the injected source not drifting into a constant in production. */
  const pairing = createPairingStore()
  const ids = new Set(Array.from({ length: 32 }, () => pairing.create().pairId))
  assert.equal(ids.size, 32, 'pair ids must be unique')
  for (const id of ids) assert.match(id, /^pair_[A-Za-z0-9_-]{12}$/, '9 bytes base64url is 12 chars')
})

test('pending counts redeemable pairs, not consumed ones', () => {
  const { pairing } = makePairing()
  const pair = pairing.create()
  assert.equal(pairing.pending(), 1)

  pairing.redeem(pair.pairId, pair.code)
  /* The consumed entry stays in the map until its TTL so a duplicate reports
     `pairing/used`, but it is no longer redeemable — the panel must not offer it. */
  assert.equal(pairing.pending(), 0)
  assertCode(() => pairing.redeem(pair.pairId, pair.code), 'pairing/used')
})
