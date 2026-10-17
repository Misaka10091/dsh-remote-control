/**
 * `lastSeenAt` throttling (Gap B — `research/official-connection-fence.md` §7.2).
 *
 * The measurement that makes this necessary: `store.touchDevice()` costs 7.06 ms
 * per call (a full read + atomic write + fsync), so calling it per request caps the
 * gateway at roughly 140 req/s. The requirement is therefore a *ratio* — N rapid
 * requests must cause far fewer than N writes — and that ratio is what these tests
 * assert, with the real store at the end so the count is not a mock's opinion.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { createActivityTracker } from '../src/host/gateway/activity.js'
import { createDeviceToken } from '../src/host/tokens.js'
import { cleanupDir, makeStore, makeTempDir } from './helpers.mjs'

/** A `touch` that counts calls instead of writing. */
function countingTouch() {
  const calls = []
  const touch = (id) => {
    calls.push(id)
    return { id, lastSeenAt: 'x' }
  }
  touch.calls = calls
  return touch
}

test('rapid requests for one device cause far fewer writes than requests', () => {
  /* The headline requirement: N rapid requests must produce far fewer than N
     writes. 200 requests inside one 30s window for one device is ONE write. */
  const touch = countingTouch()
  const clock = { now: 0 }
  const activity = createActivityTracker({ touch, now: () => clock.now, intervalMs: 30_000 })

  for (let index = 0; index < 200; index += 1) {
    clock.now += 10
    activity.record('dev_1')
  }

  assert.equal(touch.calls.length, 1, '200 requests, 1 write')
  assert.equal(activity.stats.recorded, 200)
  assert.equal(activity.stats.coalesced, 199)
  assert.equal(activity.stats.persisted, 1)
})

test('the first request writes immediately rather than waiting out the interval', () => {
  /* Otherwise a freshly paired device shows no "last seen" for half a minute
     after its first request, which reads as "pairing did not work". */
  const touch = countingTouch()
  const activity = createActivityTracker({ touch, now: () => 1_000, intervalMs: 30_000 })

  activity.record('dev_1')
  assert.deepEqual(touch.calls, ['dev_1'])
})

test('a write happens once per device per interval, not once per interval overall', () => {
  const touch = countingTouch()
  const clock = { now: 0 }
  const activity = createActivityTracker({ touch, now: () => clock.now, intervalMs: 30_000 })

  activity.record('dev_1')
  activity.record('dev_2')
  activity.record('dev_3')

  assert.deepEqual(touch.calls, ['dev_1', 'dev_2', 'dev_3'], 'each device gets its own first write')
})

test('the next write becomes due exactly when the interval has elapsed', () => {
  const touch = countingTouch()
  const clock = { now: 0 }
  const activity = createActivityTracker({ touch, now: () => clock.now, intervalMs: 30_000 })

  activity.record('dev_1')
  clock.now = 29_999
  activity.record('dev_1')
  assert.equal(touch.calls.length, 1, 'still inside the interval')

  clock.now = 30_000
  activity.record('dev_1')
  assert.equal(touch.calls.length, 2, 'the interval has elapsed')
})

test('flush persists a device with unflushed activity and then stops repeating it', () => {
  const touch = countingTouch()
  const clock = { now: 0 }
  const activity = createActivityTracker({ touch, now: () => clock.now, intervalMs: 30_000 })

  activity.record('dev_1')
  assert.deepEqual(activity.pending(), ['dev_1'])

  assert.equal(activity.flush('dev_1'), 1)
  assert.deepEqual(touch.calls, ['dev_1', 'dev_1'])
  assert.deepEqual(activity.pending(), [], 'nothing left outstanding')

  /* Flushing again immediately is a no-op rather than a second write. */
  assert.equal(activity.flush('dev_1'), 0)
  assert.equal(touch.calls.length, 2)
})

test('flush with no argument persists every device with outstanding activity', () => {
  const touch = countingTouch()
  const activity = createActivityTracker({ touch, now: () => 0, intervalMs: 30_000 })

  activity.record('dev_1')
  activity.record('dev_2')
  activity.record('dev_1')
  activity.record('dev_2')

  assert.deepEqual(activity.pending().sort(), ['dev_1', 'dev_2'])
  assert.equal(activity.flush(), 2)
  assert.deepEqual(activity.pending(), [])
})

test('dispose flushes everything, so shutdown does not lose the last interval', () => {
  /* `ctx.effect()`'s disposer calls this. Without it, whatever happened in the
     final 30 seconds before shutdown is gone forever. */
  const touch = countingTouch()
  const activity = createActivityTracker({ touch, now: () => 0, intervalMs: 30_000 })

  activity.record('dev_1')
  activity.record('dev_2')
  activity.record('dev_1')

  assert.equal(activity.dispose(), 2)
  assert.deepEqual(activity.pending(), [])
  assert.deepEqual(touch.calls, ['dev_1', 'dev_2', 'dev_1', 'dev_2'])
})

test('a FAILED flush keeps the device pending so the final write is not silently lost', () => {
  /* The failure mode this pins: `flush` used to delete the pending stamp BEFORE
     attempting the write, so a write that threw dropped the device entirely. The
     one place that matters most is the shutdown disposer — a locked file or a full
     disk at unload would mean the last half-minute of "last seen" is lost with no
     retry and no signal. The panel-read flush has the same problem: the panel
     would render a stale value and the device would then never be re-flushed. */
  let failing = true
  let writes = 0
  const touch = () => {
    writes += 1
    if (failing) {
      throw Object.assign(new Error('devices.json could not be written'), { code: 'store/write-failed' })
    }
    return { id: 'dev_1' }
  }
  const activity = createActivityTracker({ touch, now: () => 0, intervalMs: 30_000 })

  activity.record('dev_1')
  assert.deepEqual(activity.pending(), ['dev_1'])
  assert.equal(writes, 1, 'the throttled record attempted its one write, and it failed')

  assert.equal(activity.flush('dev_1'), 0, 'the write failed')
  assert.equal(writes, 2, 'flush retried rather than trusting the failed attempt')
  assert.deepEqual(activity.pending(), ['dev_1'], 'the activity is still outstanding, not forgotten')

  /* Second attempt while still failing: it tries again rather than being throttled
     away — `flush` is the caller saying "persist this now". */
  assert.equal(activity.flush(), 0)
  assert.equal(writes, 3)
  assert.deepEqual(activity.pending(), ['dev_1'])

  /* Recovery: the very next flush lands it. */
  failing = false
  assert.equal(activity.flush(), 1)
  assert.equal(writes, 4)
  assert.deepEqual(activity.pending(), [])
})

test('a failing touch is swallowed so an authorized request is not failed by bookkeeping', () => {
  /* The request was already authorized; a locked file or a full disk must not turn
     a successful page load into a 500. It is retried on a later request. */
  let attempts = 0
  const touch = () => {
    attempts += 1
    throw Object.assign(new Error('devices.json could not be written'), { code: 'store/write-failed' })
  }
  const clock = { now: 0 }
  const activity = createActivityTracker({ touch, now: () => clock.now, intervalMs: 30_000 })

  assert.doesNotThrow(() => activity.record('dev_1'))
  assert.equal(attempts, 1)

  /* The interval stamp was applied before the attempt, so a failing filesystem is
     not hammered on every subsequent request. */
  for (let index = 0; index < 50; index += 1) {
    clock.now += 1
    activity.record('dev_1')
  }
  assert.equal(attempts, 1, 'one attempt per interval even while failing')

  /* Once the interval elapses it tries again. */
  clock.now += 30_000
  activity.record('dev_1')
  assert.equal(attempts, 2)
})

test('a non-string device id is ignored rather than written', () => {
  const touch = countingTouch()
  const activity = createActivityTracker({ touch, now: () => 0, intervalMs: 30_000 })

  for (const id of [undefined, null, 0, {}, '', []]) activity.record(id)
  assert.deepEqual(touch.calls, [])
  assert.equal(activity.stats.recorded, 0)
})

test('an interval of zero writes on every request (explicit opt-out)', () => {
  /* Documented as a test seam and a debugging aid, not a production setting. */
  const touch = countingTouch()
  const activity = createActivityTracker({ touch, now: () => 0, intervalMs: 0 })

  for (let index = 0; index < 5; index += 1) activity.record('dev_1')
  assert.equal(touch.calls.length, 5)
})

/* ------------------------------------------------------------------ *
 * Against the real store: the ratio the research note asks for
 * ------------------------------------------------------------------ */

test('N rapid requests through the tracker cause far fewer than N devices.json writes', () => {
  /* The end-to-end version: the real `store.touchDevice`, whose every invocation is
     exactly one atomic write (read → mutate → temp → fsync → rename, 7.06 ms
     measured). Counting invocations therefore counts disk writes exactly. */
  const dir = makeTempDir()
  try {
    const { store, clock } = makeStore(dir)
    store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: createDeviceToken().tokenHash })

    let writes = 0
    const touch = (id) => {
      writes += 1
      return store.touchDevice(id)
    }

    const activity = createActivityTracker({ touch, now: () => clock.now })

    const requests = 100
    for (let index = 0; index < requests; index += 1) {
      clock.now += 5
      activity.record('dev_1')
    }

    assert.equal(writes, 1, `${requests} requests must not produce ${requests} writes`)
    assert.ok(writes < requests / 50, 'the ratio is far below one write per request')

    /* The final flush lands the freshest timestamp, which is what the panel reads. */
    clock.now += 60_000
    activity.record('dev_1')
    activity.dispose()
    const persisted = JSON.parse(readFileSync(store.devicesPath, 'utf8')).devices[0].lastSeenAt
    assert.equal(persisted, new Date(clock.now).toISOString(), 'the panel sees the freshest value after a flush')
  } finally {
    cleanupDir(dir)
  }
})
