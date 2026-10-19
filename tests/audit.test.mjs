/**
 * The audit trail: line shape, retention, export, and the content ban.
 *
 * `prd.md` D5 and `logging-guidelines.md` both say the same thing from two
 * directions: record the ACTION, never the content. The tests below attack that
 * from the outside — a caller who passes a message body, a tool argument, a token
 * or a cookie must end up with a line that contains none of them.
 *
 * Every test binds the writer to a temp directory and pins the clock, so nothing
 * here reads or writes the real `~/.dsh/remote-control` and nothing waits for a
 * day to roll over.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  AUDIT_EVENTS,
  META_KEYS,
  buildAuditLine,
  createAudit,
  dayKeyOf,
  isAuditEvent,
  parseAuditCursor,
  parseAuditLimit,
  projectAuditRecord,
  sanitizeMeta,
} from '../src/host/audit.js'
import { AUDIT_EVENTS_MAX_PAGE, AUDIT_EVENTS_PAGE_SIZE, AUDIT_RETENTION_DAYS } from '../src/host/constants.js'
import { cleanupDir, makeTempDir } from './helpers.mjs'

/** A fixed instant: 2026-10-17T03:04:43.000Z, the same one the other suites use. */
const AT = Date.UTC(2026, 9, 17, 3, 4, 43)

/** An audit writer bound to a temp dir with a movable clock. */
function makeAudit(options = {}) {
  const dir = makeTempDir()
  const clock = { now: options.at ?? AT }
  const errors = []
  const audit = createAudit({
    baseDir: dir,
    now: () => clock.now,
    retentionDays: options.retentionDays,
    onError: (error) => errors.push(error),
  })
  return { audit, dir, clock, errors }
}

/** Read one day file as lines. */
function readLines(dir, at) {
  const file = path.join(dir, `audit-${dayKeyOf(at)}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
}

/* ------------------------------------------------------------------ *
 * The closed event set
 * ------------------------------------------------------------------ */

test('the event set is exactly the documented nine, in the documented order', () => {
  /* A closed set is a security property here, not a style choice: it is what
     stops a future caller from inventing `tool_output` and putting arguments in
     the trail. `pair_failed` is the stage-4 addition. */
  assert.deepEqual(AUDIT_EVENTS, [
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
  assert.equal(Object.isFrozen(AUDIT_EVENTS), true, 'the set cannot be mutated at runtime')
})

test('isAuditEvent accepts only members and never throws', () => {
  for (const event of AUDIT_EVENTS) assert.equal(isAuditEvent(event), true, event)
  for (const value of ['message', 'PAIR', '', null, undefined, 0, {}, [], 'pair ']) {
    assert.equal(isAuditEvent(value), false, String(value))
  }
})

/* ------------------------------------------------------------------ *
 * Line shape — exact, and in a fixed field order
 * ------------------------------------------------------------------ */

test('a recorded line has exactly the documented fields, in the documented order', () => {
  const { audit, dir } = makeAudit()
  try {
    const line = audit.record({
      event: 'send_message',
      deviceId: 'dev_abc',
      ip: '192.168.1.7',
      meta: { sessionId: 'sess_1' },
    })

    assert.deepEqual(line, {
      ts: '2026-10-17T03:04:43.000Z',
      event: 'send_message',
      deviceId: 'dev_abc',
      ip: '192.168.1.7',
      meta: { sessionId: 'sess_1' },
    })
    /* Key ORDER matters too: every line in every file must have the same shape so
       `head -1` describes the file. */
    assert.deepEqual(Object.keys(line), ['ts', 'event', 'deviceId', 'ip', 'meta'])

    const raw = readLines(dir, AT)
    assert.equal(raw.length, 1)
    assert.equal(raw[0], JSON.stringify(line), 'the file holds exactly that object, one line')
    assert.ok(raw[0].endsWith('\n') === false, 'split on \\n leaves no trailing empty element')
    /* And the raw file ends with a newline, so appending another line is safe. */
    assert.ok(readFileSync(path.join(dir, `audit-${dayKeyOf(AT)}.jsonl`), 'utf8').endsWith('\n'))
  } finally {
    cleanupDir(dir)
  }
})

test('ts is ISO-8601 UTC, derived from the injected clock', () => {
  const { audit, dir, clock } = makeAudit()
  try {
    clock.now = Date.UTC(2026, 11, 31, 23, 59, 59, 999)
    const line = audit.record({ event: 'connect', deviceId: 'dev_1' })
    assert.equal(line.ts, '2026-12-31T23:59:59.999Z')
    assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    /* The day file and the timestamp agree, which is what makes `grep`ing a date
       tell you which file the line lives in. */
    assert.ok(existsSync(path.join(dir, 'audit-2026-12-31.jsonl')))
  } finally {
    cleanupDir(dir)
  }
})

test('a line is written to the UTC day file, not a local-time one', () => {
  /* 00:30 UTC on the 18th is the 18th, whatever the host's local zone says. A
     local-date file name would split one UTC day across two files at a DST
     boundary, and the retention math is in UTC days. */
  const { audit, dir } = makeAudit({ at: Date.UTC(2026, 9, 18, 0, 30, 0) })
  try {
    audit.record({ event: 'connect', deviceId: 'dev_1' })
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.jsonl')), ['audit-2026-10-18.jsonl'])
  } finally {
    cleanupDir(dir)
  }
})

test('deviceId, ip and meta are omitted when absent rather than written as null', () => {
  /* A `pair_failed` has no device by definition; emitting `"deviceId": null`
     would suggest one was known. */
  const { audit, dir } = makeAudit()
  try {
    const line = audit.record({ event: 'pair_failed', ip: '192.168.1.9' })
    assert.deepEqual(line, { ts: '2026-10-17T03:04:43.000Z', event: 'pair_failed', ip: '192.168.1.9' })
    assert.ok(!('deviceId' in line))
    assert.ok(!('meta' in line))
  } finally {
    cleanupDir(dir)
  }
})

test('an event outside the closed set is refused, not written', () => {
  const { audit, dir, errors } = makeAudit()
  try {
    const line = audit.record({ event: 'tool_output', deviceId: 'dev_1', meta: { body: 'secret' } })
    assert.equal(line, null)
    assert.deepEqual(readdirSync(dir), [], 'nothing was created')
    assert.equal(audit.stats.written, 0)
    assert.equal(errors.length, 1, 'and the refusal is reported rather than silent')
    assert.equal(errors[0].code, 'audit/unknown-event')
  } finally {
    cleanupDir(dir)
  }
})

/* ------------------------------------------------------------------ *
 * The content ban (`prd.md` D5) — the point of the module
 * ------------------------------------------------------------------ */

test('a message body never reaches the file, however the caller passes it', () => {
  /* The realistic mistake is not malice: a handler has the parsed body in scope
     and passes `{ ...request }` into the audit call. Four spellings of the same
     leak, and the file must hold none of them. */
  const { audit, dir } = makeAudit()
  const body = 'here is my API key: sk-live-abcdef1234567890'
  try {
    audit.record({
      event: 'send_message',
      deviceId: 'dev_1',
      ip: '192.168.1.7',
      /* (a) an explicit content field alongside the documented ones */
      body,
      content: body,
      text: body,
      /* (b) a `meta` with forbidden keys */
      meta: { body, content: body, args: body, token: body, cookie: body },
    })
    /* (c) a `meta` with a FORBIDDEN VALUE under an allowed key, and (d) a real
       identifier next to it — only the identifier may survive. */
    audit.record({
      event: 'send_message',
      deviceId: 'dev_1',
      meta: { sessionId: body, turnId: 'turn_42' },
    })
    /* (e) an object nested inside meta, which is not an identifier at all */
    audit.record({
      event: 'send_message',
      deviceId: 'dev_1',
      meta: { requestId: { nested: body } },
    })

    const raw = readFileSync(path.join(dir, `audit-${dayKeyOf(AT)}.jsonl`), 'utf8')
    assert.ok(!raw.includes('sk-live'), 'no message content in the trail')
    assert.ok(!raw.includes('API key'))

    const lines = raw.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    assert.equal(lines.length, 3)

    /* (a)+(b): only the three documented fields survive; `meta` is empty and
       therefore absent. */
    assert.deepEqual(Object.keys(lines[0]), ['ts', 'event', 'deviceId', 'ip'])
    /* (c)+(d): the prompt-shaped `sessionId` was dropped, the real `turnId` kept. */
    assert.deepEqual(lines[1].meta, { turnId: 'turn_42' })
    /* (e): a nested object is not an identifier. */
    assert.equal(lines[2].meta, undefined)
  } finally {
    cleanupDir(dir)
  }
})

test('sanitizeMeta keeps identifiers and drops everything else', () => {
  assert.deepEqual(
    sanitizeMeta({ sessionId: 'sess_1', count: 3, status: 200 }),
    { sessionId: 'sess_1', count: 3, status: 200 },
  )
  /* Forbidden keys, at any value. */
  assert.equal(sanitizeMeta({ body: 'x', content: 'x', args: 'x', token: 'x', cookie: 'x' }), undefined)
  /* Allowed keys, forbidden values. */
  assert.equal(sanitizeMeta({ sessionId: 'a message with spaces' }), undefined)
  assert.equal(sanitizeMeta({ sessionId: 'line\nbreak' }), undefined)
  assert.equal(sanitizeMeta({ sessionId: 'x'.repeat(121) }), undefined)
  assert.equal(sanitizeMeta({ count: 1.5 }), undefined, 'a float is not an identifier')
  assert.equal(sanitizeMeta({ count: Number.NaN }), undefined, 'NaN does not survive JSON')
  assert.equal(sanitizeMeta({ count: Number.POSITIVE_INFINITY }), undefined)
  /* Non-objects. */
  for (const value of [null, undefined, 'text', 42, [], true]) {
    assert.equal(sanitizeMeta(value), undefined, String(value))
  }
  /* And the allowed-key list itself is identifiers only — a future addition named
     `body` would make every other guard moot. */
  for (const key of META_KEYS) {
    assert.ok(!/body|content|text|args|argument|prompt|message|token|cookie|secret/i.test(key), key)
  }
})

test('a token-shaped or cookie-shaped value cannot become an audit value', () => {
  /* The realistic leak: a caller confuses `token` with `deviceId`, or puts a
     cookie value where an address goes. `deviceId` therefore requires the
     documented `dev_` prefix and `ip` requires address characters — so a bare
     43-character base64url token is refused in BOTH slots, and refused in `meta`
     by the identifier pattern plus the key whitelist. */
  const token = 'A'.repeat(43)
  const { audit, dir } = makeAudit()
  try {
    /* (a) A bare token in the deviceId slot: not a device id, dropped. */
    const bare = audit.record({ event: 'connect', deviceId: token, ip: token, meta: { sessionId: token } })
    assert.ok(!JSON.stringify(bare).includes(token), 'no token-shaped value in the line')
    assert.ok(!('deviceId' in bare), 'a bare token is not a device id')
    assert.ok(!('ip' in bare), 'and it is not an address')

    /* (b) A token under a `dev_` prefix IS a device id shape, and is allowed —
       that is intentional: device ids are not secrets (`design.md` §5), the
       token is. The guarantee is that the TOKEN never appears where it would
       be one. */
    const prefixed = audit.record({ event: 'connect', deviceId: `dev_${token}` })
    assert.equal(prefixed.deviceId, `dev_${token}`)

    /* (c) Addresses, in every spelling this hop actually sees, are accepted. */
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.7', '[::1]']) {
      assert.equal(audit.record({ event: 'connect', deviceId: 'dev_1', ip }).ip, ip, ip)
    }
  } finally {
    cleanupDir(dir)
  }
})

test('buildAuditLine is pure and refuses an unknown event', () => {
  assert.equal(buildAuditLine({ at: AT, event: 'nope' }), null)
  assert.equal(buildAuditLine({ at: AT, event: 'revoke' }).event, 'revoke')
  /* `at` is optional, and a missing one falls back to the clock rather than
     producing an `Invalid Date`. */
  const line = buildAuditLine({ event: 'revoke' })
  assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T/)
})

/* ------------------------------------------------------------------ *
 * Retention — expired day files only
 * ------------------------------------------------------------------ */

test('prune deletes only day files older than the retention window', () => {
  const { audit, dir, clock } = makeAudit()
  try {
    /* Day 100 is "now"; the window keeps days 71-100 (30 days, today included). */
    const today = Date.UTC(2026, 9, 17)
    const day = (offset) => new Date(today - offset * 86_400_000).toISOString().slice(0, 10)

    mkdirSync(dir, { recursive: true })
    /* Inside the window: kept. The oldest kept day is exactly `retentionDays - 1`
       back, which is the boundary the off-by-one would break. */
    writeFileSync(path.join(dir, `audit-${day(0)}.jsonl`), '')
    writeFileSync(path.join(dir, `audit-${day(29)}.jsonl`), '')
    /* Outside the window: deleted. */
    writeFileSync(path.join(dir, `audit-${day(30)}.jsonl`), '')
    writeFileSync(path.join(dir, `audit-${day(400)}.jsonl`), '')

    clock.now = today + 3_600_000
    const outcome = audit.prune()

    assert.deepEqual(outcome.deleted.sort(), [`audit-${day(30)}.jsonl`, `audit-${day(400)}.jsonl`].sort())
    assert.equal(outcome.scanned, 4)
    assert.equal(existsSync(path.join(dir, `audit-${day(0)}.jsonl`)), true, 'today is kept')
    assert.equal(existsSync(path.join(dir, `audit-${day(29)}.jsonl`)), true, 'the boundary day is kept')
    assert.equal(existsSync(path.join(dir, `audit-${day(30)}.jsonl`)), false)
  } finally {
    cleanupDir(dir)
  }
})

test('prune never deletes a file it did not name', () => {
  /* Deleting a user's data because it shared a directory would be far worse than
     a too-long trail. Each of these looks like a day file but is not one. */
  const { audit, dir, clock } = makeAudit()
  try {
    const today = Date.UTC(2026, 9, 17)
    const old = new Date(today - 400 * 86_400_000).toISOString().slice(0, 10)
    mkdirSync(dir, { recursive: true })

    const keep = [
      'devices.json',
      'notes.txt',
      'audit-2026-13-01.jsonl',        /* month 13: matched by the pattern, not a date */
      'audit-2026-02-31.jsonl',        /* normalizes to March 3rd: refused */
      `audit-${old}.jsonl.backup`,     /* wrong suffix */
      `prefix-audit-${old}.jsonl`,     /* wrong prefix */
      'audit-.jsonl',
      'audit-today.jsonl',
    ]
    for (const name of keep) writeFileSync(path.join(dir, name), 'x')
    /* A DIRECTORY named like a day file must survive too: `unlink` on it throws,
       and the sweep must not treat that as an error worth aborting for. */
    mkdirSync(path.join(dir, `audit-${old}.jsonl-dir`))

    clock.now = today
    const outcome = audit.prune()

    assert.deepEqual(outcome.deleted, [])
    for (const name of keep) assert.equal(existsSync(path.join(dir, name)), true, `${name} survives`)
    assert.equal(existsSync(path.join(dir, `audit-${old}.jsonl-dir`)), true)
  } finally {
    cleanupDir(dir)
  }
})

test('prune tolerates a directory that does not exist yet', () => {
  /* First run: `apply` prunes before anything has ever been written. */
  const { audit } = makeAudit()
  assert.deepEqual(audit.prune(), { scanned: 0, deleted: [] })
})

test('the default retention window is the documented 30 days', () => {
  assert.equal(AUDIT_RETENTION_DAYS, 30, 'prd.md R5 / design.md §6 fix this number')
  const { audit } = makeAudit()
  assert.equal(audit.retentionDays, 30)
})

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

test('export concatenates every retained day file in day order, valid JSONL per line', () => {
  const { audit, dir, clock } = makeAudit()
  try {
    const day1 = Date.UTC(2026, 9, 15, 12, 0, 0)
    const day2 = Date.UTC(2026, 9, 16, 12, 0, 0)
    clock.now = day1
    audit.record({ event: 'pair', deviceId: 'dev_1', ip: '192.168.1.7' })
    audit.record({ event: 'send_message', deviceId: 'dev_1', meta: { sessionId: 's1' } })
    clock.now = day2
    audit.record({ event: 'revoke', deviceId: 'dev_1', ip: '127.0.0.1' })

    const exported = audit.exportAll()
    assert.equal(exported.lines, 3)
    assert.deepEqual(exported.files, ['audit-2026-10-15.jsonl', 'audit-2026-10-16.jsonl'])
    assert.ok(exported.body.endsWith('\n'), 'the body ends with a newline')

    const lines = exported.body.split('\n').filter((line) => line !== '')
    assert.equal(lines.length, 3)
    /* Every line parses, and the ORDER is chronological. */
    const events = lines.map((line) => JSON.parse(line).event)
    assert.deepEqual(events, ['pair', 'send_message', 'revoke'])

    /* The export is the audit: no content, and no key outside the documented set. */
    for (const line of lines) {
      const parsed = JSON.parse(line)
      assert.deepEqual(
        Object.keys(parsed).filter((key) => !['ts', 'event', 'deviceId', 'ip', 'meta'].includes(key)),
        [],
      )
    }
  } finally {
    cleanupDir(dir)
  }
})

test('export drops a corrupt line instead of relaying it', () => {
  /* A hand-edited or truncated file must not make the download unparsable: the
     contract is "one valid JSON object per line". */
  const { audit, dir } = makeAudit()
  try {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `audit-${dayKeyOf(AT)}.jsonl`)
    writeFileSync(
      file,
      `${JSON.stringify({ ts: '2026-10-17T00:00:00.000Z', event: 'pair' })}\n`
        + 'not json at all\n'
        + '{"broken": \n'
        + `${JSON.stringify({ ts: '2026-10-17T00:01:00.000Z', event: 'connect' })}\n`
        + '[1,2,3]\n'
        + 'null\n',
    )

    const exported = audit.exportAll()
    assert.equal(exported.lines, 2, 'the two valid objects survived, nothing else')
    const events = exported.body.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line).event)
    assert.deepEqual(events, ['pair', 'connect'])
  } finally {
    cleanupDir(dir)
  }
})

test('export of an empty or missing directory is an empty body, not an error', () => {
  const { audit } = makeAudit()
  assert.deepEqual(audit.exportAll(), { body: '', files: [], lines: 0 })
})

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

test('summarize counts events per type and never returns their details', () => {
  const { audit, dir } = makeAudit()
  try {
    audit.record({ event: 'pair', deviceId: 'dev_1', ip: '192.168.1.7' })
    audit.record({ event: 'connect', deviceId: 'dev_1', ip: '192.168.1.7' })
    audit.record({ event: 'connect', deviceId: 'dev_1', ip: '192.168.1.7' })
    audit.record({ event: 'pair_failed', ip: '192.168.1.9' })

    const summary = audit.summarize()
    assert.equal(summary.lines, 4)
    assert.equal(summary.files, 1)
    assert.equal(summary.counts.connect, 2)
    assert.equal(summary.counts.pair, 1)
    assert.equal(summary.counts.pair_failed, 1)
    assert.equal(summary.counts.revoke, 0, 'every member is present, zeroed')
    assert.equal(Object.keys(summary.counts).length, AUDIT_EVENTS.length)
    assert.equal(summary.retentionDays, 30)
    assert.equal(summary.firstDay, '2026-10-17')
    assert.equal(summary.lastDay, '2026-10-17')

    /* No addresses, no ids, no timestamps: a summary is counts. */
    const serialized = JSON.stringify(summary)
    assert.ok(!serialized.includes('192.168'))
    assert.ok(!serialized.includes('dev_1'))
    assert.ok(!serialized.includes('2026-10-17T'))
  } finally {
    cleanupDir(dir)
  }
})

/* ------------------------------------------------------------------ *
 * Filesystem failures
 * ------------------------------------------------------------------ */

test('record never throws: an unwritable directory is a counted failure', () => {
  const dir = makeTempDir()
  const blocked = path.join(dir, 'blocked')
  const errors = []
  try {
    /* A FILE where the directory should be. */
    writeFileSync(blocked, 'x')
    const audit = createAudit({
      baseDir: blocked,
      now: () => AT,
      onError: (error) => errors.push(error),
    })

    assert.doesNotThrow(() => audit.record({ event: 'connect', deviceId: 'dev_1' }))
    assert.equal(audit.record({ event: 'connect', deviceId: 'dev_1' }), null)
    assert.equal(audit.stats.written, 0)
    assert.ok(audit.stats.failures >= 1)
    assert.ok(errors.some((error) => error.code === 'audit/write-failed'))
  } finally {
    cleanupDir(dir)
  }
})

test('a throwing error sink cannot break the writer', () => {
  const dir = makeTempDir()
  try {
    const audit = createAudit({
      baseDir: path.join(dir, 'nested', 'deep'),
      now: () => AT,
      onError: () => { throw new Error('sink is broken') },
    })
    /* The success path must still work with a hostile sink. */
    assert.notEqual(audit.record({ event: 'pair', deviceId: 'dev_1' }), null)
    /* And the failure path must not rethrow through the sink. */
    const blocked = createAudit({
      baseDir: path.join(path.join(dir, 'nested', 'deep'), 'audit-2026-10-17.jsonl'),
      now: () => AT,
      onError: () => { throw new Error('sink is broken') },
    })
    assert.doesNotThrow(() => blocked.record({ event: 'pair' }))
  } finally {
    cleanupDir(dir)
  }
})

test('createAudit refuses to build without a directory', () => {
  /* A writer with nowhere to write would silently record nothing, which is the
     failure `prd.md` R5 exists to prevent. */
  assert.throws(() => createAudit({}), (error) => error.code === 'audit/no-directory')
  assert.throws(() => createAudit({ baseDir: '' }), (error) => error.code === 'audit/no-directory')
})

test('appends accumulate instead of replacing, and each line stays intact', () => {
  /* O_APPEND + one write per line is what makes a JSONL file safe to append to
     from a live process. Atomic-replace (`store.js`'s technique) would rewrite the
     whole file on every event. */
  const { audit, dir, clock } = makeAudit()
  try {
    for (let index = 0; index < 50; index += 1) {
      clock.now = AT + index
      audit.record({ event: 'connect', deviceId: `dev_${String(index)}` })
    }
    const lines = readLines(dir, AT)
    assert.equal(lines.length, 50)
    for (const [index, line] of lines.entries()) {
      assert.equal(JSON.parse(line).deviceId, `dev_${String(index)}`, 'order preserved, no interleaving')
    }
    assert.equal(audit.stats.written, 50)
  } finally {
    cleanupDir(dir)
  }
})

/* ------------------------------------------------------------------ *
 * The read side: projection, ordering and lossless paging
 *
 * `prd.md` R4/R5, `design.md` §2.2. Three properties are load-bearing, and each
 * gets its own assertion because each has a distinct failure mode:
 *
 *   1. the projection (a hand-edited file must not be able to add a key),
 *   2. the ORDER (newest first, across day files),
 *   3. the cursor (every record exactly once, including two in one millisecond).
 * ------------------------------------------------------------------ */

/** Write a hand-made day file, so a test can produce lines no writer would emit. */
function writeDayFile(dir, at, lines) {
  mkdirSync(dir, { recursive: true })
  const body = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)) + '\n')
    .join('')
  writeFileSync(path.join(dir, `audit-${dayKeyOf(at)}.jsonl`), body)
}

/** Append `count` events one millisecond apart, oldest first. */
function seedEvents(audit, clock, count, event = 'connect') {
  for (let index = 0; index < count; index += 1) {
    clock.now = AT + index
    audit.record({
      event,
      deviceId: `dev_${String(index)}`,
      ip: '192.168.1.7',
      meta: { sessionId: `s${String(index)}` },
    })
  }
}

/** Follow `nextBefore` to the end and return the concatenation plus every page. */
function readAll(audit, options = {}) {
  const pages = []
  let before
  /* A bounded loop: a cursor that never reaches `null` must fail the test rather
     than hang the suite. */
  for (let guard = 0; guard < 100; guard += 1) {
    const page = audit.readEvents({ limit: options.limit, action: options.action, before })
    pages.push(page)
    if (page.nextBefore === null) return { pages, events: pages.flatMap((entry) => entry.events) }
    before = page.nextBefore
  }
  throw new Error('paging never terminated')
}

test('readEvents returns the newest record first, projected onto four fields', () => {
  const { audit, dir, clock } = makeAudit()
  try {
    seedEvents(audit, clock, 3)
    const page = audit.readEvents({})
    assert.deepEqual(page.events.map((event) => event.deviceId), ['dev_2', 'dev_1', 'dev_0'])
    assert.equal(page.nextBefore, null, 'a short trail has nothing more to fetch')
    /* `prd.md` D5: exactly the four documented fields, and NOT the `meta` the writer
       stored beside them. */
    assert.deepEqual(Object.keys(page.events[0]), ['ts', 'event', 'deviceId', 'ip'])
    assert.deepEqual(page.events[0], {
      ts: '2026-10-17T03:04:43.002Z',
      event: 'connect',
      deviceId: 'dev_2',
      ip: '192.168.1.7',
    })
  } finally {
    cleanupDir(dir)
  }
})

test('a cursor pages the trail without repeating or skipping a record', () => {
  const { audit, dir, clock } = makeAudit()
  try {
    seedEvents(audit, clock, 5)
    const { pages, events } = readAll(audit, { limit: 2 })

    assert.deepEqual(pages.map((page) => page.events.length), [2, 2, 1])
    assert.deepEqual(pages.map((page) => page.nextBefore === null), [false, false, true],
      'only the last page may say there is nothing more')
    assert.deepEqual(events.map((event) => event.deviceId), ['dev_4', 'dev_3', 'dev_2', 'dev_1', 'dev_0'])
    assert.equal(new Set(events.map((event) => event.deviceId)).size, 5, 'every record exactly once')
  } finally {
    cleanupDir(dir)
  }
})

test('two records in the same millisecond are neither repeated nor skipped', () => {
  /* `prd.md` constraint 5, and the reason the cursor is `ts.seq` rather than a bare
     timestamp: three records share one instant, so a timestamp-only cursor puts all
     three on one side of the boundary — the first page repeats one, or the second
     page loses one, depending on the comparison. */
  const { audit, dir } = makeAudit()
  try {
    const stamp = new Date(AT).toISOString()
    writeDayFile(dir, AT, [
      { ts: stamp, event: 'pair', deviceId: 'dev_a' },
      { ts: stamp, event: 'connect', deviceId: 'dev_b' },
      { ts: stamp, event: 'revoke', deviceId: 'dev_c' },
    ])

    const { pages, events } = readAll(audit, { limit: 1 })
    assert.deepEqual(pages.map((page) => page.events.length), [1, 1, 1])
    /* Newest first within one millisecond = the order they were appended in,
       reversed; that is the ONLY order that lets the cursor resume. */
    assert.deepEqual(events.map((event) => event.deviceId), ['dev_c', 'dev_b', 'dev_a'])
    assert.deepEqual(events.map((event) => event.event), ['revoke', 'connect', 'pair'])
  } finally {
    cleanupDir(dir)
  }
})

test('paging crosses a day boundary in one continuous order', () => {
  const { audit, dir, clock } = makeAudit()
  try {
    clock.now = AT
    audit.record({ event: 'pair', deviceId: 'dev_old1' })
    audit.record({ event: 'connect', deviceId: 'dev_old2' })
    clock.now = AT + 86_400_000
    audit.record({ event: 'revoke', deviceId: 'dev_new1' })
    audit.record({ event: 'disconnect', deviceId: 'dev_new2' })

    const { events } = readAll(audit, { limit: 1 })
    assert.deepEqual(events.map((event) => event.deviceId), ['dev_new2', 'dev_new1', 'dev_old2', 'dev_old1'])
  } finally {
    cleanupDir(dir)
  }
})

test('the action filter is applied by the reader, before paging', () => {
  /* `prd.md` D4/R6. Filtering after paging would hand back pages that are mostly —
     or entirely — empty while matching records still exist further back, so the
     panel's 「加载更多」 would appear to do nothing. */
  const { audit, dir, clock } = makeAudit()
  try {
    const pattern = ['pair', 'connect', 'pair', 'revoke', 'pair', 'connect']
    pattern.forEach((event, index) => {
      clock.now = AT + index
      audit.record({ event, deviceId: `dev_${String(index)}` })
    })

    const { pages, events } = readAll(audit, { limit: 2, action: 'pair' })
    assert.deepEqual(events.map((event) => event.event), ['pair', 'pair', 'pair'])
    assert.deepEqual(events.map((event) => event.deviceId), ['dev_4', 'dev_2', 'dev_0'])
    assert.deepEqual(pages.map((page) => page.events.length), [2, 1], 'every page is full until the end')
  } finally {
    cleanupDir(dir)
  }
})

test('an unknown action is refused, not answered with an empty page', () => {
  /* An empty list would be indistinguishable from "that action never happened",
     which is the reassuring-and-wrong answer `quality-guidelines.md` §5 forbids. */
  const { audit } = makeAudit()
  assert.throws(
    () => audit.readEvents({ action: 'tool_output' }),
    (error) => error.code === 'audit/invalid-action',
  )
})

test('the read projection drops meta and every hand-added key', () => {
  /* `prd.md` D5 + constraint 2: the writer already refuses free text, but a day file
     is editable text, so the READ path re-projects every line. A record carrying
     `meta: { text }`, a `body` and a 43-character token therefore comes back as four
     fields with none of that in it. */
  const { audit, dir } = makeAudit()
  const token = 'A'.repeat(43)
  try {
    writeDayFile(dir, AT, [
      `{"ts":"2026-10-17T03:04:43.000Z","event":"pair","deviceId":"dev_p1","ip":"192.168.1.7",`
        + `"meta":{"text":"hunter2","sessionId":"sess_1"},"body":"a whole prompt","token":"${token}"}`,
    ])

    const page = audit.readEvents({})
    assert.equal(page.events.length, 1)
    assert.deepEqual(page.events[0], {
      ts: '2026-10-17T03:04:43.000Z',
      event: 'pair',
      deviceId: 'dev_p1',
      ip: '192.168.1.7',
    })
    const serialized = JSON.stringify(page)
    for (const leak of ['hunter2', 'a whole prompt', token, 'meta', 'body', 'sessionId']) {
      assert.ok(!serialized.includes(leak), `${leak} must not reach the reader`)
    }
  } finally {
    cleanupDir(dir)
  }
})

test('an unusable line is skipped, and an unusable field is dropped', () => {
  const { audit, dir } = makeAudit()
  const token = 'B'.repeat(43)
  try {
    writeDayFile(dir, AT, [
      'not json at all',
      '{"ts": 1760000000000, "event": "pair"}',
      '{"ts": "not a date", "event": "pair"}',
      '{"ts": "2026-10-17T03:04:43.000Z", "event": "tool_output"}',
      `{"ts":"2026-10-17T03:04:44.000Z","event":"connect","ip":"${token}"}`,
      `{"ts":"2026-10-17T03:04:45.000Z","event":"revoke","deviceId":"${token}"}`,
      '[1,2,3]',
      'null',
    ])

    const page = audit.readEvents({})
    /* Only the two records with a usable `ts` and a closed-set `event` survive. */
    assert.deepEqual(page.events.map((event) => event.event), ['revoke', 'connect'])
    /* And the token-shaped values did not take the credential slots`. */
    assert.ok(!('deviceId' in page.events[0]), 'a bare token is not a device id')
    assert.ok(!('ip' in page.events[1]), 'a bare token is not an address')
    assert.ok(!JSON.stringify(page).includes(token))
  } finally {
    cleanupDir(dir)
  }
})

test('the page size is validated, and an absent one is the documented default', () => {
  assert.equal(AUDIT_EVENTS_PAGE_SIZE, 50, 'prd.md R5 / design.md §2.1 fix this number')
  assert.equal(AUDIT_EVENTS_MAX_PAGE, 200)
  assert.equal(parseAuditLimit(undefined), 50)
  assert.equal(parseAuditLimit(null), 50)
  assert.equal(parseAuditLimit(''), 50)
  assert.equal(parseAuditLimit('2'), 2)
  assert.equal(parseAuditLimit('200'), 200)
  /* `Number('0x10')` is 16 and `Number('')` is 0, so the conversion is never the
     validator. */
  for (const bad of ['0', '201', '-1', 'abc', '2.5', '0x10', ' 50 ', '1e3', '050x']) {
    assert.equal(parseAuditLimit(bad), null, `${JSON.stringify(bad)} must be refused`)
  }

  const { audit, dir, clock } = makeAudit()
  try {
    seedEvents(audit, clock, 3)
    for (const limit of [0, -1, 1.5, AUDIT_EVENTS_MAX_PAGE + 1, '50', null, undefined]) {
      if (limit === null || limit === undefined) continue
      assert.throws(
        () => audit.readEvents({ limit }),
        (error) => error.code === 'audit/invalid-limit',
        String(limit),
      )
    }
    assert.equal(audit.readEvents({ limit: AUDIT_EVENTS_MAX_PAGE }).events.length, 3)
  } finally {
    cleanupDir(dir)
  }
})

test('the first page holds the documented 50 records and says more are coming', () => {
  const { audit, dir, clock } = makeAudit()
  try {
    seedEvents(audit, clock, 55)
    const first = audit.readEvents({})
    assert.equal(first.events.length, AUDIT_EVENTS_PAGE_SIZE)
    assert.notEqual(first.nextBefore, null)
    assert.equal(first.events[0].deviceId, 'dev_54', 'newest first')

    const second = audit.readEvents({ before: first.nextBefore })
    assert.equal(second.events.length, 5)
    assert.equal(second.nextBefore, null)
    const all = first.events.concat(second.events)
    assert.equal(new Set(all.map((event) => event.deviceId)).size, 55)
  } finally {
    cleanupDir(dir)
  }
})

test('a malformed cursor is refused instead of silently restarting at the top', () => {
  assert.deepEqual(parseAuditCursor('1792206283003.4'), { ts: 1792206283003, seq: 4 })
  for (const bad of ['', 'nope', '1', '1.2.3', '.2', '1.', '1e3.2', '-1.2', ' 1.2', null, undefined, 42]) {
    assert.equal(parseAuditCursor(bad), null, `${JSON.stringify(bad)} must be refused`)
  }

  const { audit, dir, clock } = makeAudit()
  try {
    seedEvents(audit, clock, 2)
    assert.throws(
      () => audit.readEvents({ before: 'nope' }),
      (error) => error.code === 'audit/invalid-cursor',
    )
    /* An EMPTY cursor is "no cursor", not an error: that is what an absent query
       parameter becomes, and the panel's first request sends none. */
    assert.equal(audit.readEvents({ before: '' }).events.length, 2)
  } finally {
    cleanupDir(dir)
  }
})

test('reading the trail writes nothing and never throws on a missing directory', () => {
  const { audit, dir, clock } = makeAudit()
  try {
    seedEvents(audit, clock, 3)
    const file = path.join(dir, `audit-${dayKeyOf(AT)}.jsonl`)
    const before = readFileSync(file, 'utf8')
    readAll(audit, { limit: 1 })
    assert.equal(readFileSync(file, 'utf8'), before, 'the read path must not touch the trail')
    assert.equal(audit.stats.written, 3, 'and must not count as a write')
  } finally {
    cleanupDir(dir)
  }

  const empty = createAudit({ baseDir: path.join(makeTempDir(), 'never-created'), now: () => AT })
  try {
    assert.deepEqual(empty.readEvents({}), { events: [], nextBefore: null })
  } finally {
    cleanupDir(path.dirname(empty.baseDir))
  }
})

test('projectAuditRecord is pure, and normalizes ts to the documented spelling', () => {
  /* Re-serializing rather than copying `ts` is what stops a hand-written spelling
     from travelling to the UI, and it gives the reader a single value to parse. */
  const record = projectAuditRecord({
    ts: '2026-10-17T05:04:43.000+02:00',
    event: 'pair',
    deviceId: 'dev_1',
    ip: '10.0.0.7',
    meta: { text: 'hunter2' },
  })
  assert.deepEqual(record, { ts: '2026-10-17T03:04:43.000Z', event: 'pair', deviceId: 'dev_1', ip: '10.0.0.7' })

  for (const bad of [null, '[1,2]', 'text', 42]) {
    assert.equal(projectAuditRecord(bad), null, String(bad))
  }
  assert.equal(projectAuditRecord({ ts: '2026-10-17T03:04:43.000Z', event: 'nope' }), null)
  assert.equal(projectAuditRecord({ event: 'pair' }), null, 'a record without ts cannot be ordered')
})

