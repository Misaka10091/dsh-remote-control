/**
 * Shared test helpers.
 *
 * Every test binds its store to a directory under the OS temp dir, so a test run
 * can never read or write the real `~/.dsh/remote-control`. The helper also pins
 * the clock, so "expired" is asserted without sleeping.
 *
 * The credential helpers are here because the device credential is a signed JWT
 * (`research/jwt-device-credential.md`): every suite that once minted an opaque
 * token now needs a key to sign with, and duplicating that in eleven files would
 * mean eleven places to change when the claim set does.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createPairingStore } from '../src/host/pairing.js'
import { createStore } from '../src/host/store.js'
import { signDeviceToken } from '../src/host/tokens.js'

/** A temp directory that the caller owns; pass to {@link cleanupDir} when done. */
export function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-remote-control-test-'))
}

/** Remove a temp directory and everything in it. Never throws. */
export function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* the OS reclaims temp dirs; a failure here must not fail a test */
  }
}

/**
 * The signing key every in-process test uses.
 *
 * Injected into `startGateway` rather than read from disk: a test that signs its
 * own tokens must be independent of the key file's lifecycle, and `jwt-key.test.mjs`
 * is the suite that owns that lifecycle. 32 bytes of a fixed value — the point is
 * that it is shared, not that it is secret.
 */
export const TEST_JWT_KEY = Buffer.alloc(32, 0x5a)

/**
 * A far-future `exp`, so a token is valid under BOTH a frozen test clock (2026) and
 * the real one.
 *
 * The suites freeze `now` at 2026-10-17 in some places and use `Date.now()` in
 * others, and a token signed against one clock would be expired for the other.
 * Pinning `exp` to 2100 makes the credential's validity orthogonal to which clock
 * a given test uses; the expiry tests sign their own token with a deliberate `exp`
 * and are the only place the value matters.
 *
 * Internal on purpose: callers that want a specific `exp` should say so, because
 * "valid forever" is exactly the property a test should not accidentally rely on.
 */
const FAR_FUTURE_EXP = Math.floor(Date.UTC(2100, 0, 1) / 1000)

/**
 * Sign a device credential for a device id.
 *
 * @param {string} deviceId The `sub`; must match a stored device for `authorize` to allow it.
 * @param {object} [overrides] Claim overrides — `exp`, `iat`, `name`, `jti`, `key`.
 * @returns {string} A JWS compact serialization.
 */
export function deviceJwt(deviceId, overrides = {}) {
  return signDeviceToken(
    {
      sub: deviceId,
      name: overrides.name,
      iat: Number.isInteger(overrides.iat) ? overrides.iat : 0,
      exp: Number.isInteger(overrides.exp) ? overrides.exp : FAR_FUTURE_EXP,
      jti: overrides.jti,
    },
    overrides.key ?? TEST_JWT_KEY,
  )
}

/**
 * Add a device to a store and return the JWT that authenticates it.
 *
 * The replacement for the old "mint a token, store its hash" pair. Note what is no
 * longer stored: there is no hash, because the token is not the thing on disk —
 * the row is keyed by id, and the id is the token's `sub`.
 *
 * @param {ReturnType<typeof createStore>} store
 * @param {{ id: string, name?: string, ua?: string }} device
 * @param {object} [overrides] Claim overrides, forwarded to {@link deviceJwt}.
 * @returns {{ record: object, token: string }}
 */
export function pairDevice(store, device, overrides = {}) {
  const record = store.addDevice({
    id: device.id,
    name: device.name ?? 'phone',
    ua: device.ua,
  })
  return { record, token: deviceJwt(record.id, { name: device.name, ...overrides }) }
}

/**
 * A store bound to `dir` with a frozen clock.
 *
 * @param {string} dir
 * @param {number} [startAt] Epoch milliseconds; defaults to a fixed instant.
 */
export function makeStore(dir, startAt = Date.UTC(2026, 9, 17, 3, 4, 43)) {
  const clock = { now: startAt }
  const store = createStore({ baseDir: dir, now: () => clock.now })
  return { store, clock }
}

/**
 * A pairing store with a frozen clock and a deterministic code.
 *
 * `random` fills every byte with a fixed value, so BOTH the pairing id and the
 * code are determined (that is the point of taking `random` as a parameter): the
 * base32 alphabet index is `byte % 32`, i.e. a constant character. Tests that
 * care about the *shape* of the code read it off the returned pair; tests that
 * care about *matching* just use the returned code.
 *
 * Because every draw is the same constant, two pairs created by one store share
 * a `pairId` and the second `entries.set` overwrites the first — tests that need
 * two coexisting pairs must advance the byte between calls, which
 * {@link makePairing.advance} exists for.
 *
 * @param {number} [startAt]
 * @param {number} [byte] Raw byte fed to the id and code generators.
 */
export function makePairing(startAt = Date.UTC(2026, 9, 17, 3, 4, 43), byte = 0) {
  const clock = { now: startAt }
  const random = { byte }
  const pairing = createPairingStore({
    now: () => clock.now,
    random: (size) => Buffer.alloc(size, random.byte),
  })
  /* Move to a different constant so the next pair gets a distinct id. */
  clock.advance = (byByte = 1) => { random.byte += byByte }
  return { pairing, clock, random }
}
