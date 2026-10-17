/**
 * dsh-remote-control — the device credential.
 *
 * A paired device holds a **signed JWT** in an HttpOnly cookie
 * (`research/jwt-device-credential.md`). The user asked for an OAuth-shaped flow —
 * one-time code, then a token carrying the necessary claims — and the claims are
 * what let the gateway answer "which device is this?" without the token being a
 * meaningless random string.
 *
 * ## Why a JWT AND a server-side revocation set
 *
 * A pure stateless JWT cannot satisfy `prd.md` constraint 5 ("吊销必须即时生效"):
 * once signed, a token is valid until `exp`, and the only way to kill it early is
 * for someone to hold a list. So the JWT carries `sub` and the gateway keeps a
 * `Set` of revoked subjects (`gateway/server.js`). The JWT removes the need to
 * *identify* a device by scanning hashes; the `Set` keeps revocation instant.
 *
 * ## The five rules that carry this module's security
 *
 *   1. **HS256 ONLY, and the header is compared, not trusted.** Reading `alg` out
 *      of the token and obliging is the classic algorithm-confusion hole: `alg:
 *      none` mints a token anyone can edit, and `alg: HS256` on a verifier that
 *      expects RS256 lets the public key be used as the HMAC secret. Here the
 *      header must literally say `HS256`; anything else is refused before a
 *      signature is even computed. See {@link verifyDeviceToken}.
 *   2. **The signature is compared in constant time, over equal-length buffers.**
 *      `timingSafeEqual` throws on a length mismatch, and a throw on a hostile
 *      token would turn a rejected credential into a 500 — a distinguishable
 *      signal. Both sides are sha256-digested first, so the buffers are 32 bytes
 *      by construction, exactly like `sameTokenHash` below.
 *   3. **`iss`, `aud` and `exp` are checked.** A signature only proves the key
 *      signed *something*; it says nothing about which service the token was for.
 *      Without an audience check, a token minted for another purpose by the same
 *      key is a valid device credential.
 *   4. **Parsing never throws on hostile input.** Every entry point accepts
 *      `unknown` and answers `undefined`/`false`. This module is reached from an
 *      unauthenticated request, so "throws on a weird string" is a denial-of-
 *      service and an information leak at once.
 *   5. **No secrets in the payload.** `sub` is the device id, which is an opaque
 *      row key (`dev_…`). The inner `dsh-auth-*` credential, any token hash, a
 *      pairing code and the device's address are all deliberately absent: a JWT
 *      is *not* encrypted, so anything in it is readable by the device and by
 *      anything that later logs the cookie.
 *
 * The module is pure apart from the clock and the random source it *receives*: no
 * filesystem, no key loading (that is `jwt-key.js`), no TTL policy (the caller's).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_CLOCK_SKEW_SECONDS,
  JWT_ISSUER,
  JWT_MAX_LENGTH,
  TOKEN_HASH_PATTERN,
} from './constants.js'

/** A JWS compact segment: unpadded base64url, and nothing else. */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/

/** Bytes of `jti` entropy. Opaque, never a credential; a future single-token revocation key. */
const JTI_BYTES = 16

/** Build an Error carrying a stable `code` (see `.trellis/spec/backend/error-handling.md`). */
function tokenError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * sha256 of a value, hex-encoded.
 *
 * Accepts any string, so it is safe to call on attacker-supplied input. A
 * non-string is hashed as the empty string — every caller that compares must
 * reject non-strings first (see {@link verifyToken}).
 *
 * Retained from the pre-JWT design: `research/jwt-device-credential.md` §3.5 keeps
 * the digest primitives, and they are what makes the constant-time comparison
 * here a pattern rather than a one-off.
 *
 * @param {unknown} value
 * @returns {string} 64 lower-case hex characters.
 */
export function hashToken(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : '', 'utf8').digest('hex')
}

/**
 * Constant-time comparison of two persisted token digests.
 *
 * Both operands are sha256 digests, so they are 32 bytes by construction. That is
 * what keeps the comparison free of a length side channel AND keeps it from
 * throwing on a length mismatch.
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
 * LEGACY. No new device has a `tokenHash` (`store.js` stops writing one), so the
 * gateway no longer calls this; it is kept because the rule it encodes cost a real
 * bug and the primitive is still the right way to compare a digest: the stored
 * side MUST already be a sha256 hex digest (`TOKEN_HASH_PATTERN`). Anything else
 * is refused rather than hashed — if a malformed `tokenHash` were folded through
 * `hashToken` like a token, then presenting that same literal string would
 * authenticate against it (`verifyToken('x', 'x') === true`), and a hand-edited
 * `devices.json` would turn its own contents into a credential.
 *
 * @param {unknown} token Clear token presented by a device.
 * @param {unknown} expectedHash Stored `tokenHash` hex digest.
 * @returns {boolean}
 */
export function verifyToken(token, expectedHash) {
  if (typeof token !== 'string') return false
  return sameTokenHash(hashToken(token), expectedHash)
}

/**
 * Compare two byte strings in constant time, whatever their lengths.
 *
 * `timingSafeEqual` raises on a length mismatch, and a raised error on a hostile
 * credential is a 500 instead of a 401. Digesting both sides makes the buffers 32
 * bytes by construction, which is the same trick {@link sameTokenHash} uses for
 * hex digests — applied here because a JWS signature segment is attacker-shaped
 * and its decoded length is not fixed.
 *
 * @param {Buffer} left
 * @param {Buffer} right
 * @returns {boolean}
 */
function sameBytes(left, right) {
  const digestOfLeft = createHash('sha256').update(left).digest()
  const digestOfRight = createHash('sha256').update(right).digest()
  return timingSafeEqual(digestOfLeft, digestOfRight)
}

/**
 * Decode one base64url segment, or `undefined` when it is not one.
 *
 * `Buffer.from(x, 'base64url')` is lenient — it silently skips characters it does
 * not recognize, so `'!!!'` decodes to an empty buffer rather than failing. A
 * verifier that trusted that would accept mangled inputs as "empty payload" and
 * then reject them for the wrong reason. The shape is checked first, so the
 * decode is only ever asked to handle real base64url.
 *
 * @param {string} segment
 * @returns {Buffer | undefined}
 */
function decodeSegment(segment) {
  if (!BASE64URL_SEGMENT.test(segment)) return undefined
  const decoded = Buffer.from(segment, 'base64url')
  /* A segment of only '-'/'_' style padding characters can still decode to zero
     bytes; nothing usable lives in an empty segment. */
  return decoded.length === 0 ? undefined : decoded
}

/**
 * Encode a JSON value as an unpadded base64url JWS segment.
 *
 * @param {unknown} value
 * @returns {string}
 */
function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/**
 * Parse a JSON object out of a decoded segment, or `undefined`.
 *
 * A JSON array or scalar is not a JOSE object and is refused: `[]` would otherwise
 * sail through `typeof === 'object'` checks and every claim lookup would read
 * `undefined` off it.
 *
 * @param {Buffer} bytes
 * @returns {Record<string, unknown> | undefined}
 */
function parseJsonObject(bytes) {
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed
}

/**
 * Whether a value is a usable signing key.
 *
 * HS256 needs a real secret. An empty Buffer, a string, or `undefined` would all
 * "work" with `createHmac` (a string is coerced), and every one of them is a
 * signing key an attacker either knows or can guess, so they are refused loudly
 * rather than accepted quietly. This is a startup-time fault, not a request-time
 * one — see `jwt-key.js`.
 *
 * @param {unknown} key
 * @returns {boolean}
 */
export function isSigningKey(key) {
  return Buffer.isBuffer(key) && key.length >= 16
}

/**
 * Sign a device credential.
 *
 * The claim set is fixed here and nowhere else (`research/jwt-device-credential.md`
 * §3.2): `iss`, `sub`, `aud`, `iat`, `exp`, `jti`, `name`. Nothing else may be
 * added — in particular no inner credential, no token hash, no pairing code and no
 * address. A JWT is readable by anyone holding it, so the payload is a public
 * document.
 *
 * Throws only for a *programming* fault (a bad key, a missing subject): this runs
 * immediately after a successful pairing redemption, and `pairing-route.js` turns
 * a throw into a 500 for that one request rather than handing out a credential
 * that cannot be verified.
 *
 * @param {object} claims
 * @param {string} claims.sub Device id (`dev_…`) — the revocation key.
 * @param {string} [claims.name] Device label for display. NOT trusted on verify.
 * @param {number} [claims.iat] Issued-at, epoch seconds. Defaults to now.
 * @param {number} [claims.exp] Expiry, epoch seconds. Defaults to `iat + ttlSeconds`.
 * @param {number} [claims.ttlSeconds] Lifetime in seconds, when `exp` is omitted.
 * @param {string} [claims.jti] Token id. Defaults to fresh random bytes.
 * @param {Buffer} key 32-byte HS256 secret from `jwt-key.js`.
 * @param {object} [options]
 * @param {() => number} [options.now] Clock in epoch milliseconds; injectable for tests.
 * @param {(size: number) => Buffer} [options.random] Random source for `jti`; injectable for tests.
 * @returns {string} A JWS compact serialization (`header.payload.signature`).
 */
export function signDeviceToken(claims, key, options = {}) {
  if (!isSigningKey(key)) {
    throw tokenError('token/key', 'the JWT signing key is missing or too short')
  }
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw tokenError('token/claims', 'the device token claims must be an object')
  }
  const sub = claims.sub
  if (typeof sub !== 'string' || sub === '') {
    throw tokenError('token/claims', 'the device token needs a subject')
  }

  const now = typeof options.now === 'function' ? options.now : Date.now
  const iat = Number.isInteger(claims.iat) ? claims.iat : Math.floor(now() / 1000)
  const exp = Number.isInteger(claims.exp)
    ? claims.exp
    : (Number.isFinite(claims.ttlSeconds) && claims.ttlSeconds > 0
      ? iat + Math.floor(claims.ttlSeconds)
      : undefined)
  if (!Number.isInteger(exp)) {
    throw tokenError('token/claims', 'the device token needs an expiry')
  }

  let jti = typeof claims.jti === 'string' && claims.jti !== '' ? claims.jti : ''
  if (jti === '') {
    const random = typeof options.random === 'function' ? options.random : randomBytes
    const bytes = random(JTI_BYTES)
    /* An injected source that returns a short buffer would otherwise produce a
       degenerate id in silence (`quality-guidelines.md` §5). */
    if (!(bytes instanceof Uint8Array) || bytes.length < JTI_BYTES) {
      throw tokenError('token/entropy', 'the random source returned too few bytes')
    }
    jti = Buffer.from(bytes).toString('base64url')
  }

  /* Field order is the documented order, and the object is rebuilt rather than
     spread from `claims`: an unknown key handed in by a caller would otherwise
     land in a document that anyone holding the cookie can read. */
  const payload = {
    iss: JWT_ISSUER,
    sub,
    aud: JWT_AUDIENCE,
    iat,
    exp,
    jti,
    name: typeof claims.name === 'string' ? claims.name : '',
  }

  const header = { alg: JWT_ALGORITHM, typ: 'JWT' }
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`
  const signature = createHmac('sha256', key).update(signingInput, 'ascii').digest('base64url')
  return `${signingInput}.${signature}`
}

/**
 * Verify a device credential.
 *
 * Returns the claims when the token is authentic, current and addressed to this
 * service; `undefined` for absolutely anything else. It never throws, whatever it
 * is handed — this is reachable from an unauthenticated request.
 *
 * The checks run in the order that costs least for a hostile input and proves most
 * for a hostile one: shape, then algorithm, then signature, then claims. The
 * algorithm check comes BEFORE the signature on purpose — with `alg: none` there
 * is nothing to verify, and a verifier that computed an HMAC anyway would be
 * verifying a token whose own header said not to.
 *
 * @param {unknown} jwt The cookie value, straight off a request. Any shape at all.
 * @param {unknown} key 32-byte HS256 secret.
 * @param {object} [options]
 * @param {() => number} [options.now] Clock in epoch milliseconds; injectable for tests.
 * @returns {{
 *   iss: string, sub: string, aud: string, iat: number | null,
 *   exp: number, jti: string, name: string,
 * } | undefined}
 */
export function verifyDeviceToken(jwt, key, options = {}) {
  if (typeof jwt !== 'string' || jwt === '') return undefined
  /* Bound the work before touching it: the claim set is under 300 bytes, so a
     multi-kilobyte "token" is an attempt to make this function expensive rather
     than a credential. */
  if (jwt.length > JWT_MAX_LENGTH) return undefined
  if (!isSigningKey(key)) return undefined

  const segments = jwt.split('.')
  /* A JWS compact serialization has exactly three segments. `..`, `a.b`, and a
     bare `header.payload.` all fall out here. */
  if (segments.length !== 3) return undefined
  const [headerSegment, payloadSegment, signatureSegment] = segments

  const headerBytes = decodeSegment(headerSegment)
  const payloadBytes = decodeSegment(payloadSegment)
  const signatureBytes = decodeSegment(signatureSegment)
  if (headerBytes === undefined || payloadBytes === undefined || signatureBytes === undefined) {
    return undefined
  }

  const header = parseJsonObject(headerBytes)
  if (header === undefined) return undefined
  /* Rule 1. Exact equality, not a set lookup: `HS256` is the only value this
     verifier understands, so `none`, `HS512`, `RS256` and `hs256` are all refused
     here — including an `RS256` token whose signature we could never check. */
  if (header.alg !== JWT_ALGORITHM) return undefined

  const expected = createHmac('sha256', key).update(`${headerSegment}.${payloadSegment}`, 'ascii').digest()
  if (!sameBytes(expected, signatureBytes)) return undefined

  const payload = parseJsonObject(payloadBytes)
  if (payload === undefined) return undefined

  /* Rule 3, and only after the signature: an unauthenticated caller must not be
     able to probe these checks by watching which one it failed. */
  if (payload.iss !== JWT_ISSUER) return undefined
  if (payload.aud !== JWT_AUDIENCE) return undefined

  const sub = payload.sub
  if (typeof sub !== 'string' || sub === '') return undefined

  const now = typeof options.now === 'function' ? options.now : Date.now
  const nowSeconds = Math.floor(now() / 1000)

  /* `exp` is REQUIRED. A token without one never expires, so a single leaked
     cookie would be a permanent credential — the one property a bearer token must
     not have. */
  if (!Number.isFinite(payload.exp)) return undefined
  if (nowSeconds > payload.exp + JWT_CLOCK_SKEW_SECONDS) return undefined

  /* `nbf` is optional (this package never mints one) but honoured when present, or
     a token minted for a future window would be accepted early. */
  if (payload.nbf !== undefined) {
    if (!Number.isFinite(payload.nbf)) return undefined
    if (nowSeconds + JWT_CLOCK_SKEW_SECONDS < payload.nbf) return undefined
  }

  return {
    iss: JWT_ISSUER,
    sub,
    aud: JWT_AUDIENCE,
    iat: Number.isFinite(payload.iat) ? payload.iat : null,
    exp: payload.exp,
    jti: typeof payload.jti === 'string' ? payload.jti : '',
    /* Carried for nothing but a log line and a debug session. The gateway reads
       the device's name from the store (`auth.js`), because a JWT is a snapshot:
       a device renamed after pairing would otherwise keep announcing its old
       name until it re-paired. */
    name: typeof payload.name === 'string' ? payload.name : '',
  }
}
