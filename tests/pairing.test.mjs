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
  PAIRING_IP_MAX_FAILURES,
  PAIRING_IP_WINDOW_MS,
  PAIRING_MAX_ATTEMPTS,
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
  /* A fresh store per case: from stage 2 on, a failed redemption spends the
     per-source budget, so one store across six failures would start reporting
     `pairing/source-locked` partway through and stop testing what it means to. */
  for (const pairId of [undefined, null, 0, {}, [], 'pair']) {
    const { pairing } = makePairing()
    const pair = pairing.create()
    assertCode(() => pairing.redeem(pairId, pair.code), 'pairing/unknown')
  }
  for (const code of [undefined, null, 0, {}, []]) {
    const { pairing } = makePairing()
    const pair = pairing.create()
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

/* ------------------------------------------------------------------ *
 * Gap A: guessing must be bounded (research §7.1)
 *
 * Measured before this was fixed: five wrong codes against one pairId all
 * returned `pairing/invalid-code` with no counting or lockout, and the correct
 * code still redeemed afterwards. These tests exist to keep that closed.
 * ------------------------------------------------------------------ */

/** A wrong code guaranteed to differ from `code`, in the canonical alphabet. */
function wrongCodeFor(code) {
  return code === 'AAAAAAAA' ? 'AAAAAAAB' : 'AAAAAAAA'
}

test('five wrong codes destroy the pair and it reports pairing/locked', () => {
  const { pairing } = makePairing()
  const pair = pairing.create()
  const wrong = wrongCodeFor(pair.code)

  /* Failures 1-4 are ordinary mismatches. */
  for (let attempt = 1; attempt < PAIRING_MAX_ATTEMPTS; attempt += 1) {
    assertCode(() => pairing.redeem(pair.pairId, wrong), 'pairing/invalid-code')
  }

  /* The fifth is the one that reaches the limit, and it reports the lockout. */
  assertCode(() => pairing.redeem(pair.pairId, wrong), 'pairing/locked')

  /* The pair is gone from the panel's point of view. */
  assert.equal(pairing.pending(), 0, 'a locked pair is not offered for redemption')

  /* And the correct code no longer works — this is the whole point. */
  assertCode(() => pairing.redeem(pair.pairId, pair.code), 'pairing/locked')
})

test('a locked pair keeps reporting pairing/locked, not pairing/unknown', () => {
  /* Deleting the entry outright would make the sixth attempt report
     `pairing/unknown`, silently changing what the error means once the limit is
     hit. The tombstone is bounded by the pair's own TTL. */
  const { pairing } = makePairing()
  const pair = pairing.create()
  const wrong = wrongCodeFor(pair.code)

  for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS; attempt += 1) {
    try {
      pairing.redeem(pair.pairId, wrong)
    } catch {
      /* counted below */
    }
  }
  assertCode(() => pairing.redeem(pair.pairId, wrong), 'pairing/locked')
  assertCode(() => pairing.redeem(pair.pairId, pair.code), 'pairing/locked')
})

test('the per-pair limit is independent of the per-source limit', () => {
  /* A user with a fresh pair, from an address with no history, gets the full
     PAIRING_MAX_ATTEMPTS budget on that pair even though another address has
     already burned its own. */
  const { pairing } = makePairing()
  const victim = pairing.create()

  /* Spend another address's entire budget against other pairs. */
  for (let index = 0; index < PAIRING_IP_MAX_FAILURES; index += 1) {
    try {
      pairing.redeem('pair_nope', 'AAAAAAAA', { source: '203.0.113.9' })
    } catch {
      /* expected */
    }
  }

  const wrong = wrongCodeFor(victim.code)
  assertCode(
    () => pairing.redeem(victim.pairId, wrong, { source: '198.51.100.4' }),
    'pairing/invalid-code',
  )
  assert.ok(
    pairing.redeem(victim.pairId, victim.code, { source: '198.51.100.4' }),
    'a clean address still redeems after one bad attempt',
  )
})

test('rotating pairId does not bypass the per-source failure budget', () => {
  /* `pairId` is attacker-chosen on every request, so a per-pair counter alone is
     bypassed by simply varying it. This is the test that proves the second,
     independent limit is doing the work. */
  const { pairing } = makePairing()
  const pairs = []
  for (let index = 0; index < PAIRING_IP_MAX_FAILURES; index += 1) {
    pairs.push(pairing.create())
  }
  pairing.sweep()

  const source = '192.0.2.55'
  let lockedAt = -1
  for (let index = 0; index < PAIRING_IP_MAX_FAILURES; index += 1) {
    /* A different pairId each time — the bypass attempt. */
    try {
      pairing.redeem('pair_' + String(index), 'AAAAAAAA', { source })
    } catch (error) {
      if (error.code === 'pairing/source-locked') {
        lockedAt = index
        break
      }
    }
  }

  /* The attempt that spends the last unit of budget reports the lockout itself,
     so the address is locked on index MAX-1 — the caller learns immediately
     rather than discovering it on the next request. */
  assert.equal(lockedAt, PAIRING_IP_MAX_FAILURES - 1, 'the address is locked on the attempt that spends its budget')

  /* Even a REAL pair and its REAL code is refused now: the address is locked out
     before any pair is even looked at. */
  const real = pairs[0]
  assertCode(() => pairing.redeem(real.pairId, real.code, { source }), 'pairing/source-locked')
})

test('the per-source budget slides with the window instead of staying locked forever', () => {
  const { pairing, clock } = makePairing()
  const source = '192.0.2.77'

  for (let index = 0; index < PAIRING_IP_MAX_FAILURES; index += 1) {
    try {
      pairing.redeem('pair_nope', 'AAAAAAAA', { source })
    } catch {
      /* expected */
    }
  }
  assertCode(() => pairing.redeem('pair_nope', 'AAAAAAAA', { source }), 'pairing/source-locked')

  /* Once the window has passed, the budget is restored. */
  clock.now += PAIRING_IP_WINDOW_MS
  assertCode(() => pairing.redeem('pair_nope', 'AAAAAAAA', { source }), 'pairing/unknown')
})

test('a successful redemption does not spend the failure budget', () => {
  const { pairing } = makePairing()
  const source = '192.0.2.88'

  for (let index = 0; index < PAIRING_IP_MAX_FAILURES * 2; index += 1) {
    const pair = pairing.create()
    assert.ok(pairing.redeem(pair.pairId, pair.code, { source }), 'successful redemptions never accumulate')
    pairing.sweep()
  }
})

test('the per-source map does not grow without bound when sources are rotated', () => {
  /* `pruneSource` only touches the entry it is asked about, so before the global
     sweep a source seen once and never again kept its timestamp — and its Map
     entry — forever. Cycling source values (the same bypass shape the per-source
     limit exists for) therefore grew the map without limit even though every entry
     was already older than the window. The sweep is global and cannot widen a
     budget, only forget what has expired. */
  const { pairing, clock } = makePairing()

  for (let index = 0; index < 5_000; index += 1) {
    const source = `198.51.${String(Math.floor(index / 256))}.${String(index % 256)}`
    try {
      pairing.redeem('pair_nope', 'AAAAAAAA', { source })
    } catch {
      /* expected */
    }
  }
  assert.equal(pairing.sourceCount(), 5_000, 'all five thousand are inside the window')

  /* One window later, one more failure sweeps every expired entry. */
  clock.now += PAIRING_IP_WINDOW_MS + 1
  try {
    pairing.redeem('pair_nope', 'AAAAAAAA', { source: '203.0.113.1' })
  } catch {
    /* expected */
  }
  assert.equal(pairing.sourceCount(), 1, 'only the address that just failed is still on record')
})

test('the sweep never forgets a failure that is still inside its window', () => {
  /* The property that makes the sweep safe: it can only drop entries that have
     already expired, so it can never be used to escape the limit. */
  const { pairing } = makePairing()
  const blocked = '192.0.2.123'

  /* Spend all but one unit of the budget. */
  for (let index = 0; index < PAIRING_IP_MAX_FAILURES - 1; index += 1) {
    try {
      pairing.redeem('pair_nope', 'AAAAAAAA', { source: blocked })
    } catch {
      /* expected */
    }
  }

  /* Churn 200 other sources inside the same window — each one triggers the sweep. */
  for (let index = 0; index < 200; index += 1) {
    try {
      pairing.redeem('pair_nope', 'AAAAAAAA', { source: `198.51.100.${String(index)}` })
    } catch {
      /* expected */
    }
  }

  /* The blocked source's budget is intact: the last unit is still there and the
     attempt that spends it reports the lockout. */
  assertCode(() => pairing.redeem('pair_nope', 'AAAAAAAA', { source: blocked }), 'pairing/source-locked')
  assertCode(() => pairing.redeem('pair_nope', 'AAAAAAAA', { source: blocked }), 'pairing/source-locked')
})

test('resetSource clears one address budget without touching the others', () => {
  const { pairing } = makePairing()
  const blocked = '192.0.2.99'

  for (let index = 0; index < PAIRING_IP_MAX_FAILURES; index += 1) {
    try {
      pairing.redeem('pair_nope', 'AAAAAAAA', { source: blocked })
    } catch {
      /* expected */
    }
  }
  assertCode(() => pairing.redeem('pair_nope', 'AAAAAAAA', { source: blocked }), 'pairing/source-locked')

  assert.equal(pairing.resetSource(blocked), true, 'the panel can unblock a mistyping user')
  assert.equal(pairing.resetSource(blocked), false, 'the second reset has nothing to clear')
  assertCode(() => pairing.redeem('pair_nope', 'AAAAAAAA', { source: blocked }), 'pairing/unknown')

  /* A non-string source is not a source. */
  assert.equal(pairing.resetSource(undefined), false)
  assert.equal(pairing.resetSource(''), false)
})

test('the lockout limits are configurable so a test need not run 20 rounds', () => {
  const pairing = createPairingStore({ now: () => 0, maxAttempts: 2, ipMaxFailures: 3 })
  const pair = pairing.create()

  assertCode(() => pairing.redeem(pair.pairId, 'AAAAAAAA'), 'pairing/invalid-code')
  assertCode(() => pairing.redeem(pair.pairId, 'AAAAAAAA'), 'pairing/locked')

  /* A separate address and a separate pair, so the per-pair limit above does not
     interfere with the per-source one under test. */
  const second = pairing.create()
  const source = '198.51.100.1'
  assertCode(() => pairing.redeem('pair_nope', 'AAAAAAAA', { source }), 'pairing/unknown')
  assertCode(() => pairing.redeem('pair_nope', 'AAAAAAAA', { source }), 'pairing/unknown')
  /* Third failure spends the budget of 3 and reports the lockout. */
  assertCode(() => pairing.redeem('pair_nope', 'AAAAAAAA', { source }), 'pairing/source-locked')
  assertCode(() => pairing.redeem(second.pairId, second.code, { source }), 'pairing/source-locked')
})

/* ------------------------------------------------------------------ *
 * The state read — what the panel's 「刷新」 button asks
 * (2026-10-19: 已用的配对码显示已使用)
 * ------------------------------------------------------------------ */

test('state reports pending, used, locked, expired and unknown', () => {
  const pairing = createPairingStore({ now: () => 0, maxAttempts: 2 })
  const live = pairing.create()
  assert.equal(pairing.state(live.pairId), 'pending', 'a fresh code is waiting')

  pairing.redeem(live.pairId, live.code)
  assert.equal(pairing.state(live.pairId), 'used', 'a redeemed code says so')

  /* A pair burned by wrong guesses is `locked`, not `expired`: they are different
     stories and the panel words them differently. */
  const burned = pairing.create()
  assert.throws(() => pairing.redeem(burned.pairId, 'AAAAAAAA'))
  assert.equal(pairing.state(burned.pairId), 'pending', 'one failed guess does not burn it')
  assert.throws(() => pairing.redeem(burned.pairId, 'AAAAAAAA'))
  assert.equal(pairing.state(burned.pairId), 'locked')

  /* An id this store never minted. */
  assert.equal(pairing.state('pair_nope'), 'unknown')
})

test('state says expired for an untouched code past its TTL, and never for a used one', () => {
  const { pairing, clock } = makePairing()
  const pair = pairing.create()

  clock.now = pair.expiresAt - 1
  assert.equal(pairing.state(pair.pairId), 'pending', 'still live one millisecond before expiry')

  clock.now = pair.expiresAt
  assert.equal(pairing.state(pair.pairId), 'expired')

  /* A second, distinct pair (the helper's entropy is a single byte, so advancing it
     is what makes the id different). */
  clock.advance()
  const redeemed = pairing.create()
  assert.notEqual(redeemed.pairId, pair.pairId)
  pairing.redeem(redeemed.pairId, redeemed.code)
  /* `used` WINS over `expired`: a pair that was redeemed and then aged out is still
     a pair that WORKED, and 「过期」 would tell the user the device was never added. */
  clock.now = redeemed.expiresAt + 1
  assert.equal(pairing.state(redeemed.pairId), 'used')
})

test('state does not sweep, so an aged-out code keeps its own answer', () => {
  /* `sweep()` deletes expired entries; if the state read swept, 「过期」 would
     collapse into 「宿主不认识」 the moment anything else triggered a sweep. */
  const { pairing, clock } = makePairing()
  const pair = pairing.create()
  clock.now = pair.expiresAt + 1

  assert.equal(pairing.state(pair.pairId), 'expired')
  pairing.sweep()
  assert.equal(pairing.state(pair.pairId), 'unknown', 'only an explicit sweep forgets it')
})

test('state spends no failure budget and cannot burn the code it describes', () => {
  /* The panel refreshing itself must never be what kills a live code: asking
     "did my code work?" is not a guess. */
  const { pairing } = makePairing()
  const pair = pairing.create()

  for (let index = 0; index < 50; index += 1) {
    assert.equal(pairing.state(pair.pairId), 'pending')
    assert.equal(pairing.state('pair_nope'), 'unknown')
  }
  assert.equal(pairing.pending(), 1, 'the code is still offerable')
  assert.equal(pairing.sourceCount(), 0, 'and no address was charged for the reads')
  assert.ok(pairing.redeem(pair.pairId, pair.code), 'the real device still pairs')
})

test('state answers for a non-string pairId without throwing', () => {
  const { pairing } = makePairing()
  pairing.create()
  for (const pairId of [undefined, null, 0, {}, [], '']) {
    assert.equal(pairing.state(pairId), 'unknown', String(pairId))
  }
})
