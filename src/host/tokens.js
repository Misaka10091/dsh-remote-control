/**
 * dsh-remote-control — device tokens.
 *
 * A device token is the bearer credential a paired phone/PC sends in its cookie.
 * It is minted once, handed to the device, and never written down in clear:
 * `devices.json` stores only `sha256(token)` (`design.md` §5, PRD D4).
 *
 * Three rules carry the security of this module:
 *
 *   1. `randomBytes(32)` — a CSPRNG, never `Math.random`.
 *   2. Only the hash is persisted. `verifyToken` re-hashes the presented token,
 *      so the stored form stays useless to anyone who reads the file.
 *   3. Both operands handed to `crypto.timingSafeEqual` are sha256 digests, so
 *      they are 32 bytes by construction. That is what keeps the comparison free
 *      of a length side channel AND keeps it from throwing: `timingSafeEqual`
 *      raises on a length mismatch, and a throw on the wrong token would turn a
 *      rejected login into a 500 (and a distinguishable signal).
 *
 * The module is pure: no filesystem, no clock. `store.js` decides when to write.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { DEVICE_TOKEN_BYTES, TOKEN_HASH_PATTERN } from './constants.js'

/** Token encoding is unpadded base64url — cookie-safe, and no `=` to escape in a header. */
function encodeToken(bytes) {
  return bytes.toString('base64url')
}

/**
 * sha256 of a value, hex-encoded.
 *
 * Accepts any string, so it is safe to call on attacker-supplied input. A
 * non-string is hashed as the empty string — every caller that compares must
 * reject non-strings first (see {@link verifyToken}).
 *
 * @param {unknown} value
 * @returns {string} 64 lower-case hex characters.
 */
export function hashToken(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : '', 'utf8').digest('hex')
}

/**
 * Mint a new device token.
 *
 * The clear token is returned ONCE, to be delivered to the device in a
 * `Set-Cookie`. Only `tokenHash` may be persisted; nothing in this package logs
 * the clear value.
 *
 * @returns {{ token: string, tokenHash: string }}
 */
export function createDeviceToken() {
  const token = encodeToken(randomBytes(DEVICE_TOKEN_BYTES))
  return { token, tokenHash: hashToken(token) }
}

/**
 * Constant-time comparison of two persisted token digests.
 *
 * Used by the device lookup, which scans the table comparing the presented
 * token's digest against each stored one. Comparing the hex strings with `===`
 * would leave `tokens.js` constant-time and the actual lookup early-exiting,
 * which is the comparison an attacker can time. Both sides must already be
 * 64-hex (the store enforces that on the stored side, `hashToken` on the
 * presented side), so the buffers are 32 bytes and `timingSafeEqual` cannot
 * throw.
 *
 * @param {unknown} left 64-hex sha256 digest.
 * @param {unknown} right 64-hex sha256 digest.
 * @returns {boolean}
 */
export function sameTokenHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (!TOKEN_HASH_PATTERN.test(left) || !TOKEN_HASH_PATTERN.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/**
 * Constant-time check of a presented token against a stored hash.
 *
 * Returns a boolean and never throws — a wrong, empty, over-long or non-string
 * token is simply `false`. The comparison of the two digests never short-circuits,
 * so the time taken does not reveal how much of the token was right. (The format
 * check on the stored side does return early, which is safe: it inspects the
 * locally-stored hash, not the presented secret.)
 *
 * The stored side MUST already be a sha256 hex digest (`TOKEN_HASH_PATTERN`).
 * Anything else is refused rather than hashed: if a malformed `tokenHash` were
 * folded through `hashToken` like a token, then presenting that same literal
 * string would authenticate against it (`verifyToken('x', 'x') === true`). A
 * hand-edited or corrupted `devices.json` would then turn its own contents into
 * a credential. Rejecting outright keeps the stored form the only thing that
 * can match, and it costs nothing in the honest path.
 *
 * @param {unknown} token Clear token presented by a device.
 * @param {unknown} expectedHash Stored `tokenHash` hex digest.
 * @returns {boolean}
 */
export function verifyToken(token, expectedHash) {
  if (typeof token !== 'string') return false
  return sameTokenHash(hashToken(token), expectedHash)
}
