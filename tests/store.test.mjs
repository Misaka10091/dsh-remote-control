/**
 * Device store: document shape, atomic writes, corrupt-file handling, permissions.
 *
 * Every test binds the store to its own temp directory — nothing here may touch
 * the real `~/.dsh`. The atomic-write and corruption cases are the ones that
 * matter: a half-written `devices.json` would invalidate every paired device at
 * once, and a corrupt file silently treated as empty is a security-relevant lie.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, statSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { DEVICES_FILE_MODE, DEVICES_FILE_NAME, DEVICES_VERSION, DEFAULT_GATEWAY_PORT } from '../src/host/constants.js'
import { createStore, defaultBaseDir } from '../src/host/store.js'
import { createDeviceToken } from '../src/host/tokens.js'
import { makeStore, makeTempDir, cleanupDir } from './helpers.mjs'

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

test('a missing devices.json reads as an empty document with default settings', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const document = store.read()

    assert.equal(document.version, DEVICES_VERSION)
    assert.deepEqual(document.devices, [])
    assert.equal(document.settings.enabled, false, 'remote access is OFF by default (PRD D1)')
    assert.equal(document.settings.port, DEFAULT_GATEWAY_PORT)
  } finally {
    cleanupDir(dir)
  }
})

test('reading a missing file does not create it', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.read()
    assert.equal(existsSync(store.devicesPath), false)
  } finally {
    cleanupDir(dir)
  }
})

test('addDevice persists the documented device shape, in field order, including capabilities', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const { tokenHash } = createDeviceToken()

    const record = store.addDevice({ id: 'dev_1', name: 'iPhone · Safari', tokenHash, ua: 'UA/1' })
    const onDisk = JSON.parse(readFileSync(store.devicesPath, 'utf8'))
    const [stored] = onDisk.devices

    assert.deepEqual(Object.keys(stored), [
      'id', 'name', 'tokenHash', 'ua', 'createdAt', 'lastSeenAt', 'revokedAt', 'capabilities',
    ])
    assert.equal(stored.id, 'dev_1')
    assert.equal(stored.name, 'iPhone · Safari')
    assert.equal(stored.tokenHash, tokenHash)
    assert.equal(stored.ua, 'UA/1')
    assert.equal(stored.createdAt, '2026-10-17T03:04:43.000Z')
    assert.equal(stored.lastSeenAt, '2026-10-17T03:04:43.000Z')
    assert.equal(stored.revokedAt, null)
    assert.equal(stored.capabilities, null, 'capabilities is reserved and unused (PRD D6)')
    assert.deepEqual(Object.keys(onDisk), ['version', 'devices', 'settings'])
    assert.deepEqual(Object.keys(onDisk.settings), ['enabled', 'port'])
    assert.equal(record.id, 'dev_1')
  } finally {
    cleanupDir(dir)
  }
})

test('the clear device token never reaches the store', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const { token, tokenHash } = createDeviceToken()
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash })

    const raw = readFileSync(store.devicesPath, 'utf8')
    assert.ok(!raw.includes(token), 'the persisted document must not contain the clear token')
    assert.ok(raw.includes(tokenHash), 'the hash is what is persisted')
  } finally {
    cleanupDir(dir)
  }
})

test('a write leaves no temp files behind', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: createDeviceToken().tokenHash })

    const leftovers = readdirSync(dir).filter((entry) => entry.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
    assert.deepEqual(readdirSync(dir), [DEVICES_FILE_NAME])
  } finally {
    cleanupDir(dir)
  }
})

test('a completed atomic write is readable again and survives a reload', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const { tokenHash } = createDeviceToken()
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash })

    /* A second store over the same directory sees the same device — the file,
       not in-memory state, is the source of truth. */
    const reopened = createStore({ baseDir: dir })
    const devices = reopened.listDevices()
    assert.equal(devices.length, 1)
    assert.equal(devices[0].tokenHash, tokenHash)
  } finally {
    cleanupDir(dir)
  }
})

test('the document is written with a newline at EOF and valid JSON', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: createDeviceToken().tokenHash })

    const raw = readFileSync(store.devicesPath, 'utf8')
    assert.ok(raw.endsWith('\n'))
    /* Parse and assert CONTENT. `assert.ok(() => JSON.parse(raw))` would be a
       tautology: a function object is always truthy, so it never parses. */
    const parsed = JSON.parse(raw)
    assert.equal(parsed.devices.length, 1)
    assert.equal(parsed.devices[0].id, 'dev_1')
    assert.equal(parsed.version, DEVICES_VERSION)
  } finally {
    cleanupDir(dir)
  }
})

test('devices.json is created with mode 0600', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: createDeviceToken().tokenHash })

    if (process.platform === 'win32') {
      /* The Windows permission model has no 0600; the call must be a no-op rather
         than an error. Assert the file is readable, i.e. the no-op did not break it. */
      assert.ok(existsSync(store.devicesPath))
      assert.ok(readFileSync(store.devicesPath, 'utf8').length > 0)
      return
    }
    assert.equal(statSync(store.devicesPath).mode & 0o777, DEVICES_FILE_MODE)
  } finally {
    cleanupDir(dir)
  }
})

test('applying the file mode never makes a successful write fail', () => {
  /* The guarded-chmod contract: `applyFileMode` runs after every rename, and on
     a filesystem without POSIX modes it must be a no-op rather than an error.
     Asserted through the observable outcome — repeated writes keep working. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    for (let index = 0; index < 5; index += 1) {
      assert.doesNotThrow(() => store.addDevice({
        id: `dev_${index}`,
        name: `phone ${index}`,
        tokenHash: createDeviceToken().tokenHash,
      }))
    }
    assert.equal(store.listDevices().length, 5)
    assert.equal(JSON.parse(readFileSync(store.devicesPath, 'utf8')).devices.length, 5)
  } finally {
    cleanupDir(dir)
  }
})

test('an invalid JSON document raises store/corrupt instead of reading as empty', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    writeFileSync(store.devicesPath, '{ not json')

    assertCode(() => store.read(), 'store/corrupt')
    assertCode(() => store.listDevices(), 'store/corrupt')
  } finally {
    cleanupDir(dir)
  }
})

test('a structurally wrong document raises store/corrupt', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)

    for (const broken of ['null', '[]', '"text"', '{}', '{"version":1}', '{"version":1,"devices":{}}']) {
      writeFileSync(store.devicesPath, broken)
      assertCode(() => store.read(), 'store/corrupt')
    }
  } finally {
    cleanupDir(dir)
  }
})

test('a device record missing id or tokenHash raises store/corrupt', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)

    writeFileSync(store.devicesPath, JSON.stringify({ version: 1, devices: [{ tokenHash: 'a'.repeat(64) }] }))
    assertCode(() => store.read(), 'store/corrupt')

    writeFileSync(store.devicesPath, JSON.stringify({ version: 1, devices: [{ id: 'dev_1' }] }))
    assertCode(() => store.read(), 'store/corrupt')

    writeFileSync(store.devicesPath, JSON.stringify({ version: 1, devices: ['nope'] }))
    assertCode(() => store.read(), 'store/corrupt')
  } finally {
    cleanupDir(dir)
  }
})

test('a device tokenHash that is not a sha256 digest is store/corrupt', () => {
  /* The store is the boundary that keeps a credential from being persisted as
     if it were a hash. `tokens.js` refuses to authenticate a malformed hash, so
     admitting one here would leave a permanently unusable device row. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)

    for (const malformed of ['hunter2', 'A'.repeat(43), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '']) {
      writeFileSync(store.devicesPath, JSON.stringify({ version: 1, devices: [{ id: 'dev_1', tokenHash: malformed }] }))
      assertCode(() => store.read(), 'store/corrupt')
    }
  } finally {
    cleanupDir(dir)
  }
})

test('addDevice refuses a tokenHash that is not a sha256 digest', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)

    /* `store/invalid-device`, not `store/corrupt`: the file on disk is untouched
       and fine, the caller built a bad record. The code is what tells an operator
       which of the two to go look at. */
    assertCode(
      () => store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: 'hunter2' }),
      'store/invalid-device',
    )
    assert.equal(existsSync(store.devicesPath), false, 'nothing is written for a rejected record')
    assert.deepEqual(store.listDevices(), [])
  } finally {
    cleanupDir(dir)
  }
})

test('a newer document version is refused, not best-effort parsed', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    writeFileSync(store.devicesPath, JSON.stringify({ version: 2, devices: [], settings: {} }))

    assertCode(() => store.read(), 'store/version-unsupported')
  } finally {
    cleanupDir(dir)
  }
})

test('a document missing optional fields is backfilled', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    writeFileSync(store.devicesPath, JSON.stringify({
      version: 1,
      devices: [{ id: 'dev_1', tokenHash: 'b'.repeat(64) }],
    }))

    const document = store.read()
    assert.equal(document.devices[0].name, '')
    assert.equal(document.devices[0].ua, '')
    assert.equal(document.devices[0].createdAt, null)
    assert.equal(document.devices[0].revokedAt, null)
    assert.equal(document.devices[0].capabilities, null)
    assert.equal(document.settings.enabled, false)
    assert.equal(document.settings.port, DEFAULT_GATEWAY_PORT)
  } finally {
    cleanupDir(dir)
  }
})

test('a partial write does not destroy the previous document', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: createDeviceToken().tokenHash })
    const before = readFileSync(store.devicesPath, 'utf8')

    /* Simulate a writer that dies mid-flight: the temp file exists, the target
       is untouched. A reader must still see the complete previous document. */
    writeFileSync(`${store.devicesPath}.dead.tmp`, '{"version":1,"devi')

    assert.equal(readFileSync(store.devicesPath, 'utf8'), before)
    assert.equal(store.listDevices().length, 1)
  } finally {
    cleanupDir(dir)
  }
})

test('duplicate device ids are refused', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: createDeviceToken().tokenHash })

    assertCode(
      () => store.addDevice({ id: 'dev_1', name: 'other', tokenHash: createDeviceToken().tokenHash }),
      'store/duplicate-device',
    )
  } finally {
    cleanupDir(dir)
  }
})

test('a device record without id or tokenHash is refused', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    /* A caller-side record fault is `store/invalid-device`; only a fault in the
       document read off disk is `store/corrupt`. */
    assertCode(() => store.addDevice({ name: 'phone', tokenHash: createDeviceToken().tokenHash }), 'store/invalid-device')
    assertCode(() => store.addDevice({ id: 'dev_1' }), 'store/invalid-device')
    assertCode(() => store.addDevice(null), 'store/invalid-device')
  } finally {
    cleanupDir(dir)
  }
})

test('revokeDevice stamps revokedAt once and is idempotent', () => {
  const dir = makeTempDir()
  try {
    const { store, clock } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: createDeviceToken().tokenHash })

    clock.now += 5_000
    const first = store.revokeDevice('dev_1')
    assert.equal(first.revokedAt, '2026-10-17T03:04:48.000Z')

    clock.now += 5_000
    const second = store.revokeDevice('dev_1')
    assert.equal(second.revokedAt, first.revokedAt, 'the revocation timestamp is not rewritten')

    assert.equal(store.revokeDevice('dev_nope'), null)
  } finally {
    cleanupDir(dir)
  }
})

test('findActiveDeviceByTokenHash ignores revoked devices', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const { tokenHash } = createDeviceToken()
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash })

    assert.equal(store.findActiveDeviceByTokenHash(tokenHash).id, 'dev_1')
    assert.equal(store.findActiveDeviceByTokenHash('c'.repeat(64)), null)
    assert.equal(store.findActiveDeviceByTokenHash(''), null)
    assert.equal(store.findActiveDeviceByTokenHash(undefined), null)

    store.revokeDevice('dev_1')
    assert.equal(store.findActiveDeviceByTokenHash(tokenHash), null, 'a revoked device is not active')
    assert.equal(store.listDevices().length, 1, 'but it stays in the table for the panel and the audit')
  } finally {
    cleanupDir(dir)
  }
})

test('findActiveDeviceByTokenHash is exact: no prefix, case or truncation match', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const { tokenHash } = createDeviceToken()
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash })

    assert.equal(store.findActiveDeviceByTokenHash(tokenHash.slice(0, 63)), null, 'a prefix must not match')
    assert.equal(store.findActiveDeviceByTokenHash(`${tokenHash}0`), null, 'an extension must not match')
    assert.equal(store.findActiveDeviceByTokenHash(tokenHash.toUpperCase()), null, 'digests are lower-case hex')
    /* A non-digest is not a token hash and must never be looked up as one. */
    assert.equal(store.findActiveDeviceByTokenHash('hunter2'), null)
  } finally {
    cleanupDir(dir)
  }
})

test('touchDevice and renameDevice update one device and persist', () => {
  const dir = makeTempDir()
  try {
    const { store, clock } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: createDeviceToken().tokenHash })

    clock.now += 60_000
    const touched = store.touchDevice('dev_1')
    assert.equal(touched.lastSeenAt, '2026-10-17T03:05:43.000Z')
    assert.equal(touched.createdAt, '2026-10-17T03:04:43.000Z')

    const renamed = store.renameDevice('dev_1', '  客厅 iPad  ')
    assert.equal(renamed.name, '客厅 iPad', 'the name is trimmed')

    assert.equal(store.renameDevice('dev_1', '   '), null)
    assert.equal(store.renameDevice('dev_nope', 'x'), null)
    assert.equal(store.touchDevice('dev_nope'), null)
  } finally {
    cleanupDir(dir)
  }
})

test('settings merge partially and persist', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    assert.deepEqual(store.getSettings(), { enabled: false, port: DEFAULT_GATEWAY_PORT })

    assert.deepEqual(store.updateSettings({ enabled: true }), { enabled: true, port: DEFAULT_GATEWAY_PORT })
    assert.deepEqual(store.updateSettings({ port: 3091 }), { enabled: true, port: 3091 })
    assert.equal(store.getSettings().port, 3091, 'the enabled flag survived the port update')
  } finally {
    cleanupDir(dir)
  }
})

test('settings reject out-of-range ports and keep the previous value', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)

    for (const port of [0, -1, 70_000, 1.5, '3090', null, undefined]) {
      assert.equal(store.updateSettings({ port }).port, DEFAULT_GATEWAY_PORT, `rejected port ${String(port)}`)
    }
    assert.equal(store.updateSettings({ enabled: 'yes' }).enabled, false, 'only a real boolean flips the switch')
  } finally {
    cleanupDir(dir)
  }
})

test('the store creates its base directory recursively', () => {
  const dir = makeTempDir()
  try {
    const baseDir = path.join(dir, 'a', 'b', 'c')
    const store = createStore({ baseDir })
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: createDeviceToken().tokenHash })
    assert.ok(existsSync(path.join(baseDir, DEVICES_FILE_NAME)))
  } finally {
    cleanupDir(dir)
  }
})

test('a store whose base directory is an existing file fails with store/write-failed', () => {
  const dir = makeTempDir()
  try {
    const blocker = path.join(dir, 'blocker')
    mkdirSync(blocker)
    writeFileSync(path.join(blocker, 'inner'), '')
    /* Point the base at a path that cannot become a directory. */
    const store = createStore({ baseDir: path.join(blocker, 'inner', 'deeper') })
    assertCode(
      () => store.addDevice({ id: 'dev_1', name: 'p', tokenHash: createDeviceToken().tokenHash }),
      'store/write-failed',
    )
  } finally {
    cleanupDir(dir)
  }
})

test('defaultBaseDir resolves the real home through os.homedir()', () => {
  const base = defaultBaseDir()
  assert.ok(path.isAbsolute(base))
  assert.equal(path.basename(base), 'remote-control')
  assert.equal(path.basename(path.dirname(base)), '.dsh')
  /* The default is never used by a test to write — only asserted. */
  assert.equal(base, path.join(homedir(), '.dsh', 'remote-control'))
})
