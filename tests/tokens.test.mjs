/**
 * The device credential: signing, verification, and every way a hostile token can
 * be refused.
 *
 * This is the suite that carries the security of the whole gateway. The credential
 * is a signed JWT (`research/jwt-device-credential.md`), so the failure modes are
 * the JWT-specific ones — and each of the four below has shipped as a real
 * vulnerability somewhere:
 *
 *   1. **`alg: none`.** A verifier that reads the algorithm out of the token and
 *      obliges will accept a token with no signature at all. Asserted explicitly,
 *      along with `HS512`, `RS256` and a lower-case spelling.
 *   2. **Algorithm confusion.** Signing with one algorithm and presenting a
 *      header that names another. Refused at the header, before any HMAC.
 *   3. **Tampering.** Editing the payload while keeping the signature, or editing
 *      the signature. Both must fail, and the payload case is the one that matters:
 *      a verifier that only checked the signature's length or prefix would pass it.
 *   4. **Throwing on hostile input.** A signature comparison that raises on a
 *      length mismatch turns a rejected credential into a 500. Every entry point is
 *      therefore driven with degenerate strings, and the assertion is
 *      `doesNotThrow` as much as it is the return value.
 *
 * The claims checks (`iss`, `aud`, `exp`, `nbf`) are here too, because a signature
 * only proves the key signed *something*: without an audience check, a token minted
 * for another purpose with the same key is a valid device credential.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'

import {
  JWT_AUDIENCE,
  JWT_CLOCK_SKEW_SECONDS,
  JWT_ISSUER,
  JWT_MAX_LENGTH,
} from '../src/host/constants.js'
import {
  hashToken,
  isSigningKey,
  sameTokenHash,
  signDeviceToken,
  verifyDeviceToken,
  verifyToken,
} from '../src/host/tokens.js'
import { TEST_JWT_KEY } from './helpers.mjs'

/** A fixed clock inside every test's window: 2026-10-17T03:04:43.000Z. */
const NOW_MS = Date.UTC(2026, 9, 17, 3, 4, 43)
const NOW_S = Math.floor(NOW_MS / 1000)
const now = () => NOW_MS

/** Decode a JWS segment as JSON. Test-side only; the module never trusts it. */
function claimsOf(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
}

/** Decode the header of a JWS. */
function headerOf(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString('utf8'))
}

/** Re-encode a header or payload object as a JWS segment. */
function segmentOf(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** Sign an arbitrary header/payload pair with a key — the attacker's side. */
function forge(header, payload, key = TEST_JWT_KEY) {
  const signingInput = `${segmentOf(header)}.${segmentOf(payload)}`
  const signature = createHmac('sha256', key).update(signingInput, 'ascii').digest('base64url')
  return `${signingInput}.${signature}`
}

/**
 * A valid claim set at the frozen clock.
 *
 * The `iss`/`aud` values come from the constants, not from literals, so a test that
 * changed the issuer would follow the module rather than drift from it — and a
 * forged token that OMITS them (as `signDeviceToken` cannot) is refused, which is
 * what makes the issuer/audience checks testable at all.
 */
function claims(overrides = {}) {
  return {
    iss: JWT_ISSUER,
    sub: 'dev_1',
    aud: JWT_AUDIENCE,
    name: 'iPhone · Safari',
    iat: NOW_S,
    exp: NOW_S + 3600,
    jti: 'jti-default',
    ...overrides,
  }
}

/** Sign with the frozen clock, so `exp` comparisons are deterministic.
 * `signDeviceToken` mints its own `jti` when the claim set omits one, so the
 * default helper leaves it out — that is the code path the module actually runs. */
/**, and `name` too — the default helper signs a token with no label, because a
 * name is a display convenience and its absence is a case worth exercising. */
function sign(overrides = {}, key = TEST_JWT_KEY) {
  const all = claims()
  const withoutDefaults = { ...all, ...overrides }
  if (!('jti' in overrides)) delete withoutDefaults.jti
  if (!('name' in overrides)) delete withoutDefaults.name
  return signDeviceToken(withoutDefaults, key, { now })
}

/** Verify with the frozen clock. `key === undefined` does NOT default: a test must
 * be able to present a missing key and get a refusal, not the shared test key. */
function verify(jwt, key) {
  return verifyDeviceToken(jwt, arguments.length < 2 ? TEST_JWT_KEY : key, { now })
}

/* ------------------------------------------------------------------ *
 * Round trip
 * ------------------------------------------------------------------ */

test('a signed token verifies and carries exactly the documented claims', () => {
  const jwt = sign({ name: 'iPhone · Safari' })
  const verified = verify(jwt)

  assert.ok(verified !== undefined, 'a freshly signed token must verify')
  assert.equal(verified.iss, JWT_ISSUER)
  assert.equal(verified.aud, JWT_AUDIENCE)
  assert.equal(verified.sub, 'dev_1', 'sub is the device id, and the revocation key')
  assert.equal(verified.name, 'iPhone · Safari')
  assert.equal(verified.iat, NOW_S)
  assert.equal(verified.exp, NOW_S + 3600)
  assert.equal(typeof verified.jti, 'string')
  assert.ok(verified.jti.length > 0, 'jti is minted when the caller does not supply one')
})

test('a token signed without a name still verifies, with an empty label', () => {
  /* `name` is a display convenience, never an authorization input. A null-prototype
     `{}` claim would otherwise have to be special-cased at every call site. */
  const verified = verify(sign())
  assert.equal(verified.sub, 'dev_1')
  assert.equal(verified.name, '')
})

test('the token is three base64url segments with an HS256 JWT header', () => {
  const jwt = sign()
  const segments = jwt.split('.')
  assert.equal(segments.length, 3, 'a JWS compact serialization')
  for (const segment of segments) {
    assert.match(segment, /^[A-Za-z0-9_-]+$/, 'unpadded base64url: cookie-safe, no escaping')
  }
  assert.deepEqual(headerOf(jwt), { alg: 'HS256', typ: 'JWT' })
})

test('the payload carries no credential, hash, pairing code or address', () => {
  /* A JWT is signed, not encrypted: everything in it is readable by the device and
     by anything that later logs the cookie. So the claim set is a public document
     and may hold only identifiers (`research/jwt-device-credential.md` §3.2). */
  const payload = claimsOf(sign())
  assert.deepEqual(Object.keys(payload), ['iss', 'sub', 'aud', 'iat', 'exp', 'jti', 'name'])

  const serialized = JSON.stringify(payload).toLowerCase()
  for (const forbidden of ['dsh-auth', 'tokenhash', 'pair_', '192.168', '127.0.0.1', 'cookie']) {
    assert.ok(!serialized.includes(forbidden), `the payload must not carry ${forbidden}`)
  }
})

test('two signings of the same claims differ, because the jti is fresh', () => {
  const first = sign()
  const second = sign()
  assert.notEqual(first, second)
  assert.notEqual(claimsOf(first).jti, claimsOf(second).jti, 'each token gets its own id')
})

test('an explicit exp, iat, jti and name are honoured exactly', () => {
  const jwt = sign({ iat: 1000, exp: 2000, jti: 'jti-fixed', name: 'tablet' })
  const verified = verify(jwt, TEST_JWT_KEY)
  /* Verified under the frozen clock, so 2000 is long expired — sign without the
     frozen clock's `exp` check by verifying with a clock inside the window. */
  assert.equal(verified, undefined, 'a token with exp=2000 is expired in 2026')

  const live = verifyDeviceToken(jwt, TEST_JWT_KEY, { now: () => 1_500_000 })
  assert.equal(live.exp, 2000)
  assert.equal(live.iat, 1000)
  assert.equal(live.jti, 'jti-fixed')
  assert.equal(live.name, 'tablet')
})

test('ttlSeconds is turned into exp, and a missing exp is refused', () => {
  const jwt = signDeviceToken({ sub: 'dev_1', ttlSeconds: 60 }, TEST_JWT_KEY, { now })
  assert.equal(verify(jwt).exp, NOW_S + 60)

  /* No exp and no ttl is a programming fault, not a token: a bearer token that
     never expires would be a permanent credential. */
  assert.throws(
    () => signDeviceToken({ sub: 'dev_1' }, TEST_JWT_KEY, { now }),
    (error) => error.code === 'token/claims',
  )
})

/* ------------------------------------------------------------------ *
 * 1. Algorithm confusion — the classic JWT hole
 * ------------------------------------------------------------------ */

test('alg: none is rejected even though it has no signature to check', () => {
  /* THE canonical JWT vulnerability: a verifier that reads `alg` from the token
     and obliges accepts a token whose signature is empty or absent, so anyone can
     mint one. The header says `none`; the payload is otherwise perfectly valid. */
  const jwt = `${segmentOf({ alg: 'none', typ: 'JWT' })}.${segmentOf(claims())}.`
  assert.equal(verify(jwt), undefined)

  /* Same token with a signature segment that is merely empty-but-present. */
  const padded = `${segmentOf({ alg: 'none' })}.${segmentOf(claims())}.AAAA`
  assert.equal(verify(padded), undefined)

  /* Case matters: `None` is not `none`, and neither is accepted. */
  for (const spelling of ['None', 'NONE', 'noNe']) {
    assert.equal(verify(`${segmentOf({ alg: spelling })}.${segmentOf(claims())}.AAAA`), undefined, spelling)
  }
})

test('alg: HS512 is rejected even when the signature is a real HS256 one', () => {
  /* The signature below is genuinely correct for HS256. A verifier that computed
     `createHmac(header.alg, …)` would also accept this; one that trusts the header
     to select a longer digest would reject the honest token. Both are wrong, so the
     header is compared against the one constant and nothing else. */
  const honest = sign()
  const [headerSegment, payloadSegment, signatureSegment] = honest.split('.')
  assert.equal(verify(honest).sub, 'dev_1', 'the HS256 token itself is fine')

  const relabelled = `${segmentOf({ alg: 'HS512', typ: 'JWT' })}.${payloadSegment}.${signatureSegment}`
  assert.equal(verify(relabelled), undefined, 'a relabelled header must not inherit the signature')
  assert.ok(headerSegment !== segmentOf({ alg: 'HS512' }), 'the segments really do differ')
})

test('every other algorithm name is rejected, valid signature or not', () => {
  for (const alg of ['RS256', 'ES256', 'PS256', 'HS384', 'hs256', 'HS256 ', '', 42, null, undefined]) {
    const jwt = forge({ alg, typ: 'JWT' }, claims())
    assert.equal(verify(jwt), undefined, `alg=${String(alg)} must be refused`)
  }
})

test('a header with no alg at all is rejected', () => {
  assert.equal(verify(forge({ typ: 'JWT' }, claims())), undefined)
})

/* ------------------------------------------------------------------ *
 * 2. Tampering
 * ------------------------------------------------------------------ */

test('a tampered payload fails even though the signature is untouched', () => {
  /* The attack that matters: the device holds a real token and edits `sub` to
     another device, or edits `exp` to extend its own life. The signature covers
     the encoded payload, so any change invalidates it. */
  const jwt = sign()
  const [headerSegment, payloadSegment, signatureSegment] = jwt.split('.')

  for (const edited of [
    { ...claimsOf(jwt), sub: 'dev_2' },
    { ...claimsOf(jwt), exp: NOW_S + 86_400 * 365 },
    { ...claimsOf(jwt), name: 'renamed' },
    { ...claimsOf(jwt), aud: 'someone-else' },
  ]) {
    const forged = `${headerSegment}.${segmentOf(edited)}.${signatureSegment}`
    assert.equal(verify(forged), undefined, JSON.stringify(edited).slice(0, 60))
  }
})

test('a tampered signature fails', () => {
  const jwt = sign()
  const [headerSegment, payloadSegment, signatureSegment] = jwt.split('.')

  /* Flip a REAL bit in the decoded signature rather than nudging the last
     character: a 32-byte HMAC encodes to 43 base64url characters, and the final
     character carries only 4 significant bits, so changing it can leave the decoded
     bytes identical — a test that "tampered" that character would pass against a
     broken verifier. */
  const signature = Buffer.from(signatureSegment, 'base64url')
  for (const index of [0, 15, signature.length - 1]) {
    const tampered = Buffer.from(signature)
    tampered[index] ^= 0x01
    assert.equal(
      verify(`${headerSegment}.${payloadSegment}.${tampered.toString('base64url')}`),
      undefined,
      `a flipped bit at byte ${String(index)} must invalidate the signature`,
    )
  }

  /* And an all-or-nothing replacement, which is what a guess looks like. */
  assert.equal(
    verify(`${headerSegment}.${payloadSegment}.${Buffer.alloc(32, 0xff).toString('base64url')}`),
    undefined,
  )
})

test('a signature from a different key fails', () => {
  const other = Buffer.alloc(32, 0x11)
  const jwt = sign({}, other)
  assert.equal(verify(jwt), undefined, 'the same claims signed by another key are not this key’s token')
  assert.equal(verify(jwt, other).sub, 'dev_1', 'but they verify against their own key')
})

test('a signature of the wrong length fails without throwing', () => {
  /* `timingSafeEqual` raises on a length mismatch, so both operands are digested
     first — this asserts the guard actually runs, since a throw here would be a 500
     on an unauthenticated request. */
  const jwt = sign()
  const [headerSegment, payloadSegment, signatureSegment] = jwt.split('.')
  for (const cut of [signatureSegment.slice(0, 10), signatureSegment.slice(0, 42), `${signatureSegment}AAAA`]) {
    assert.doesNotThrow(() => verify(`${headerSegment}.${payloadSegment}.${cut}`))
    assert.equal(verify(`${headerSegment}.${payloadSegment}.${cut}`), undefined)
  }
})

test('a token signed for another audience or issuer is rejected', () => {
  /* A signature only proves the key signed something. Without these two checks, a
     token the same key minted for another service would be a valid device
     credential here — the reason `aud` exists at all. */
  for (const override of [{ iss: 'someone-else' }, { iss: 'dsh-remote-control ' }, { aud: 'dsh-gateway-x' }, { aud: '' }]) {
    const jwt = forge({ alg: 'HS256', typ: 'JWT' }, { ...claims(), ...override })
    assert.equal(verify(jwt), undefined, JSON.stringify(override))
  }

  const missingIss = forge({ alg: 'HS256' }, { ...claims(), iss: undefined })
  assert.equal(verify(missingIss), undefined)
})

test('a token with no sub is rejected', () => {
  /* `sub` is the only claim used for authorization. Without it there is nothing to
     look up, and a lookup of `undefined` must never fall through to "allow". */
  for (const sub of [undefined, null, '', 42, {}]) {
    const jwt = forge({ alg: 'HS256' }, { ...claims(), sub })
    assert.equal(verify(jwt), undefined, `sub=${String(sub)}`)
  }
})

/* ------------------------------------------------------------------ *
 * 3. Expiry, with a bounded clock skew
 * ------------------------------------------------------------------ */

test('an expired token is refused', () => {
  /* "Expired" here means past `exp` AND past the skew allowance. `exp` alone is
     not the boundary — see the next test, which pins both sides of it. */
  const jwt = sign({ exp: NOW_S - JWT_CLOCK_SKEW_SECONDS - 1 })
  assert.equal(verify(jwt), undefined)
})

test('a token expiring within the skew allowance is still accepted, and one past it is not', () => {
  /* A phone whose clock runs fast must not be refused a token it just received —
     the symptom ("paired, then 401") would point at the credential rather than at
     the clock. The allowance is bounded so it can never resurrect a long-dead
     token: it buys seconds, not days. */
  assert.equal(verify(sign({ exp: NOW_S - 1 })).sub, 'dev_1', 'one second past exp: inside the allowance')
  assert.equal(verify(sign({ exp: NOW_S - JWT_CLOCK_SKEW_SECONDS })).sub, 'dev_1', 'exactly at the edge')
  assert.equal(verify(sign({ exp: NOW_S - JWT_CLOCK_SKEW_SECONDS - 1 })), undefined, 'one second past it')

  /* And the allowance is a fixed small number, not "any past expiry". */
  assert.equal(verify(sign({ exp: NOW_S - 3600 })), undefined, 'an hour dead is dead')
})

test('a token with no exp is refused rather than treated as never expiring', () => {
  const jwt = forge({ alg: 'HS256' }, { ...claims(), exp: undefined })
  assert.equal(verify(jwt), undefined)

  for (const exp of ['soon', null, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(verify(forge({ alg: 'HS256' }, { ...claims(), exp })), undefined, String(exp))
  }
})

test('nbf is honoured when present, so a future token is not accepted early', () => {
  /* This package never mints `nbf`, but a verifier that ignored it would accept a
     token minted for a future window — so the check exists and is asserted. `nbf`
     cannot come through `signDeviceToken` (the claim set is fixed); it is forged
     here with a correct signature, which is exactly the shape a second issuer
     using the same key would produce. */
  const header = { alg: 'HS256', typ: 'JWT' }
  assert.equal(verify(forge(header, { ...claims(), nbf: NOW_S + 3600 })), undefined, 'not valid yet')
  assert.equal(
    verify(forge(header, { ...claims(), nbf: NOW_S + JWT_CLOCK_SKEW_SECONDS })).sub,
    'dev_1',
    'inside the skew allowance',
  )
  assert.equal(verify(forge(header, { ...claims(), nbf: NOW_S - 10 })).sub, 'dev_1', 'already valid')
  assert.equal(verify(forge(header, { ...claims(), nbf: 'later' })), undefined, 'malformed nbf')
})

test('the lifetime survives a real clock, not only a frozen one', () => {
  /* The suites freeze `now`; the host does not. A token signed for 30 days from the
     REAL clock must verify under the real clock, or pairing would produce a
     credential that fails on its very next request. */
  const jwt = signDeviceToken({ sub: 'dev_1', ttlSeconds: 2592_000 }, TEST_JWT_KEY)
  assert.equal(verifyDeviceToken(jwt, TEST_JWT_KEY).sub, 'dev_1')

  const expired = signDeviceToken({ sub: 'dev_1', ttlSeconds: 1 }, TEST_JWT_KEY, {
    now: () => Date.now() - 120_000,
  })
  assert.equal(verifyDeviceToken(expired, TEST_JWT_KEY), undefined, 'two minutes past a one-second life')
})

/* ------------------------------------------------------------------ *
 * 4. Hostile input never throws
 * ------------------------------------------------------------------ */

test('malformed and degenerate tokens return undefined instead of throwing', () => {
  const cases = [
    '', '..', '.', 'a', 'a.b', 'a.b.c', 'a.b.c.d', '...',
    `${segmentOf({ alg: 'HS256' })}..`,
    `${segmentOf({ alg: 'HS256' })}.${segmentOf(claims())}`,
    `${segmentOf({ alg: 'HS256' })}.${segmentOf(claims())}.`,
    'not-a-jwt-at-all',
    '💥.💥.💥',
    `${'A'.repeat(5000)}.${'B'.repeat(5000)}.${'C'.repeat(5000)}`,
    `${segmentOf({ alg: 'HS256' })}.${'!!!not base64url!!!'}.AAAA`,
    `${segmentOf({ alg: 'HS256' })}.${segmentOf([1, 2, 3])}.AAAA`,
    `${segmentOf({ alg: 'HS256' })}.${segmentOf('a string')}.AAAA`,
    `${segmentOf({ alg: 'HS256' })}.${segmentOf(null)}.AAAA`,
    `${segmentOf([1, 2, 3])}.${segmentOf(claims())}.AAAA`,
  ]
  for (const candidate of cases) {
    let result
    assert.doesNotThrow(() => { result = verify(candidate) }, `threw on: ${candidate.slice(0, 24)}`)
    assert.equal(result, undefined, `accepted: ${candidate.slice(0, 24)}`)
  }
})

test('non-string tokens return undefined instead of throwing', () => {
  for (const candidate of [undefined, null, 0, 1, true, {}, [], Buffer.from('a.b.c'), () => {}]) {
    assert.doesNotThrow(() => verify(candidate))
    assert.equal(verify(candidate), undefined)
  }
})

test('a non-Buffer or too-short key is refused rather than signing weakly', () => {
  /* A string or an empty Buffer "works" with `createHmac` because it is coerced.
     Either would be a signing key an attacker can guess, so both are refused
     loudly at sign time and answered `undefined` at verify time. */
  for (const key of [undefined, null, '', 'a-string-key-that-is-long-enough', Buffer.alloc(0), Buffer.alloc(15)]) {
    assert.equal(isSigningKey(key), false, String(key))
    assert.doesNotThrow(() => verify(sign(), key))
    assert.equal(verify(sign(), key), undefined)
    assert.throws(
      () => signDeviceToken({ sub: 'dev_1', ttlSeconds: 60 }, key),
      (error) => error.code === 'token/key',
      `signing must refuse the key: ${String(key)}`,
    )
  }
  assert.equal(isSigningKey(Buffer.alloc(32)), true)
  assert.equal(isSigningKey(Buffer.alloc(16)), true, '16 bytes is the documented floor')
})

test('the token length is bounded before any work is done', () => {
  /* An unauthenticated caller must not choose how much hashing this function does.
     A megabyte "cookie" is refused on its length, not split and hashed. */
  const huge = `${'A'.repeat(JWT_MAX_LENGTH)}.${'B'.repeat(10)}.${'C'.repeat(10)}`
  assert.ok(huge.length > JWT_MAX_LENGTH)
  assert.equal(verify(huge), undefined)
  /* And a real token is comfortably inside the bound. */
  assert.ok(sign().length < JWT_MAX_LENGTH)
})

test('signing refuses non-object claims and a missing subject', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.throws(
      () => signDeviceToken(bad, TEST_JWT_KEY, { now }),
      (error) => error.code === 'token/claims',
      String(bad),
    )
  }
  assert.throws(
    () => signDeviceToken({ ttlSeconds: 60 }, TEST_JWT_KEY, { now }),
    (error) => error.code === 'token/claims',
  )
})

test('a short buffer from an injected random source fails loudly, not silently', () => {
  /* `quality-guidelines.md` §5: a short buffer would otherwise produce an
     `undefined`-joined id, i.e. a token whose jti is a constant. */
  assert.throws(
    () => signDeviceToken({ sub: 'dev_1', ttlSeconds: 60 }, TEST_JWT_KEY, {
      now,
      random: (size) => Buffer.alloc(size - 1),
    }),
    (error) => error.code === 'token/entropy',
  )
})

/* ------------------------------------------------------------------ *
 * The legacy digest primitives (kept, and still correct)
 * ------------------------------------------------------------------ */

test('hashToken is stable and encodes non-strings as the empty string', () => {
  assert.equal(hashToken('abc'), hashToken('abc'))
  assert.equal(hashToken(undefined), hashToken(''))
  assert.equal(hashToken(null), hashToken(''))
  assert.equal(hashToken(123), hashToken(''))
})

test('sameTokenHash compares digests in constant time and refuses non-digests', () => {
  /* Both sides are sha256 hex, so `timingSafeEqual` cannot throw. A non-digest is
     refused rather than hashed — the defect that once made
     `verifyToken('x','x') === true`. */
  const digest = hashToken('abc')
  assert.equal(sameTokenHash(digest, digest), true)
  assert.equal(sameTokenHash(digest, hashToken('abd')), false)
  for (const malformed of ['x', 'hunter2', digest.toUpperCase(), digest.slice(0, 63), '', undefined]) {
    assert.equal(sameTokenHash(malformed, malformed), false, String(malformed))
    assert.equal(sameTokenHash(digest, malformed), false, String(malformed))
  }
})

test('verifyToken still refuses a hash presented as a token', () => {
  const tokenHash = hashToken('the-token')
  assert.equal(verifyToken('the-token', tokenHash), true)
  assert.equal(verifyToken(tokenHash, tokenHash), false, 'holding the digest must not authenticate')
})
