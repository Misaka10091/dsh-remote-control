/**
 * dsh-remote-control — the operation audit trail (`prd.md` R5, `design.md` §6).
 *
 * One JSONL file per UTC day under the runtime directory:
 *
 *     ~/.dsh/remote-control/audit-2026-10-17.jsonl
 *
 * ## What this module is FOR, and what it must never become
 *
 * The audit answers "who did what, when". It is NOT a transcript. PRD D5 and
 * `.trellis/spec/backend/logging-guidelines.md` are both explicit: **actions and
 * timestamps, never content**. A single leaked message body in this file would
 * be a permanent, unencrypted, plain-text copy of the user's conversation — the
 * exact thing the user opened this tool to keep on their own machine.
 *
 * So the rule is enforced structurally rather than by discipline:
 *
 *   - {@link AUDIT_EVENTS} is a closed set. An event name outside it is refused,
 *     not written, so a future caller cannot invent `tool_output` by accident.
 *   - {@link record} copies ONLY the five documented fields. Anything else on the
 *     caller's object is dropped, which means a well-meaning caller passing
 *     `{ ..., text: prompt }` cannot smuggle it in.
 *   - `meta` accepts a whitelist of IDENTIFIER keys ({@link META_KEYS}). A key
 *     named `body`, `content`, `args`, `token` or `cookie` is dropped, and every
 *     accepted value must survive `META_VALUE_PATTERN` — a 2000-character string
 *     is refused even under an allowed key, which is what actually keeps a
 *     message body out when someone passes `{ sessionId: wholePrompt }`.
 *   - `deviceId` and `ip` are not free-form either: each has the exact shape the
 *     host produces (`DEVICE_ID_PATTERN`, `IP_PATTERN`), so a credential cannot
 *     take a credential-shaped slot.
 *
 * ## Retention: 30 days, and only expired DAY FILES
 *
 * `prune()` deletes `audit-<date>.jsonl` files whose date is older than the
 * retention window. It never deletes anything it did not itself name: a stray
 * `devices.json`, a temp file, a user's own file that happens to live in the
 * directory — all untouched, because the file-name pattern is matched, the date
 * parsed and re-serialized, and only an exact `audit-YYYY-MM-DD.jsonl` is a
 * candidate. Deleting a user's data because it shared a directory would be a far
 * worse bug than a too-long audit trail.
 *
 * ## Writes: append-only, and append is safe
 *
 * An audit line is appended with `writeSync` on a descriptor opened `'a'`. POSIX
 * `O_APPEND` makes a single `write` atomic with respect to other appenders, so
 * two concurrent lines cannot interleave — which is the property a JSONL file
 * needs and the reason there is no temp-file dance here. Atomic-replace
 * (`store.js`'s technique) would be exactly wrong: it would rewrite the whole
 * file on every event.
 *
 * A short write is still possible (`quality-guidelines.md` §15), so the write
 * loop is by offset and a failure is reported rather than silently truncating a
 * line.
 *
 * ## Failure policy
 *
 * Never throws out of {@link record}. The caller is a request handler or a
 * pairing redemption, and an unwritable audit file must not turn a paired
 * device's request into a 500 — the request was already authorized. A failure is
 * counted in `stats.failures` and reported to the caller's `onError`, so it is
 * visible rather than silent (`quality-guidelines.md` §5 applies to degradation:
 * log it once, do not pretend it worked).
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

import { AUDIT_FILE_MODE, AUDIT_FILE_PREFIX, AUDIT_RETENTION_DAYS } from './constants.js'

/**
 * The closed set of audit events (`design.md` §6, plus stage 4's `pair_failed`).
 *
 * `pair_failed` is an addition the PRD's own gap analysis asked for
 * (`research/official-connection-fence.md` §7.1 — "爆破不可见"): a user cannot
 * notice someone guessing at a pairing code if failed redemptions leave no
 * trace. It is a FIRST-CLASS event rather than a `meta.status` on `pair`,
 * because the two answer different questions and a user scanning the file for
 * "was I attacked" should be able to grep one word.
 *
 * `unknown` is not a fallback for a defect — it is `design.md` §6's deliberate
 * answer for a request whose path this hop does not recognize. The gateway does
 * not understand DSH semantics, so an official path change must degrade the
 * audit to `unknown` rather than break it.
 */
export const AUDIT_EVENTS = Object.freeze([
  'pair',
  'connect',
  'disconnect',
  'send_message',
  'stop_task',
  'approval_answer',
  'revoke',
  'pair_failed',
  'unknown',
])

/** Membership set for {@link isAuditEvent}; kept in sync with the array above by construction. */
const EVENT_SET = new Set(AUDIT_EVENTS)

/**
 * `meta` keys that may be recorded — identifiers only.
 *
 * Each one names a THING, never its contents. Adding a key here is a deliberate
 * act with a test behind it (`tests/audit.test.mjs` asserts the whitelist).
 */
export const META_KEYS = Object.freeze([
  'sessionId',
  'pairId',
  'turnId',
  'requestId',
  'count',
  'method',
  'path',
  'status',
  'code',
  'closedSockets',
])

/** Same set, for validation. */
const META_KEY_SET = new Set(META_KEYS)

/**
 * Shape rules for the three places a value can land.
 *
 * The generic rule ("short, printable, no whitespace") is what keeps a message
 * body out. It is NOT enough to keep a credential out, because a 43-character
 * base64url device token is short, printable and whitespace-free. So each field
 * that could plausibly receive one has its own, tighter shape:
 *
 *   - `DEVICE_ID_PATTERN` — a device id is `dev_` + an opaque body (`design.md` §5).
 *     Requiring the prefix makes "a caller passed the token instead of the id"
 *     impossible rather than merely unlikely.
 *   - `IP_PATTERN` — an address, and only address characters. Every call site
 *     reads `socket.remoteAddress`, so this costs nothing; a token contains
 *     letters past `f` in nearly every case and a full one is refused outright.
 *   - `META_VALUE_PATTERN` — the stricter of the two identifier shapes, used for
 *     `meta` values. 64 characters (a sha256 digest is 64 hex, and is exactly the
 *     thing `verifyToken` compares, so it is the longest value worth accepting
 *     here) and it must not be ONE long base64url run: a real identifier such as
 *     `sess_1`, `turn_42`, `2026-10-17`, `POST` or `/api/session/prompt` always
 *     contains a separator or is short enough to be unambiguous. A 43-character
 *     unbroken alphanumeric run is the shape of a 32-byte token and of nothing
 *     this trail needs.
 *
 * These are deliberately conservative. A false negative means one identifier is
 * missing from one audit line; a false positive means part of a credential is in
 * a plain-text file forever.
 */

/** A device id: exactly the shape `store.js` mints. */
const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{1,80}$/

/**
 * An address, in any spelling `socket.remoteAddress` produces.
 *
 * Written as a real address grammar rather than a character class, and that
 * distinction is load-bearing: a character class of `[0-9a-fA-F:.]` also matches
 * `AAAAAAAAAAAAAAAA` (43 `A`s is not an address but it IS all hex letters), so a
 * token of hex-only bytes would have slipped into the `ip` slot. Requiring either
 * four dotted decimal octets, a bracketed IPv6 literal, or a string containing a
 * colon (which no base64url token does) refuses that shape.
 *
 * ipv4, `[ipv6]`, and bare `ipv6` (which must contain a colon, so `127.0.0.1`
 * and `::1` both match but a token never does).
 */
const IP_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:.]+\]|[0-9a-fA-F:.]*:[0-9a-fA-F:.]*)$/

/**
 * A `meta` value: an identifier, and not one unbroken long alphanumeric run.
 *
 * `(?![A-Za-z0-9_-]{30,})` is the whole point — it rejects the token shape while
 * accepting `sess_1`, `turn_42`, `2026-10-17T03:04:43.000Z`, `POST` and
 * `/api/session/prompt`.
 */
const META_VALUE_PATTERN = /^(?!.*[A-Za-z0-9_-]{30,})[\w.:/@+-]{1,64}$/

/** Largest `meta` object accepted; more than a handful of keys is not an identifier set. */
const MAX_META_KEYS = 8

/**
 * File-name pattern for one day's audit file.
 *
 * Both groups are matched strictly so {@link prune} can use the REGEX as its
 * only criterion for "this file is mine": anything that does not match exactly
 * is not a candidate for deletion, full stop.
 */
const AUDIT_FILE_PATTERN = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

/** Milliseconds in one UTC day. Audit days are UTC days (`ts` is ISO-8601 UTC). */
const DAY_MS = 86_400_000

/**
 * Build an Error carrying a stable `code` (see `.trellis/spec/backend/error-handling.md`).
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function auditError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Whether a value is a member of the closed event set.
 *
 * @param {unknown} event
 * @returns {boolean}
 */
export function isAuditEvent(event) {
  return typeof event === 'string' && EVENT_SET.has(event)
}

/**
 * The UTC day key (`YYYY-MM-DD`) of an instant.
 *
 * UTC and not local time: `ts` in every line is ISO-8601 UTC, and a file whose
 * name is a local date would mix two instants into one day at a DST boundary.
 *
 * @param {number} epochMs
 * @returns {string}
 */
export function dayKeyOf(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10)
}

/**
 * Copy the caller's `meta` down to whitelisted identifiers.
 *
 * Two independent filters, because either one alone is defeatable:
 *
 *   - the KEY must be in {@link META_KEYS}, so `{ content: … }` never lands;
 *   - the VALUE must match `META_VALUE_PATTERN`, so `{ sessionId: prompt }`
 *     never lands either.
 *
 * Both must pass. This is the function that stands between "the caller made a
 * mistake" and "the user's conversation is in a plain-text file forever".
 *
 * @param {unknown} meta
 * @returns {Record<string, string | number> | undefined} undefined when nothing survives.
 */
export function sanitizeMeta(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const clean = {}
  let kept = 0
  for (const key of Object.keys(meta)) {
    if (kept >= MAX_META_KEYS) break
    if (!META_KEY_SET.has(key)) continue
    const value = meta[key]
    if (typeof value === 'number') {
      /* Only finite integers: a float would be an odd identifier, and `NaN`/`Infinity`
         do not survive JSON round-tripping (they become `null`), which would make the
         line un-replayable. */
      if (!Number.isInteger(value)) continue
      clean[key] = value
      kept += 1
      continue
    }
    if (typeof value === 'string' && META_VALUE_PATTERN.test(value)) {
      clean[key] = value
      kept += 1
    }
  }
  return kept === 0 ? undefined : clean
}

/**
 * Build one audit line object, or `null` when the event is not acceptable.
 *
 * The field ORDER is fixed here — `ts`, `event`, `deviceId`, `ip`, `meta` — so
 * every line in every file has the same shape and `head -1` describes the file
 * (`logging-guidelines.md`). `JSON.stringify` preserves insertion order for
 * string keys, so building the object literally is what fixes the order.
 *
 * `deviceId`, `ip` and `meta` are OMITTED when absent rather than written as
 * `null`: a `pair_failed` line has no device (that is the point of a failed
 * pairing), and emitting `"deviceId": null` would suggest a device was known.
 *
 * @param {object} input
 * @param {number} input.at Epoch milliseconds.
 * @param {string} input.event Member of {@link AUDIT_EVENTS}.
 * @param {string | null | undefined} [input.deviceId]
 * @param {string | null | undefined} [input.ip]
 * @param {unknown} [input.meta] Identifiers only; filtered by {@link sanitizeMeta}.
 * @returns {Record<string, unknown> | null}
 */
export function buildAuditLine(input) {
  const event = input?.event
  if (!isAuditEvent(event)) return null
  const at = Number.isFinite(input.at) ? input.at : Date.now()
  const line = { ts: new Date(at).toISOString(), event }
  const deviceId = input.deviceId
  if (typeof deviceId === 'string' && DEVICE_ID_PATTERN.test(deviceId)) line.deviceId = deviceId
  const ip = input.ip
  if (typeof ip === 'string' && IP_PATTERN.test(ip)) line.ip = ip
  const meta = sanitizeMeta(input.meta)
  if (meta !== undefined) line.meta = meta
  return line
}

/**
 * Create the audit writer bound to one directory.
 *
 * Every side effect is injectable (`quality-guidelines.md` §1): the directory,
 * the clock, and the error sink. A test never touches the real
 * `~/.dsh/remote-control` and never waits for a day to roll over.
 *
 * @param {object} options
 * @param {string} options.baseDir Directory holding the day files.
 * @param {() => number} [options.now] Clock in epoch milliseconds.
 * @param {number} [options.retentionDays] Days kept; defaults to `AUDIT_RETENTION_DAYS`.
 * @param {(error: Error) => void} [options.onError] Called once per failed operation.
 * @returns {{
 *   baseDir: string,
 *   fileFor: (at?: number) => string,
 *   record: (entry: { event: string, deviceId?: string, ip?: string, meta?: object }) => object | null,
 *   prune: (at?: number) => { scanned: number, deleted: string[] },
 *   exportAll: () => { body: string, files: string[], lines: number },
 *   encodeLine: (line: object) => string,
 *   stats: { written: number, failures: number, pruned: number },
 * }}
 */
export function createAudit(options = {}) {
  const baseDir = typeof options.baseDir === 'string' && options.baseDir !== '' ? options.baseDir : ''
  if (baseDir === '') {
    /* Not a silent no-op: the caller passed a path, and a missing one means the
       audit would quietly record nothing, which is the failure mode `prd.md` R5
       exists to prevent. */
    throw auditError('audit/no-directory', 'the audit directory is required')
  }
  const now = typeof options.now === 'function' ? options.now : Date.now
  const retentionDays = Number.isInteger(options.retentionDays) && options.retentionDays > 0
    ? options.retentionDays
    : AUDIT_RETENTION_DAYS
  const onError = typeof options.onError === 'function' ? options.onError : () => {}

  /** Measured counts, exposed so a test can assert "nothing was written". */
  const stats = { written: 0, failures: 0, pruned: 0 }

  /**
   * Report a failure to the sink without ever letting it escape.
   *
   * @param {string} code
   * @param {string} message
   */
  function fail(code, message) {
    stats.failures += 1
    try {
      onError(auditError(code, message))
    } catch {
      /* A throwing error sink must not break the request that triggered it. */
    }
  }

  /**
   * The day file for an instant.
   *
   * @param {number} [at] Epoch milliseconds; defaults to now.
   * @returns {string} Absolute path.
   */
  function fileFor(at) {
    const instant = Number.isFinite(at) ? at : now()
    return path.join(baseDir, `${AUDIT_FILE_PREFIX}${dayKeyOf(instant)}.jsonl`)
  }

  /** Create the directory if needed. Mode 0700 is POSIX-only and must not be fatal. */
  function ensureDir() {
    try {
      mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    } catch {
      throw auditError('audit/unwritable', 'the audit directory could not be created')
    }
  }

  /**
   * Serialize one line.
   *
   * One object per line, terminated with `\n`, no pretty-printing: JSONL is a
   * line-oriented format and a newline inside a value would split one event into
   * two unparsable halves. `JSON.stringify` escapes control characters in
   * strings, so an accepted identifier cannot contain a raw newline — but the
   * guard below makes that a property of this function rather than a property of
   * the caller's input.
   *
   * @param {object} line
   * @returns {string}
   */
  function encodeLine(line) {
    const json = JSON.stringify(line)
    /* `JSON.stringify` on an object cannot itself contain a raw CR/LF, since both
       are escaped. Belt and braces for a future non-string value. */
    return `${json.replace(/[\r\n]/g, ' ')}\n`
  }

  /**
   * Append one event.
   *
   * Returns the written line object (useful for a test and for the panel's
   * immediate echo), or `null` when nothing was written — an unknown event, or a
   * failed append. Never throws: see the module note on the failure policy.
   *
   * @param {{ event: string, deviceId?: string | null, ip?: string | null, meta?: unknown }} entry
   * @returns {Record<string, unknown> | null}
   */
  function record(entry) {
    /* The clock is read ONCE and used for both the `ts` and the day file name.
       Reading it twice would let an event at 23:59:59.999 UTC land in the file
       for the NEXT day, so `grep`ing the date in a line could stop telling you
       which file it lives in. */
    const at = now()
    let line
    try {
      line = buildAuditLine({
        at,
        event: entry?.event,
        deviceId: entry?.deviceId,
        ip: entry?.ip,
        meta: entry?.meta,
      })
    } catch {
      fail('audit/invalid-entry', 'the audit entry could not be normalized')
      return null
    }
    if (line === null) {
      /* An event outside the closed set is a programming error in the CALLER, and
         writing it would break the documented vocabulary. Refuse and report. */
      fail('audit/unknown-event', 'the audit event is not a member of the closed set')
      return null
    }

    const payload = Buffer.from(encodeLine(line), 'utf8')
    let fd
    try {
      ensureDir()
      /* `'a'` = append. O_APPEND is what makes one line atomic against another
         appender, which is why no lock and no temp file are needed here. */
      fd = openSync(fileFor(at), 'a', AUDIT_FILE_MODE)
      let written = 0
      while (written < payload.length) {
        written += writeSync(fd, payload, written, payload.length - written)
      }
      stats.written += 1
      return line
    } catch {
      fail('audit/write-failed', 'the audit line could not be appended')
      return null
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* the descriptor may already be unusable; the line is what matters */
        }
      }
    }
  }

  /**
   * Parse a day-file name into its UTC midnight, or `null` when it is not one.
   *
   * The round-trip through `Date` is the actual validation: `audit-2026-02-31`
   * matches the regex but is not a real day, and `Date` normalizes it to March
   * 3rd — a mismatch, so the name is refused. Without this a hand-created file
   * could be read as "very old" or "very new" at will.
   *
   * `.match()` and not a stateful `RegExp` method: `tests/package.test.mjs`
   * forbids shell-out-shaped source anywhere in the host half, and the stateful
   * spelling is a literal false positive in that guard (the same reason
   * `wsproxy.js` uses `.match()`). The pattern has no `/g` flag, so this is
   * exactly equivalent.
   *
   * @param {string} name Bare file name.
   * @returns {number | null} Epoch milliseconds of that UTC midnight.
   */
  function dayStartOf(name) {
    const match = name.match(AUDIT_FILE_PATTERN)
    if (match === null) return null
    const key = `${match[1]}-${match[2]}-${match[3]}`
    const at = Date.parse(`${key}T00:00:00.000Z`)
    if (!Number.isFinite(at)) return null
    if (dayKeyOf(at) !== key) return null
    return at
  }

  /**
   * Delete day files older than the retention window.
   *
   * "Older than" is measured in whole UTC days from the CURRENT day: with
   * `retentionDays: 30` and today the 45th, the files for days 1-14 are deleted
   * and day 15 onward is kept — exactly 30 day files, today included.
   *
   * Only files this module names are candidates (`audit-YYYY-MM-DD.jsonl`, real
   * date, and a regular file). Everything else in the directory is left alone,
   * including a directory that happens to match: `unlink` on a directory throws,
   * and a user's data must not be collateral damage.
   *
   * @param {number} [at] Epoch milliseconds; defaults to now.
   * @returns {{ scanned: number, deleted: string[] }}
   */
  function prune(at) {
    const instant = Number.isFinite(at) ? at : now()
    /* Cut-off at the START of the oldest kept day. A file dated exactly that day
       is inside the window and stays. */
    const cutoff = instant - (retentionDays - 1) * DAY_MS
    const oldestKept = Date.parse(`${dayKeyOf(cutoff)}T00:00:00.000Z`)

    let names
    try {
      names = readdirSync(baseDir)
    } catch (error) {
      /* A missing directory is the first run, not a failure. */
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        return { scanned: 0, deleted: [] }
      }
      fail('audit/unreadable', 'the audit directory could not be read')
      return { scanned: 0, deleted: [] }
    }

    let scanned = 0
    const deleted = []
    for (const name of names) {
      const dayStart = dayStartOf(name)
      if (dayStart === null) continue
      scanned += 1
      if (dayStart >= oldestKept) continue
      const target = path.join(baseDir, name)
      try {
        /* Re-check that it is a regular file: `unlink` on a directory throws, but
           checking first means one bad entry does not abort the whole sweep. */
        if (!statSync(target).isFile()) continue
        unlinkSync(target)
        deleted.push(name)
        stats.pruned += 1
      } catch {
        /* A file removed between the listing and now, or one this process may not
           delete: keep going, the rest of the sweep is still worth doing. */
      }
    }
    return { scanned, deleted }
  }

  /**
   * Concatenate every retained day file into one JSONL body.
   *
   * Files are read in day order (the name pattern sorts chronologically, so a
   * plain sort is a time sort). Each file's content is normalized to end with a
   * newline before being joined, because a hand-truncated final line would
   * otherwise glue the next day's first line onto it and produce one unparsable
   * line instead of one skipped one.
   *
   * Lines that are not themselves valid JSON objects are DROPPED rather than
   * relayed: the export's contract is "one valid JSON object per line", and
   * shipping a corrupt line would make the consumer's parser fail on data the
   * user cannot fix.
   *
   * @returns {{ body: string, files: string[], lines: number }}
   */
  function exportAll() {
    let names
    try {
      names = readdirSync(baseDir)
    } catch {
      return { body: '', files: [], lines: 0 }
    }
    const dayFiles = names
      .filter((name) => dayStartOf(name) !== null)
      .sort()

    const files = []
    const lines = []
    for (const name of dayFiles) {
      let raw
      try {
        raw = readFileSync(path.join(baseDir, name), 'utf8')
      } catch {
        /* An unreadable day file is skipped; the rest of the export is still
           worth delivering. The missing file is visible by its absence in
           `files`. */
        continue
      }
      files.push(name)
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
          lines.push(trimmed)
        } catch {
          /* a truncated or hand-edited line: dropped, not relayed */
        }
      }
    }

    const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`
    return { body, files, lines: lines.length }
  }

  /**
   * A read-side count per event, for the panel's summary row.
   *
   * Deliberately COUNTS and timespans, never event details: the panel's job here
   * is "how much activity has been recorded, and over what window", and shipping
   * the events themselves would put the trail into a JSON response the browser
   * parses — a second copy of the data, in a place with a different lifetime.
   * The full trail has exactly one reader-facing path: the loopback export.
   *
   * @returns {{
   *   retentionDays: number,
   *   files: number,
   *   lines: number,
   *   firstDay: string | null,
   *   lastDay: string | null,
   *   counts: Record<string, number>,
   *   invalidLines: number,
   * }}
   */
  function summarize() {
    let names
    try {
      names = readdirSync(baseDir)
    } catch {
      return {
        retentionDays,
        files: 0,
        lines: 0,
        firstDay: null,
        lastDay: null,
        counts: zeroCounts(),
        invalidLines: 0,
      }
    }

    const days = names
      .filter((name) => dayStartOf(name) !== null)
      .sort()
    const counts = zeroCounts()
    let lines = 0
    let invalidLines = 0
    for (const name of days) {
      let raw
      try {
        raw = readFileSync(path.join(baseDir, name), 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let parsed
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          invalidLines += 1
          continue
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          invalidLines += 1
          continue
        }
        /* Counted under `unknown` when the event is outside the closed set: a
           hand-edited or future line must not create an unbounded key space in
           this object. */
        const event = isAuditEvent(parsed.event) ? parsed.event : 'unknown'
        counts[event] = (counts[event] ?? 0) + 1
        lines += 1
      }
    }

    return {
      retentionDays,
      files: days.length,
      lines,
      firstDay: days.length === 0 ? null : days[0].slice(AUDIT_FILE_PREFIX.length, -'.jsonl'.length),
      lastDay: days.length === 0 ? null : days[days.length - 1].slice(AUDIT_FILE_PREFIX.length, -'.jsonl'.length),
      counts,
      invalidLines,
    }
  }

  /** A fresh zeroed counter for every member of the closed set. */
  function zeroCounts() {
    const counts = {}
    for (const event of AUDIT_EVENTS) counts[event] = 0
    return counts
  }

  return {
    baseDir,
    retentionDays,
    fileFor,
    record,
    prune,
    exportAll,
    summarize,
    encodeLine,
    stats,
  }
}
