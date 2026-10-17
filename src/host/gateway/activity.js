/**
 * dsh-remote-control — throttled `lastSeenAt` persistence.
 *
 * ## The measurement that dictates this design
 *
 * `store.touchDevice()` is correct and it is expensive: it is a full-document
 * atomic write (read → mutate → temp file → fsync → rename). Measured on this
 * project's dev machine, 200 calls took 1411.8 ms — **7.06 ms each**
 * (`research/official-connection-fence.md` §7.2). Calling it once per remote
 * request, as `design.md` §3.2 step 4 would naively do to keep the panel's "last
 * seen" fresh, caps gateway throughput at roughly 140 req/s and does an fsync per
 * request, which is also unkind to the SSD.
 *
 * ## The compromise
 *
 * The panel shows "last seen" to a human. A value up to 30 seconds stale is
 * indistinguishable from a live one, so the in-memory value is updated on every
 * request (free) and written to disk at most once per
 * `ACTIVITY_PERSIST_INTERVAL_MS` per device.
 *
 * The three cases where the persisted value must NOT lag are handled explicitly:
 *
 *   - **flush on revoke** — a revoked device's row must carry its final activity
 *     time, because after revocation there will be no further request to
 *     eventually write it;
 *   - **flush on panel read** — the panel is the only consumer of the field, so
 *     refreshing it at read time means a user who opens the panel always sees the
 *     truth, however recently the device was active;
 *   - **flush on shutdown** — the process's last few seconds of activity would
 *     otherwise be lost forever (`ctx.effect()` disposer, wired in `server.js`).
 *
 * Nothing here decides *whether* a device may act — that is `auth.js`. This module
 * only records that it did.
 *
 * ## Why a class-free factory with injected seams
 *
 * `.trellis/spec/backend/directory-structure.md`: named functions, factory
 * returning an object, and every side effect (clock, and the write itself)
 * injectable so a test can count writes without touching a filesystem.
 */

/**
 * Create the activity tracker.
 *
 * @param {object} options
 * @param {(id: string) => unknown} options.touch Persists one `lastSeenAt`.
 *   Nearly always `store.touchDevice`; injected so a test can count calls.
 * @param {() => number} [options.now] Clock in epoch milliseconds.
 * @param {number} [options.intervalMs] Minimum spacing between persisted writes per device.
 * @returns {{
 *   record: (deviceId: string) => void,
 *   flush: (deviceId?: string) => number,
 *   pending: () => string[],
 *   dispose: () => void,
 * }}
 */
export function createActivityTracker(options) {
  const touch = options.touch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 0
    ? options.intervalMs
    : 30_000

  /**
   * `deviceId → epoch ms of the last PERSISTED write`.
   *
   * A device present here has activity newer than what is on disk, so its next
   * write is not due yet. A device absent has never been written (or was just
   * flushed) and its next record writes immediately — which is what makes the
   * very first request from a freshly paired device land on disk promptly rather
   * than 30 seconds later.
   *
   * @type {Map<string, number>}
   */
  const lastPersistedAt = new Map()

  /** Measured counts, exposed for tests and for a future diagnostics row. */
  const stats = { recorded: 0, persisted: 0, coalesced: 0 }

  /**
   * Note that a device was active.
   *
   * Cheap by construction: one Map lookup and, at most once per interval, one
   * write. Never throws — a failed `touchDevice` (a locked file, a full disk) must
   * not fail the request that was already authorized. It is retried on the next
   * request, and a persistent failure is visible because `lastSeenAt` stops
   * moving.
   *
   * @param {string} deviceId
   */
  function record(deviceId) {
    if (typeof deviceId !== 'string' || deviceId === '') return
    stats.recorded += 1
    const at = now()
    const previous = lastPersistedAt.get(deviceId)
    if (previous !== undefined && at - previous < intervalMs) {
      stats.coalesced += 1
      return
    }
    /* Stamp BEFORE writing: if the write throws, the next attempt is throttled by
       one interval instead of hammering a failing filesystem on every request. */
    lastPersistedAt.set(deviceId, at)
    try {
      touch(deviceId)
      stats.persisted += 1
    } catch {
      /* Intentionally swallowed: see the method note. The interval stamp above is
         what keeps this from becoming a write storm. */
    }
  }

  /**
   * Persist one device now, or every device with unflushed activity.
   *
   * @param {string} [deviceId] Flush only this device; omit to flush all.
   * @returns {number} how many writes were attempted.
   */
  function flush(deviceId) {
    if (typeof deviceId === 'string' && deviceId !== '') {
      if (!lastPersistedAt.has(deviceId)) return 0
      lastPersistedAt.delete(deviceId)
      try {
        touch(deviceId)
        stats.persisted += 1
        return 1
      } catch {
        return 0
      }
    }
    let count = 0
    for (const id of [...lastPersistedAt.keys()]) count += flush(id)
    return count
  }

  /**
   * Devices with activity that has not been persisted since their last write.
   *
   * For the panel (which flushes before reading) and for tests.
   *
   * @returns {string[]}
   */
  function pending() {
    return [...lastPersistedAt.keys()]
  }

  /**
   * Final flush, for the `ctx.effect()` disposer.
   *
   * Separate from {@link flush} only in intent: the disposer must not throw out
   * of plugin unload, and this is the call site that must never be forgotten —
   * without it, whatever happened in the last 30 seconds before shutdown is lost.
   *
   * @returns {number}
   */
  function dispose() {
    return flush()
  }

  return { record, flush, pending, dispose, stats }
}
