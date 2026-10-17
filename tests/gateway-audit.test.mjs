/**
 * The audit trail as produced by the real request path.
 *
 * `audit.test.mjs` covers the writer in isolation. This suite covers the WIRING:
 * does an actual authorized remote request produce the right event, and does it
 * still carry no content when the request has a body full of content?
 *
 * The gateway binds port 0 and the upstream is a stub on port 0, so nothing here
 * touches a real listener or the real `~/.dsh`.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createAudit, dayKeyOf } from '../src/host/audit.js'
import { DEVICE_COOKIE_NAME } from '../src/host/constants.js'
import { createPairingStore } from '../src/host/pairing.js'
import { createStore } from '../src/host/store.js'
import { createDeviceToken } from '../src/host/tokens.js'
import { startGateway } from '../src/host/gateway/server.js'
import { cleanupDir, makeTempDir } from './helpers.mjs'

/** Fixed clock: 2026-10-17T03:04:43.000Z. */
const AT = Date.UTC(2026, 9, 17, 3, 4, 43)

const started = []

after(async () => {
  for (const stop of started.splice(0)) {
    try {
      await stop()
    } catch {
      /* teardown must never fail a test run */
    }
  }
})

/**
 * A gateway with a real device, a real audit writer and a stub upstream.
 *
 * @param {object} [spec]
 * @param {boolean} [spec.withAudit] Whether the gateway gets a writer at all.
 */
async function makeGateway(spec = {}) {
  const dir = makeTempDir()
  const clock = { now: AT }
  const store = createStore({ baseDir: dir, now: () => clock.now })
  const audit = createAudit({ baseDir: dir, now: () => clock.now })
  const minted = createDeviceToken()
  store.addDevice({ id: 'dev_1', name: 'iPhone · Safari', tokenHash: minted.tokenHash, ua: 'test' })

  /** Every request the upstream saw: the audit must not change what is forwarded. */
  const upstreamSaw = []
  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      upstreamSaw.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  const gateway = await startGateway({
    ctx: { effect: () => () => {}, get: () => undefined },
    store,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    now: () => clock.now,
    audit: spec.withAudit === false ? undefined : audit,
  })

  const stop = async () => {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
    cleanupDir(dir)
  }
  started.push(stop)

  return { gateway, store, audit, clock, dir, token: minted.token, upstreamSaw, stop }
}

/** Read the day's audit file as parsed lines. */
function auditLines(dir, at = AT) {
  try {
    return readFileSync(path.join(dir, `audit-${dayKeyOf(at)}.jsonl`), 'utf8')
      .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/** A request against the gateway. */
function send(spec) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: spec.port,
      method: spec.method ?? 'GET',
      path: spec.path ?? '/',
      headers: spec.headers ?? {},
      agent: false,
    }, (res) => {
      const chunks = []
      res.setEncoding('utf8')
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') }))
    })
    req.on('error', reject)
    if (spec.body !== undefined) req.write(spec.body)
    req.end()
  })
}

/** The `Host` a remote device sends. */
function lanHost(port) {
  return `192.168.1.7:${String(port)}`
}

/* ------------------------------------------------------------------ *
 * Classified actions, through the real proxy path
 * ------------------------------------------------------------------ */

test('an authorized send_message is recorded with the action and no content', async () => {
  /* The whole requirement in one test (`prd.md` R5 + D5): the ACTION is recorded,
     the message body — which really does reach the upstream — is not. */
  const { gateway, dir, token, upstreamSaw, stop } = await makeGateway()
  const prompt = 'here is my prompt with a secret sk-live-abcdef1234567890'
  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/session/prompt',
      headers: {
        host: lanHost(gateway.port),
        cookie: `${DEVICE_COOKIE_NAME}=${token}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
    })

    assert.equal(res.status, 200)
    /* The content really did reach DSH — so its absence from the audit is a
       property of the audit, not of the request never carrying it. */
    assert.equal(upstreamSaw.length, 1)
    assert.ok(upstreamSaw[0].body.includes(prompt))

    const lines = auditLines(dir)
    const message = lines.find((line) => line.event === 'send_message')
    assert.ok(message !== undefined, 'the action was recorded')
    assert.equal(message.deviceId, 'dev_1')
    assert.equal(message.ip, '127.0.0.1', 'the loopback socket peer — the honest source address')
    assert.equal(message.meta.method, 'POST')
    assert.equal(message.meta.path, '/api/session/prompt', 'the path, without its query')
    assert.equal(message.meta.sessionId, undefined, 'no session id was available, and none was invented')

    /* Nothing about the body, anywhere in the file. (The PATH legitimately
       contains the word `prompt` — that is the route's name — so the assertion is
       about the user's text, not about the word.) */
    const raw = readFileSync(path.join(dir, `audit-${dayKeyOf(AT)}.jsonl`), 'utf8')
    assert.ok(!raw.includes('sk-live'), 'no prompt content')
    assert.ok(!raw.includes('secret'))
    assert.ok(!raw.includes(prompt), 'not the prompt itself')
    assert.ok(!raw.includes(token), 'and never the device token')
  } finally {
    await stop()
  }
})

test('stop_task and approval_answer are classified and recorded', async () => {
  const { gateway, dir, token, stop } = await makeGateway()
  try {
    const cases = [
      { path: '/api/session/cancel', event: 'stop_task' },
      { path: '/api/$events/result', event: 'approval_answer' },
    ]
    for (const entry of cases) {
      const res = await send({
        port: gateway.port,
        method: 'POST',
        path: entry.path,
        headers: {
          host: lanHost(gateway.port),
          cookie: `${DEVICE_COOKIE_NAME}=${token}`,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: '{"outcome":"allowed-once"}',
      })
      assert.equal(res.status, 200, entry.path)
    }

    const events = auditLines(dir).map((line) => line.event)
    assert.ok(events.includes('stop_task'), 'the stop button is an action')
    assert.ok(events.includes('approval_answer'), 'answering an approval is an action')
    /* The approval OUTCOME is content-adjacent and must not be recorded. */
    const raw = readFileSync(path.join(dir, `audit-${dayKeyOf(AT)}.jsonl`), 'utf8')
    assert.ok(!raw.includes('allowed-once'))
  } finally {
    await stop()
  }
})

test('an unrecognized write is recorded as unknown, not guessed', async () => {
  const { gateway, dir, token, stop } = await makeGateway()
  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/session/sendMessage',
      headers: {
        host: lanHost(gateway.port),
        cookie: `${DEVICE_COOKIE_NAME}=${token}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: '{"x":1}',
    })
    assert.equal(res.status, 200)

    const line = auditLines(dir).find((entry) => entry.meta?.path === '/api/session/sendMessage')
    assert.ok(line !== undefined)
    assert.equal(line.event, 'unknown', 'the design trade: degrade rather than couple to internal APIs')
  } finally {
    await stop()
  }
})

test('a read produces no audit line at all', async () => {
  /* A live session issues an endless stream of reads. Recording them would bury
     the actions a user is looking for. */
  const { gateway, dir, token, stop } = await makeGateway()
  try {
    const res = await send({
      port: gateway.port,
      path: '/api/session/list',
      headers: { host: lanHost(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${token}` },
    })
    assert.equal(res.status, 200)
    assert.deepEqual(auditLines(dir), [], 'nothing was written')
  } finally {
    await stop()
  }
})

test('a refused request produces no audit line', async () => {
  /* A refusal is not an action this device performed — and recording it would let
     an unpaired client fill the trail with one line per probe. */
  const { gateway, dir, stop } = await makeGateway()
  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/session/prompt',
      headers: { host: lanHost(gateway.port), 'content-type': 'application/json' },
      body: '{"prompt":"x"}',
    })
    assert.equal(res.status, 401)
    assert.deepEqual(auditLines(dir), [])
  } finally {
    await stop()
  }
})

test('a query string never reaches the audit trail', async () => {
  /* A query can carry a prompt fragment or a file path. Only the pathname is
     recorded, which is why `meta.path` is derived from `URL.pathname`. */
  const { gateway, dir, token, stop } = await makeGateway()
  try {
    await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/session/prompt?text=my+secret+prompt&path=/home/me/private',
      headers: {
        host: lanHost(gateway.port),
        cookie: `${DEVICE_COOKIE_NAME}=${token}`,
        'sec-fetch-site': 'same-origin',
      },
      body: '{}',
    })

    const raw = readFileSync(path.join(dir, `audit-${dayKeyOf(AT)}.jsonl`), 'utf8')
    assert.ok(!raw.includes('secret'))
    assert.ok(!raw.includes('/home/me'))
    const line = auditLines(dir).find((entry) => entry.event === 'send_message')
    assert.equal(line.meta.path, '/api/session/prompt')
  } finally {
    await stop()
  }
})

test('a gateway with no audit writer still serves requests', async () => {
  /* The writer is optional by construction, and its absence must never be fatal. */
  const { gateway, token, upstreamSaw, stop } = await makeGateway({ withAudit: false })
  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/session/prompt',
      headers: { host: lanHost(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${token}`, 'sec-fetch-site': 'same-origin' },
      body: '{}',
    })
    assert.equal(res.status, 200)
    assert.equal(upstreamSaw.length, 1)
  } finally {
    await stop()
  }
})

test('an audit writer that throws cannot break a request', async () => {
  /* Observability, not authorization. A broken writer must be invisible to the
     device — the request was already authorized. */
  const dir = makeTempDir()
  const clock = { now: AT }
  const store = createStore({ baseDir: dir, now: () => clock.now })
  const minted = createDeviceToken()
  store.addDevice({ id: 'dev_1', name: 'phone', tokenHash: minted.tokenHash })

  const upstream = createServer((req, res) => {
    req.resume()
    req.on('end', () => { res.writeHead(200); res.end('ok') })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  const gateway = await startGateway({
    ctx: { effect: () => () => {}, get: () => undefined },
    store,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    audit: {
      record: () => { throw new Error('writer is broken') },
    },
  })
  started.push(async () => {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
    cleanupDir(dir)
  })

  const res = await send({
    port: gateway.port,
    method: 'POST',
    path: '/api/session/prompt',
    headers: {
      host: lanHost(gateway.port),
      cookie: `${DEVICE_COOKIE_NAME}=${minted.token}`,
      'sec-fetch-site': 'same-origin',
    },
    body: '{}',
  })
  assert.equal(res.status, 200, 'the request was served despite the broken writer')
})

/* ------------------------------------------------------------------ *
 * pair_failed — the brute-force signal (implement.md stage 2 supplement)
 * ------------------------------------------------------------------ */

test('a failed pairing redemption is recorded as pair_failed', () => {
  /* The item stage 2 deliberately left for stage 4: `pairing.js` already had the
     brute-force budget, but nobody could notice it being spent.
     Driven directly, because the pairing route belongs to stage 5's UI; what is
     under test here is the wiring `createRuntime` installs. */
  const dir = makeTempDir()
  const clock = { now: AT }
  const audit = createAudit({ baseDir: dir, now: () => clock.now })
  const pairing = createPairingStore({
    now: () => clock.now,
    random: (size) => Buffer.alloc(size, 3),
    onFailure: (failure) => {
      audit.record({
        event: 'pair_failed',
        ip: failure.source ?? undefined,
        meta: {
          ...(failure.pairId === null ? {} : { pairId: failure.pairId }),
          code: failure.code,
        },
      })
    },
  })

  try {
    const pair = pairing.create()
    assert.throws(() => pairing.redeem(pair.pairId, 'ZZZZZZZZ', { source: '192.168.1.9' }))

    const lines = readFileSync(path.join(dir, `audit-${dayKeyOf(AT)}.jsonl`), 'utf8')
      .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].event, 'pair_failed')
    assert.equal(lines[0].ip, '192.168.1.9')
    assert.equal(lines[0].meta.pairId, pair.pairId)
    assert.equal(lines[0].meta.code, 'pairing/invalid-code')
    assert.equal(lines[0].deviceId, undefined, 'no device exists for a failed pairing')
    /* The CODE is not in the trail, and cannot be: `pairing.js` never has it in
       scope on the failure path. */
    assert.ok(!JSON.stringify(lines[0]).includes(pair.code))
  } finally {
    cleanupDir(dir)
  }
})

test('every attempted guess is recorded, including the ones rejected by a spent budget', () => {
  /* The loudest part of an attack is the part AFTER a budget is spent. If those
     attempts were silent the trail would end exactly as the attacker got
     persistent.
     Two independent budgets are at work and the audit must show which one fired,
     so this uses a per-pair limit of 2 and a per-source budget of 3 — the third
     guess from one address exhausts the SOURCE while the pair is already locked,
     and `pairing/source-locked` is the honest headline (it applies to every pair
     the address names, not just this one). */
  const dir = makeTempDir()
  const clock = { now: AT }
  const audit = createAudit({ baseDir: dir, now: () => clock.now })
  const pairing = createPairingStore({
    now: () => clock.now,
    random: (size) => Buffer.alloc(size, 5),
    maxAttempts: 2,
    ipMaxFailures: 3,
    onFailure: (failure) => {
      audit.record({
        event: 'pair_failed',
        ip: failure.source ?? undefined,
        meta: { code: failure.code, ...(failure.pairId === null ? {} : { pairId: failure.pairId }) },
      })
    },
  })

  try {
    const pair = pairing.create()
    const outcomes = []
    /* guess 1: a plain mismatch. guess 2: reaches the per-pair limit. */
    for (let index = 0; index < 2; index += 1) {
      outcomes.push(catchCode(() => pairing.redeem(pair.pairId, 'ZZZZZZZZ', { source: '10.0.0.1' })))
    }
    /* guess 3: the pair is locked AND this spends the source budget. */
    outcomes.push(catchCode(() => pairing.redeem(pair.pairId, 'ZZZZZZZZ', { source: '10.0.0.1' })))
    /* guesses 4-5: the source is spent, so they are refused before any pair is
       even consulted — including for a pair this address never named. */
    outcomes.push(catchCode(() => pairing.redeem(pair.pairId, 'ZZZZZZZZ', { source: '10.0.0.1' })))
    outcomes.push(catchCode(() => pairing.redeem('pair_other', 'ZZZZZZZZ', { source: '10.0.0.1' })))

    assert.deepEqual(outcomes, [
      'pairing/invalid-code',
      'pairing/locked',
      'pairing/source-locked',
      'pairing/source-locked',
      'pairing/source-locked',
    ])

    const lines = readFileSync(path.join(dir, `audit-${dayKeyOf(AT)}.jsonl`), 'utf8')
      .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    assert.equal(lines.length, 5, 'one line per attempt, including the locked ones')
    assert.deepEqual(lines.map((line) => line.meta.code), outcomes)
    assert.ok(lines.every((line) => line.event === 'pair_failed'))
    assert.ok(lines.every((line) => line.ip === '10.0.0.1'))

    /* And a DIFFERENT address is unaffected: the budget is per source, so a
       blocked attacker cannot lock out the legitimate user's network. */
    clock.now = AT
    const fresh = pairing.create()
    assert.equal(
      catchCode(() => pairing.redeem(fresh.pairId, 'ZZZZZZZZ', { source: '10.0.0.2' })),
      'pairing/invalid-code',
      'a different source still has its own budget',
    )
  } finally {
    cleanupDir(dir)
  }
})

test('an expired or already-used pair is NOT reported as a failed guess', () => {
  /* `design.md` §3.1's TTL is normal operation, and a `pair_failed` line for it
     would be noise a user learns to ignore — which is how a real attack gets
     overlooked. Only a GUESS is a failure. */
  const dir = makeTempDir()
  const clock = { now: AT }
  const audit = createAudit({ baseDir: dir, now: () => clock.now })
  const pairing = createPairingStore({
    now: () => clock.now,
    random: (size) => Buffer.alloc(size, 9),
    ttlMs: 1_000,
    onFailure: (failure) => audit.record({ event: 'pair_failed', meta: { code: failure.code } }),
  })

  try {
    const pair = pairing.create()
    /* Redeemed once, correctly. */
    assert.doesNotThrow(() => pairing.redeem(pair.pairId, pair.code))
    /* A second redemption: `used`, not a guess. */
    assert.equal(catchCode(() => pairing.redeem(pair.pairId, pair.code)), 'pairing/used')
    /* And an expired pair. */
    clock.now = AT + 5_000
    assert.equal(catchCode(() => pairing.redeem(pair.pairId, pair.code)), 'pairing/expired')

    assert.deepEqual(auditLines(dir), [], 'neither event produced a pair_failed line')
  } finally {
    cleanupDir(dir)
  }
})

test('a throwing failure observer cannot break pairing', () => {
  /* `onFailure` is observability. It must never turn a failed pairing into a
     thrown one, or the brute-force budget would become a denial-of-service lever. */
  const clock = { now: AT }
  const pairing = createPairingStore({
    now: () => clock.now,
    random: (size) => Buffer.alloc(size, 1),
    onFailure: () => { throw new Error('observer is broken') },
  })
  const pair = pairing.create()
  assert.throws(
    () => pairing.redeem(pair.pairId, 'ZZZZZZZZ'),
    (error) => error.code === 'pairing/invalid-code',
    'the original pairing error is what surfaces',
  )
})

/** Run `fn`, returning its error code or `'no-throw'`. */
function catchCode(fn) {
  try {
    fn()
    return 'no-throw'
  } catch (error) {
    return error.code
  }
}
