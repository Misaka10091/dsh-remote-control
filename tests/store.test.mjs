/**
 * Device store: document shape, atomic writes, corrupt-file handling, permissions.
 *
 * Every test binds the store to its own temp directory — nothing here may touch
 * the real `~/.dsh`. The atomic-write and corruption cases are the ones that
 * matter: a half-written `devices.json` would invalidate every paired device at
 * once, and a corrupt file silently treated as empty is a security-relevant lie.
 *
 * The credential is a signed JWT since `research/jwt-device-credential.md`, so a
 * row is keyed by `id` (which is the token's `sub`) and no longer carries a
 * `tokenHash`. The tests that used to assert "only the digest is stored" now assert
 * something stronger and simpler: **nothing credential-shaped is stored at all**.
 * The `tokenHash` cases are kept because `version: 1` must still parse an old file
 * the same way, and a malformed one must still be refused rather than half-read.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, statSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { DEVICES_FILE_MODE, DEVICES_FILE_NAME, DEVICES_VERSION, DEFAULT_GATEWAY_PORT } from '../src/host/constants.js'
import { createStore, defaultBaseDir } from '../src/host/store.js'
import { hashToken } from '../src/host/tokens.js'
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
    /* The access block exists from the first read, in its documented default: LAN
       mode with no explicit choice, so the first enumerated private address wins.
       Starting in `public` would be starting in the mode whose reachability the
       plugin cannot check. */
    assert.deepEqual(document.settings.access, {
      mode: 'lan',
      lanAddress: '',
      public: [],
      selectedPublicId: null,
    })
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

    const record = store.addDevice({ id: 'dev_1', name: 'iPhone · Safari', ua: 'UA/1' })
    const onDisk = JSON.parse(readFileSync(store.devicesPath, 'utf8'))
    const [stored] = onDisk.devices

    /* Field order as documented. `tokenHash` is absent on purpose: the credential is
       a JWT and nothing about it is persisted, so a fresh row has no verifier. */
    assert.deepEqual(Object.keys(stored), [
      'id', 'name', 'ua', 'createdAt', 'lastSeenAt', 'revokedAt', 'capabilities',
    ])
    assert.equal(stored.id, 'dev_1')
    assert.equal(stored.name, 'iPhone · Safari')
    assert.equal(stored.ua, 'UA/1')
    assert.equal(stored.createdAt, '2026-10-17T03:04:43.000Z')
    assert.equal(stored.lastSeenAt, '2026-10-17T03:04:43.000Z')
    assert.equal(stored.revokedAt, null)
    assert.equal(stored.capabilities, null, 'capabilities is reserved and unused (PRD D6)')
    assert.deepEqual(Object.keys(onDisk), ['version', 'devices', 'settings'])
    assert.deepEqual(Object.keys(onDisk.settings), ['enabled', 'port', 'access', 'tunnel'])
    assert.equal(record.id, 'dev_1')
  } finally {
    cleanupDir(dir)
  }
})

test('the store writes no credential, digest or JWT material', () => {
  /* Stronger than the old "only the digest" assertion. The device credential is a
     JWT held by the device; the store's job is the ROW. An `id` and a `name` are all
     either of them needs, and a `tokenHash` here would be a second verifier nobody
     reads — `research/jwt-device-credential.md` §3.6 drops it.
   *
   * Asserted file-wide, because "the field I remembered" is not the same as "the
   * file": a JWT could land in `name` or `ua` just as easily. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', ua: 'UA/1' })

    const raw = readFileSync(store.devicesPath, 'utf8')
    assert.ok(!raw.includes('tokenHash'), 'no verifier is persisted')
    assert.ok(!/eyJ[A-Za-z0-9_-]{6,}\./.test(raw), 'no JWT anywhere in the document')
    assert.ok(!raw.includes(hashToken('anything')), 'and no digest of one')
    assert.ok(!/dsh-rc-jwt/.test(raw), 'not even the cookie name')
  } finally {
    cleanupDir(dir)
  }
})

test('a write leaves no temp files behind', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone' })

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
    store.addDevice({ id: 'dev_1', name: 'phone' })

    /* A second store over the same directory sees the same device — the file,
       not in-memory state, is the source of truth. */
    const reopened = createStore({ baseDir: dir })
    const devices = reopened.listDevices()
    assert.equal(devices.length, 1)
    assert.equal(devices[0].id, 'dev_1')
  } finally {
    cleanupDir(dir)
  }
})

test('the document is written with a newline at EOF and valid JSON', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', ua: '' })

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
    store.addDevice({ id: 'dev_1', name: 'phone', ua: '' })

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
        ua: '',
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

test('a device record without an id raises store/corrupt', () => {
  /* `id` is the row key AND the JWT `sub`, so a row without one can never be
     authenticated — accepting it would leave an unusable row in the table. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)

    writeFileSync(store.devicesPath, JSON.stringify({ version: 1, devices: [{ tokenHash: 'a'.repeat(64) }] }))
    assertCode(() => store.read(), 'store/corrupt')

    writeFileSync(store.devicesPath, JSON.stringify({ version: 1, devices: [{}] }))
    assertCode(() => store.read(), 'store/corrupt')

    writeFileSync(store.devicesPath, JSON.stringify({ version: 1, devices: ['nope'] }))
    assertCode(() => store.read(), 'store/corrupt')
  } finally {
    cleanupDir(dir)
  }
})

test('a version-1 row with NO tokenHash still loads, because the field is legacy', () => {
  /* The JWT switch removed the verifier. `version: 1` files written by this build
     have no `tokenHash`, so requiring one would make every newly written file
     unreadable — the "forward-compatible additions only" rule inverted. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    writeFileSync(store.devicesPath, JSON.stringify({
      version: 1,
      devices: [{ id: 'dev_1', name: 'phone', createdAt: '2026-01-01T00:00:00.000Z' }],
      settings: { enabled: false, port: 3090 },
    }))

    const devices = store.listDevices()
    assert.equal(devices.length, 1)
    assert.equal(devices[0].id, 'dev_1')
    assert.equal(devices[0].tokenHash, undefined, 'and no verifier is invented for it')
  } finally {
    cleanupDir(dir)
  }
})

test('an old row WITH a tokenHash still loads, and is projected unchanged', () => {
  /* The migration story is "no automatic migration" (`research/jwt-device-credential.md`
     §3.6): old rows keep their hash, keep parsing, and simply cannot authenticate
     any more because nothing compares a hash to a JWT. Reading them must not fail,
     or an upgrade would brick the store instead of merely un-pairing devices. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const tokenHash = 'b'.repeat(64)
    writeFileSync(store.devicesPath, JSON.stringify({
      version: 1,
      devices: [{ id: 'dev_1', name: 'old phone', tokenHash }],
    }))

    const [device] = store.listDevices()
    assert.equal(device.id, 'dev_1')
    assert.equal(device.name, 'old phone')
    assert.equal(device.tokenHash, tokenHash, 'the legacy field is preserved, not dropped on read')
  } finally {
    cleanupDir(dir)
  }
})

test('a device tokenHash that is not a sha256 digest is store/corrupt', () => {
  /* Present-but-malformed is still refused. Absent is fine (see above); a value of
     the wrong shape is damage, and reading it as a device would mean the store is
     silently swallowing a corrupt row. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)

    for (const malformed of ['hunter2', 'A'.repeat(43), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
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
    assert.deepEqual(document.settings.access, {
      mode: 'lan',
      lanAddress: '',
      public: [],
      selectedPublicId: null,
    })
  } finally {
    cleanupDir(dir)
  }
})

test('a partial write does not destroy the previous document', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', ua: '' })
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
    store.addDevice({ id: 'dev_1', name: 'phone', ua: '' })

    assertCode(
      () => store.addDevice({ id: 'dev_1', name: 'other', ua: '' }),
      'store/duplicate-device',
    )
  } finally {
    cleanupDir(dir)
  }
})

test('a device record without an id is refused', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    /* A caller-side record fault is `store/invalid-device`; only a fault in the
       document read off disk is `store/corrupt`. */
    assertCode(() => store.addDevice({ name: 'phone', ua: '' }), 'store/invalid-device')
    assertCode(() => store.addDevice({ id: '' }), 'store/invalid-device')
    assertCode(() => store.addDevice({ id: 42 }), 'store/invalid-device')
    assertCode(() => store.addDevice(null), 'store/invalid-device')
  } finally {
    cleanupDir(dir)
  }
})

test('addDevice accepts a record with no tokenHash, because the credential is a JWT', () => {
  /* The JWT-era shape. Requiring a hash here would make the pairing route — which
     has none to give — unable to create a device at all. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const record = store.addDevice({ id: 'dev_1' })
    assert.equal(record.id, 'dev_1')
    assert.equal(record.tokenHash, undefined)
    assert.equal(store.listDevices().length, 1)
  } finally {
    cleanupDir(dir)
  }
})

test('revokeDevice stamps revokedAt once and is idempotent', () => {
  const dir = makeTempDir()
  try {
    const { store, clock } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', ua: '' })

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

test('findDeviceById returns revoked rows too, so the verdict stays the caller’s', () => {
  /* The JWT `sub` lookup (`research/jwt-device-credential.md` §3.5). Revocation is
     NOT filtered here on purpose: `auth.js` must tell "revoked" apart from "unknown"
     — one gets a 401 with a cookie deletion, the other a plain 401 — and a lookup
     that dropped revoked rows would collapse the two into one indistinguishable
     answer.
   *
   * The revoked set lives in the gateway, not in this module, so this is also the
   * assertion that the split is real: the store answers "here is the row", the
   * gateway answers "and it is dead". */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', ua: '' })

    assert.equal(store.findDeviceById('dev_1').id, 'dev_1')
    assert.equal(store.findDeviceById('dev_nope'), null)
    assert.equal(store.findDeviceById(''), null)
    assert.equal(store.findDeviceById(undefined), null)

    store.revokeDevice('dev_1')
    const revoked = store.findDeviceById('dev_1')
    assert.ok(revoked !== null, 'a revoked device is still found')
    assert.equal(revoked.revokedAt, '2026-10-17T03:04:43.000Z', 'with the fact that it is revoked')
    assert.equal(store.listDevices().length, 1, 'and it stays in the table for the panel and the audit')
  } finally {
    cleanupDir(dir)
  }
})

test('findDeviceById is exact: no prefix, case or truncation match', () => {
  /* Near-miss ids must not resolve. A tolerant lookup is how `dev_1` becomes
     `dev_10`, and the credential's `sub` is the only authorization input. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', ua: '' })
    store.addDevice({ id: 'dev_10', name: 'tablet', ua: '' })

    assert.equal(store.findDeviceById('dev_1').name, 'phone')
    assert.equal(store.findDeviceById('dev_10').name, 'tablet')
    assert.equal(store.findDeviceById('dev_'), null, 'a prefix must not match')
    assert.equal(store.findDeviceById('dev_100'), null, 'an extension must not match')
    assert.equal(store.findDeviceById('DEV_1'), null, 'ids are case-sensitive')
    assert.equal(store.findDeviceById(' hunter2'), null)
  } finally {
    cleanupDir(dir)
  }
})

test('touchDevice and renameDevice update one device and persist', () => {
  const dir = makeTempDir()
  try {
    const { store, clock } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', ua: '' })

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
    const defaultAccess = { mode: 'lan', lanAddress: '', public: [], selectedPublicId: null }
    const defaultTunnel = { enabled: false, mode: 'quick', binaryPath: '', publicUrl: '' }
    assert.deepEqual(store.getSettings(), {
      enabled: false,
      port: DEFAULT_GATEWAY_PORT,
      access: defaultAccess,
      tunnel: defaultTunnel,
    })

    assert.deepEqual(store.updateSettings({ enabled: true }), {
      enabled: true,
      port: DEFAULT_GATEWAY_PORT,
      access: defaultAccess,
      tunnel: defaultTunnel,
    })
    assert.deepEqual(store.updateSettings({ port: 3091 }), {
      enabled: true,
      port: 3091,
      access: defaultAccess,
      tunnel: defaultTunnel,
    })
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

/* ------------------------------------------------------------------ *
 * settings.access — the pairing link's address (`prd.md` R5)
 * ------------------------------------------------------------------ */

test('a devices.json written before access existed loads with the default', () => {
  /* The field is ADDITIVE (`design.md` §1.1): no migration script, no `version`
     bump. A pre-upgrade file must load byte-identically and merely gain the
     default — anything else would refuse to start for every existing user. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    writeFileSync(store.devicesPath, JSON.stringify({
      version: 1,
      devices: [{ id: 'dev_1', name: 'phone' }],
      settings: { enabled: true, port: 3091 },
    }))

    const settings = store.getSettings()
    assert.equal(settings.enabled, true)
    assert.equal(settings.port, 3091)
    assert.deepEqual(settings.access, { mode: 'lan', lanAddress: '', public: [], selectedPublicId: null })
    /* Same additive rule for the managed tunnel (2026-10-20): a file written
       before `settings.tunnel` existed gains the documented defaults. */
    assert.deepEqual(settings.tunnel, { enabled: false, mode: 'quick', binaryPath: '', publicUrl: '' })
  } finally {
    cleanupDir(dir)
  }
})

test('access settings survive a write and read back', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const access = {
      mode: 'public',
      lanAddress: '192.168.1.5',
      public: [
        { id: 'pub_a', label: '家里 DDNS', address: 'home.example.com:3090' },
        { id: 'pub_b', label: '', address: 'https://dsh.example.net' },
      ],
      selectedPublicId: 'pub_b',
    }

    assert.deepEqual(store.updateSettings({ access }).access, access)
    /* The file is the source of truth: a second store over the same directory
       must see exactly what was written. */
    const reopened = createStore({ baseDir: dir })
    assert.deepEqual(reopened.getSettings().access, access)
  } finally {
    cleanupDir(dir)
  }
})

test('tunnel settings survive a write and read back', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const tunnel = {
      enabled: true,
      mode: 'token',
      binaryPath: '/usr/local/bin/cloudflared',
      publicUrl: 'https://dsh.example.com',
    }

    assert.deepEqual(store.updateSettings({ tunnel }).tunnel, tunnel)
    const reopened = createStore({ baseDir: dir })
    assert.deepEqual(reopened.getSettings().tunnel, tunnel)
  } finally {
    cleanupDir(dir)
  }
})

test('access normalization drops what it cannot use and keeps the rest', () => {
  /* A hand-edited file must never fail to load (`database-guidelines.md`): a
     broken address book is a broken LINK, not a broken plugin. So the reader is
     lenient — which is also why `validateAccess`'s strict form exists for the API
     path, where the caller must be told instead of rewritten. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    writeFileSync(store.devicesPath, JSON.stringify({
      version: 1,
      devices: [],
      settings: {
        access: {
          mode: 'nonsense',
          lanAddress: 'not a host',
          public: [
            { id: 'pub_a', label: 'ok', address: 'home.example.com:3090' },
            { id: '', label: 'no id', address: 'kept-nowhere.example' },
            { id: 'pub_c', address: 'dsh.example.net/path' },
            'not an object',
          ],
          selectedPublicId: 'pub_missing',
        },
      },
    }))

    /* Every FIELD falls back on its own and every unusable ROW is dropped, so the
       usable rest survives. An unknown mode is `lan` — the reader never upgrades
       the user into `public`, the mode whose reachability it cannot check. */
    assert.deepEqual(store.getSettings().access, {
      mode: 'lan',
      lanAddress: '',
      public: [{ id: 'pub_a', label: 'ok', address: 'home.example.com:3090' }],
      selectedPublicId: null,
    }, 'each unusable field and row is dropped, the usable ones survive')

    writeFileSync(store.devicesPath, JSON.stringify({
      version: 1,
      devices: [],
      settings: {
        access: {
          mode: 'public',
          lanAddress: 'not a host',
          public: [
            { id: 'pub_a', label: 'ok', address: 'home.example.com:3090' },
            { id: '', label: 'no id', address: 'kept-nowhere.example' },
            { id: 'pub_c', address: 'dsh.example.net/path' },
          ],
          selectedPublicId: 'pub_a',
        },
      },
    }))

    assert.deepEqual(store.getSettings().access, {
      mode: 'public',
      /* An unusable LAN address is cleared, not carried: it can never match a NIC
         entry, and a value that can never match is a setting that lies. */
      lanAddress: '',
      public: [{ id: 'pub_a', label: 'ok', address: 'home.example.com:3090' }],
      selectedPublicId: 'pub_a',
    })
  } finally {
    cleanupDir(dir)
  }
})

test('the public address book is truncated to its documented maximum', () => {
  /* The cap is 8 (`PUBLIC_ADDRESS_MAX`). Truncation is the reader's fallback; the
     API refuses an oversized list outright, which is what a real caller sees. */
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const publicRows = Array.from({ length: 12 }, (unused, index) => ({
      id: `pub_${String(index)}`,
      label: '',
      address: `host${String(index)}.example`,
    }))
    store.updateSettings({ access: { mode: 'public', lanAddress: '', public: publicRows, selectedPublicId: 'pub_0' } })

    const kept = store.getSettings().access.public
    assert.equal(kept.length, 8)
    assert.equal(kept[0].id, 'pub_0', 'order is the display order and is preserved')
    assert.equal(kept[7].id, 'pub_7')
  } finally {
    cleanupDir(dir)
  }
})

test('a label or an id that cannot be stored is refused by the writer, not silently kept', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    /* 41 characters, one over `PUBLIC_LABEL_MAX`. */
    const longLabel = 'l'.repeat(41)
    assert.deepEqual(
      store.updateSettings({
        access: {
          mode: 'public',
          public: [{ id: 'pub_a', label: longLabel, address: 'home.example.com' }],
          selectedPublicId: 'pub_a',
        },
      }).access,
      {
        mode: 'public',
        lanAddress: '',
        /* The whole block is rejected by the shared validator, so the store falls
           back to the default rather than half-applying it. */
        public: [],
        selectedPublicId: null,
      },
    )
  } finally {
    cleanupDir(dir)
  }
})

test('updating one setting never disturbs the access block', () => {
  const dir = makeTempDir()
  try {
    const { store } = makeStore(dir)
    const access = {
      mode: 'public',
      lanAddress: '',
      public: [{ id: 'pub_a', label: 'home', address: 'home.example.com:8443' }],
      selectedPublicId: 'pub_a',
    }
    store.updateSettings({ access })

    const after = store.updateSettings({ port: 4000 })
    assert.equal(after.port, 4000)
    assert.deepEqual(after.access, access, 'the port write kept the addresses')
    assert.deepEqual(store.updateSettings({ enabled: true }).access, access)
  } finally {
    cleanupDir(dir)
  }
})

test('the store creates its base directory recursively', () => {
  const dir = makeTempDir()
  try {
    const baseDir = path.join(dir, 'a', 'b', 'c')
    const store = createStore({ baseDir })
    store.addDevice({ id: 'dev_1', name: 'phone', ua: '' })
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
      () => store.addDevice({ id: 'dev_1', name: 'p', ua: '' }),
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
