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
  sanitizeMeta,
} from '../src/host/audit.js'
import { AUDIT_RETENTION_DAYS } from '../src/host/constants.js'
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
