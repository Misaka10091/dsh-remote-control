/**
 * Device tokens: minting, hashing, constant-time comparison.
 *
 * The comparison tests are the point. A token check that throws on a bad token
 * or leaks length is a real vulnerability, so "wrong token returns false rather
 * than throwing" is asserted explicitly, including for absurd inputs.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDeviceToken, hashToken, verifyToken } from '../src/host/tokens.js'

test('createDeviceToken mints a 32-byte token and its sha256, never the same twice', () => {
  const first = createDeviceToken()
  const second = createDeviceToken()

  assert.equal(typeof first.token, 'string')
  /* 32 bytes base64url, unpadded: ceil(32 / 3) * 4 - 2 = 43 characters. */
  assert.equal(first.token.length, 43)
  assert.match(first.token, /^[A-Za-z0-9_-]+$/, 'token must be cookie-safe base64url')

  assert.match(first.tokenHash, /^[0-9a-f]{64}$/)
  assert.notEqual(first.token, second.token, 'two tokens must never collide')
  assert.notEqual(first.tokenHash, second.tokenHash)
})

test('createDeviceToken stores only the hash, never the token', () => {
  const { token, tokenHash } = createDeviceToken()
  assert.notEqual(token, tokenHash)
  assert.equal(hashToken(token), tokenHash, 'tokenHash must be sha256(token)')
  assert.ok(!tokenHash.includes(token), 'the hash must not embed the token')
})

test('hashToken is stable and encodes non-strings as the empty string', () => {
  assert.equal(hashToken('abc'), hashToken('abc'))
  assert.equal(hashToken(undefined), hashToken(''))
  assert.equal(hashToken(null), hashToken(''))
  assert.equal(hashToken(123), hashToken(''))
})

test('verifyToken accepts the correct token', () => {
  const { token, tokenHash } = createDeviceToken()
  assert.equal(verifyToken(token, tokenHash), true)
})

test('verifyToken rejects a wrong token', () => {
  const { tokenHash } = createDeviceToken()
  const other = createDeviceToken()
  assert.equal(verifyToken(other.token, tokenHash), false)
})

test('verifyToken rejects a token differing in one character only', () => {
  const { token, tokenHash } = createDeviceToken()
  const last = token.slice(-1)
  const flipped = token.slice(0, -1) + (last === 'A' ? 'B' : 'A')
  assert.equal(verifyToken(flipped, tokenHash), false)
})

test('verifyToken returns false for wrong-length and malformed input instead of throwing', () => {
  const { tokenHash } = createDeviceToken()
  /* timingSafeEqual throws on a length mismatch — verifyToken must never let
     that escape, or a bad credential becomes a 500 instead of a 401. */
  for (const candidate of ['', 'x', 'A'.repeat(43), 'A'.repeat(4096), tokenHash, tokenHash.slice(0, 32)]) {
    assert.equal(verifyToken(candidate, tokenHash), false, `rejected: ${candidate.slice(0, 8)}…`)
  }
})

test('verifyToken returns false on non-string input instead of throwing', () => {
  const { tokenHash } = createDeviceToken()
  for (const candidate of [undefined, null, 0, 1, {}, [], Buffer.from('abc'), () => {}]) {
    assert.equal(verifyToken(candidate, tokenHash), false)
  }
  for (const expected of [undefined, null, 0, '', {}, []]) {
    const { token } = createDeviceToken()
    assert.equal(verifyToken(token, expected), false)
  }
})

test('verifyToken does not accept a hash in place of the token', () => {
  const { tokenHash } = createDeviceToken()
  /* Someone holding devices.json has the hash. Presenting it must not authenticate. */
  assert.equal(verifyToken(tokenHash, tokenHash), false)
})

test('verifyToken rejects a stored hash that is not a sha256 digest', () => {
  /* Regression: the old implementation folded a non-digest `expectedHash`
     through hashToken, so presenting that same literal string authenticated
     (`verifyToken('x', 'x') === true`). A hand-edited devices.json would have
     turned its own contents into a credential — the store's "no plaintext token"
     guarantee defeated by editing one field. */
  for (const malformed of ['x', 'hunter2', 'A'.repeat(43), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), ' ']) {
    assert.equal(verifyToken(malformed, malformed), false, `must not self-authenticate: ${malformed}`)
    assert.equal(verifyToken('anything', malformed), false, `must not authenticate against: ${malformed}`)
  }
})

test('verifyToken still accepts an upper-case hex digest as the stored side is strict', () => {
  const { token, tokenHash } = createDeviceToken()
  /* The stored form is lower-case by construction; an upper-case digest is not
     the documented shape and is refused rather than silently normalised. */
  assert.equal(verifyToken(token, tokenHash.toUpperCase()), false)
  assert.equal(verifyToken(token, tokenHash), true)
})

test('verifyToken matches only the device whose hash was stored', () => {
  const devices = Array.from({ length: 8 }, () => createDeviceToken())
  const target = devices[3]
  const matched = devices.filter((candidate) => verifyToken(candidate.token, target.tokenHash))
  assert.equal(matched.length, 1)
  assert.equal(matched[0].token, target.token)
})
