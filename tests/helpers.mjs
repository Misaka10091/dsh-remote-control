/**
 * Shared test helpers.
 *
 * Every test binds its store to a directory under the OS temp dir, so a test run
 * can never read or write the real `~/.dsh/remote-control`. The helper also pins
 * the clock, so "expired" is asserted without sleeping.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createPairingStore } from '../src/host/pairing.js'
import { createStore } from '../src/host/store.js'

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
