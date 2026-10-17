/**
 * The JWT signing key: generation, persistence, mode, and the two failure modes
 * that must be LOUD.
 *
 * `research/jwt-device-credential.md` §3.3 is the whole design: 32 random bytes,
 * `~/.dsh/remote-control/jwt-key`, 0600, generated on first use. The two properties
 * that matter are both about what happens when the key is NOT usable:
 *
 *   - **it must not silently become an in-memory key.** That would work perfectly
 *     until the next restart and then invalidate every paired device — the phone
 *     still holds a well-formed cookie, the gateway still verifies signatures, and
 *     every one of them fails. It is the failure that looks like a bug in the auth
 *     code and happens on every upgrade.
 *   - **it must not regenerate a corrupt file.** Damage or an edit is not a reason
 *     to invalidate every device and hand the decision to whoever damaged the file.
 *
 * The persistence proof is the one a mock cannot give: two independent instances
 * reading the same directory must verify each other's tokens. That is what proves
 * the key came off disk rather than out of a process's memory.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { JWT_KEY_BYTES, JWT_KEY_FILE_MODE, JWT_KEY_FILE_NAME } from '../src/host/constants.js'
import { jwtKeyPath, loadOrCreateJwtKey } from '../src/host/jwt-key.js'
import { signDeviceToken, verifyDeviceToken } from '../src/host/tokens.js'
import { cleanupDir, makeTempDir } from './helpers.mjs'

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

/* ------------------------------------------------------------------ *
 * Generation and persistence
 * ------------------------------------------------------------------ */

test('the key is generated on first use, is 32 bytes, and is persisted', () => {
  const dir = makeTempDir()
  try {
    const keyPath = jwtKeyPath(dir)
    assert.equal(existsSync(keyPath), false, 'nothing is written before the first call')

    const key = loadOrCreateJwtKey({ baseDir: dir })

    assert.ok(Buffer.isBuffer(key))
    assert.equal(key.length, JWT_KEY_BYTES)
    assert.ok(existsSync(keyPath), 'the key is on disk, not only in memory')
    assert.deepEqual(readFileSync(keyPath), key, 'the file IS the key, byte for byte')
  } finally {
    cleanupDir(dir)
  }
})

test('a reload reads the SAME key rather than minting a new one', () => {
  /* The property every paired device depends on. An in-memory key would pass the
     test above and fail this one, which is exactly why it is a separate test. */
  const dir = makeTempDir()
  try {
    const first = loadOrCreateJwtKey({ baseDir: dir })
    const second = loadOrCreateJwtKey({ baseDir: dir })
    assert.deepEqual(second, first, 'a second load must return the stored key')
    assert.equal(existsSync(jwtKeyPath(dir)), true)
  } finally {
    cleanupDir(dir)
  }
})

test('two independent instances reading the same key verify each other’s tokens', () => {
  /* The end-to-end proof that persistence, not memory, is the source of the key.
   *
   * Instance A signs a token; instance B — a separate `loadOrCreateJwtKey` call
   * with no shared state whatsoever, standing in for "the gateway restarted" — must
   * verify it. If either instance had kept a key it minted instead of the one on
   * disk, this test would fail with a valid-looking but unverifiable token. */
  const dir = makeTempDir()
  try {
    const instanceA = loadOrCreateJwtKey({ baseDir: dir })
    const instanceB = loadOrCreateJwtKey({ baseDir: dir })
    assert.notEqual(instanceA, instanceB, 'two distinct Buffer objects, not one shared reference')
    assert.deepEqual(instanceA, instanceB, 'but the same bytes')

    const jwt = signDeviceToken({ sub: 'dev_1', ttlSeconds: 3600 }, instanceA)
    const verified = verifyDeviceToken(jwt, instanceB)
    assert.ok(verified !== undefined, 'the second instance accepts the first instance’s token')
    assert.equal(verified.sub, 'dev_1')

    /* And the reverse direction, so the test cannot pass on a one-way coincidence. */
    const back = signDeviceToken({ sub: 'dev_2', ttlSeconds: 3600 }, instanceB)
    assert.equal(verifyDeviceToken(back, instanceA).sub, 'dev_2')
  } finally {
    cleanupDir(dir)
  }
})

test('a token signed in ANOTHER PROCESS verifies here (real persistence, not in-process state)', () => {
  /* The strongest form of the same claim, and the one a mock cannot fake: a genuine
     child process loads the key, signs a token and prints it; this process — which
     has never seen that process's memory — verifies it against its own load of the
     same file. An in-memory fallback, or a key cached per module instance, fails
     here and nowhere else.
   *
   * `stdio: 'inherit'` is deliberately avoided: the child's stdout is the result,
   * so it is piped and read. */
  const dir = makeTempDir()
  try {
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      [
        "import { loadOrCreateJwtKey } from './src/host/jwt-key.js'",
        "import { signDeviceToken } from './src/host/tokens.js'",
        `const key = loadOrCreateJwtKey({ baseDir: ${JSON.stringify(dir)} })`,
        "process.stdout.write(signDeviceToken({ sub: 'dev_child', ttlSeconds: 3600 }, key))",
      ].join('; '),
    ], { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') })

    assert.equal(child.status, 0, child.stderr)
    const jwt = child.stdout.trim()
    assert.equal(jwt.split('.').length, 3, 'the child produced a JWS compact serialization')

    const key = loadOrCreateJwtKey({ baseDir: dir })
    const verified = verifyDeviceToken(jwt, key)
    assert.ok(verified !== undefined, 'this process verifies a token signed in another one')
    assert.equal(verified.sub, 'dev_child', 'and it carries the child’s claim')
  } finally {
    cleanupDir(dir)
  }
})

test('a second process that loses the creation race adopts the winner’s key', () => {
  /* Two hosts starting at once (a reload overlapping an active process) is a real
     case. Both may find no key; whichever publishes first wins the name, and the
     loser must adopt it rather than keep the key it minted — otherwise two live
     signing keys exist and half the device table is rejected.
   *
   * Simulated by pre-creating the file between two loads: the second call finds it
   * and must return it, whatever it would have generated. */
  const dir = makeTempDir()
  try {
    const winner = Buffer.alloc(JWT_KEY_BYTES, 0x42)
    mkdirSync(dir, { recursive: true })
    writeFileSync(jwtKeyPath(dir), winner)

    const loser = loadOrCreateJwtKey({ baseDir: dir, random: () => Buffer.alloc(JWT_KEY_BYTES, 0x99) })
    assert.deepEqual(loser, winner, 'the key on disk wins over the one this call drew')
    assert.deepEqual(readFileSync(jwtKeyPath(dir)), winner, 'and the file was not clobbered')
  } finally {
    cleanupDir(dir)
  }
})

test('a fresh key is different for every directory', () => {
  const first = makeTempDir()
  const second = makeTempDir()
  try {
    const a = loadOrCreateJwtKey({ baseDir: first })
    const b = loadOrCreateJwtKey({ baseDir: second })
    assert.notDeepEqual(a, b, 'two runtimes must not share a signing key')
  } finally {
    cleanupDir(first)
    cleanupDir(second)
  }
})

test('the key file is created 0600 on POSIX and the call never throws on Windows', () => {
  const dir = makeTempDir()
  try {
    loadOrCreateJwtKey({ baseDir: dir })
    if (process.platform === 'win32') {
      /* The Windows permission model has no 0600; `chmod` there only flips the
         read-only bit. The contract is "must not throw", and the file must still be
         usable — asserted through the outcome. */
      assert.ok(existsSync(jwtKeyPath(dir)))
      assert.doesNotThrow(() => loadOrCreateJwtKey({ baseDir: dir }))
      return
    }
    assert.equal(statSync(jwtKeyPath(dir)).mode & 0o777, JWT_KEY_FILE_MODE)
  } finally {
    cleanupDir(dir)
  }
})

test('the key file is named jwt-key and lives beside devices.json', () => {
  const dir = makeTempDir()
  try {
    loadOrCreateJwtKey({ baseDir: dir })
    assert.equal(path.basename(jwtKeyPath(dir)), JWT_KEY_FILE_NAME)
    assert.equal(path.dirname(jwtKeyPath(dir)), dir)
  } finally {
    cleanupDir(dir)
  }
})

test('a write leaves no temp files behind', () => {
  const dir = makeTempDir()
  try {
    loadOrCreateJwtKey({ baseDir: dir })
    const leftovers = readdirSync(dir).filter((entry) => entry.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'the temp file used for the atomic create is gone')
    assert.deepEqual(readdirSync(dir), [JWT_KEY_FILE_NAME])
  } finally {
    cleanupDir(dir)
  }
})

test('the runtime directory is created recursively', () => {
  const dir = makeTempDir()
  try {
    const baseDir = path.join(dir, 'a', 'b', 'c')
    const key = loadOrCreateJwtKey({ baseDir })
    assert.equal(key.length, JWT_KEY_BYTES)
    assert.ok(existsSync(path.join(baseDir, JWT_KEY_FILE_NAME)))
  } finally {
    cleanupDir(dir)
  }
})

/* ------------------------------------------------------------------ *
 * Loud failure — the two cases that must refuse to start
 * ------------------------------------------------------------------ */

test('a corrupt key file refuses instead of regenerating', () => {
  /* Regenerating would (a) silently invalidate every paired device and (b) hand the
     decision to whoever damaged the file. Both are worse than refusing to start. */
  const dir = makeTempDir()
  try {
    const keyPath = jwtKeyPath(dir)
    mkdirSync(dir, { recursive: true })

    for (const corrupt of [
      Buffer.alloc(0),
      Buffer.alloc(1, 0x01),
      Buffer.alloc(16, 0x01),
      Buffer.alloc(31, 0x01),
      Buffer.alloc(33, 0x01),
      Buffer.from('this is not a key, it is a sentence about keys'),
    ]) {
      writeFileSync(keyPath, corrupt)
      assertCode(() => loadOrCreateJwtKey({ baseDir: dir }), 'jwt-key/corrupt')
      assert.deepEqual(readFileSync(keyPath), corrupt, 'the damaged file is left alone for inspection')
    }
  } finally {
    cleanupDir(dir)
  }
})

test('an unreadable key path is a loud failure, not a silent fallback', () => {
  /* A directory in the key's place: reading it raises EISDIR/EACCES, neither of
     which may be read as ENOENT ("first run"). Treating it as missing would mint a
     second key while one exists, which is the same class of bug. */
  const dir = makeTempDir()
  try {
    mkdirSync(jwtKeyPath(dir), { recursive: true })
    assertCode(() => loadOrCreateJwtKey({ baseDir: dir }), 'jwt-key/unreadable')
  } finally {
    cleanupDir(dir)
  }
})

test('a base directory that cannot be created is a loud failure', () => {
  const dir = makeTempDir()
  try {
    const blocker = path.join(dir, 'blocker')
    mkdirSync(blocker)
    writeFileSync(path.join(blocker, 'file'), '')
    /* A path whose parent is a regular file cannot become a directory. */
    assertCode(
      () => loadOrCreateJwtKey({ baseDir: path.join(blocker, 'file', 'deeper') }),
      'jwt-key/write-failed',
    )
  } finally {
    cleanupDir(dir)
  }
})

test('a missing base directory argument is refused', () => {
  for (const argument of [undefined, null, {}, { baseDir: '' }, { baseDir: 42 }]) {
    assertCode(() => loadOrCreateJwtKey(argument), 'jwt-key/invalid')
  }
})

test('a short buffer from an injected random source fails loudly', () => {
  /* `quality-guidelines.md` §5: a short buffer would otherwise persist a weak key
     without a word — and a 1-byte HS256 secret is a key anyone can brute-force. */
  const dir = makeTempDir()
  try {
    assertCode(
      () => loadOrCreateJwtKey({ baseDir: dir, random: (size) => Buffer.alloc(size - 1) }),
      'jwt-key/entropy',
    )
    assert.equal(existsSync(jwtKeyPath(dir)), false, 'nothing was written for the refused key')
  } finally {
    cleanupDir(dir)
  }
})

test('the key never appears in an error message', () => {
  /* An error message reaches a log line, and a log line is the one place a secret
     must never be. The codes are the diagnosable part; the message says what kind of
     refusal happened and nothing more. */
  const dir = makeTempDir()
  try {
    const key = loadOrCreateJwtKey({ baseDir: dir })
    writeFileSync(jwtKeyPath(dir), Buffer.alloc(17, 0x7f))
    let thrown
    try {
      loadOrCreateJwtKey({ baseDir: dir })
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof Error)
    assert.ok(!thrown.message.includes(key.toString('hex')), 'not the key')
    assert.ok(!thrown.message.includes(key.toString('base64')), 'in any encoding')
    assert.ok(!thrown.message.includes(dir), 'and not the path either')
  } finally {
    cleanupDir(dir)
  }
})
