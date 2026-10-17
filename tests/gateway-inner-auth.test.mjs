/**
 * Inner credential: redeem, cache, invalidate, and the security red line.
 *
 * Every case here is about the credential the gateway must attach so the official
 * port stops answering 401/403 (`research/official-connection-fence.md` §3). No
 * HTTP server is involved: `fetch` is injected, which is also the only way to
 * assert "the exchange happened exactly once" without counting sockets.
 *
 * The red-line cases (client cookies filtered, upstream `set-cookie` dropped) are
 * here rather than in the proxy tests because they are properties of the
 * credential, not of the forwarding.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildUpstreamCookie,
  carriesInnerCookie,
  createInnerAuth,
  extractInnerCookie,
} from '../src/host/gateway/inner-auth.js'

/** A `set-cookie` header shaped like the one the official exchange returns. */
const INNER = 'dsh-auth-abc123=v1.payload.signature; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'

/**
 * A `fetch` stub that records calls and replies with a canned response.
 *
 * @param {object} [spec]
 * @param {string[] | string | null} [spec.setCookie] `set-cookie` to return.
 * @param {number} [spec.status]
 * @param {boolean} [spec.throw] Whether to reject like a network failure.
 * @param {() => void} [spec.onCall]
 */
function stubFetch(spec = {}) {
  const calls = []
  /* Default to a successful exchange; `setCookie: null` models "no credential
     came back", which is the failure case, so the two must not share a default. */
  const setCookie = spec.setCookie === undefined ? [INNER] : spec.setCookie
  const impl = async (url, init) => {
    calls.push({ url, init })
    spec.onCall?.()
    if (spec.throw === true) throw new Error('connect ECONNREFUSED')
    return {
      status: spec.status ?? 303,
      headers: {
        get: (name) => (name.toLowerCase() === 'set-cookie' ? setCookie : null),
      },
    }
  }
  impl.calls = calls
  return impl
}

/** A fake `ctx.connection` with a recorded `authenticatedUrl`. */
function stubConnection(marker = 'LAUNCH-TOKEN') {
  const seen = []
  return {
    seen,
    service: {
      authenticatedUrl: (baseUrl) => {
        seen.push(baseUrl)
        return `${baseUrl}?token=${marker}`
      },
    },
  }
}

/** Collect logger calls into an array. */
function recordingLogger() {
  const calls = []
  const record = (level) => (message) => calls.push({ level, message })
  return {
    calls,
    logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
  }
}

/** Build an inner-auth instance wired to stubs. */
function makeInnerAuth(overrides = {}) {
  const clock = { now: 1_000 }
  const connection = overrides.connection ?? stubConnection()
  const fetchImpl = overrides.fetchImpl ?? stubFetch()
  const { calls, logger } = recordingLogger()
  const emit = (sink, level, message) => sink[level]?.(message)
  const innerAuth = createInnerAuth({
    getConnection: overrides.getConnection ?? (() => connection.service),
    upstreamOrigin: 'http://127.0.0.1:19387',
    fetchImpl,
    now: () => clock.now,
    retryIntervalMs: overrides.retryIntervalMs ?? 0,
    emit,
    logger,
  })
  return { innerAuth, fetchImpl, connection, clock, logs: calls, logger }
}

/* ------------------------------------------------------------------ *
 * extractInnerCookie
 * ------------------------------------------------------------------ */

test('extractInnerCookie takes only the name=value from a dsh-auth cookie', () => {
  assert.equal(extractInnerCookie([INNER]), 'dsh-auth-abc123=v1.payload.signature')
})

test('extractInnerCookie accepts a single string instead of an array', () => {
  assert.equal(extractInnerCookie(INNER), 'dsh-auth-abc123=v1.payload.signature')
})

test('extractInnerCookie picks the dsh-auth entry out of several cookies', () => {
  const header = ['other=1; Path=/', INNER, 'another=2']
  assert.equal(extractInnerCookie(header), 'dsh-auth-abc123=v1.payload.signature')
})

test('extractInnerCookie returns undefined when no dsh-auth cookie is present', () => {
  assert.equal(extractInnerCookie(['a=1; Path=/']), undefined)
  assert.equal(extractInnerCookie([]), undefined)
  assert.equal(extractInnerCookie(null), undefined)
  assert.equal(extractInnerCookie(undefined), undefined)
  assert.equal(extractInnerCookie([42]), undefined)
  assert.equal(extractInnerCookie(['dsh-auth-empty=; Path=/']), undefined, 'an empty value is not a credential')
})

/* ------------------------------------------------------------------ *
 * Redeem
 * ------------------------------------------------------------------ */

test('the first redemption returns the inner cookie and caches it', async () => {
  const { innerAuth, fetchImpl } = makeInnerAuth()
  const first = await innerAuth.header()

  assert.equal(first, 'dsh-auth-abc123=v1.payload.signature')
  assert.equal(innerAuth.peek(), first)
  assert.equal(fetchImpl.calls.length, 1)
})

test('subsequent calls reuse the cache instead of redeeming again', async () => {
  const { innerAuth, fetchImpl } = makeInnerAuth()
  await innerAuth.header()
  await innerAuth.header()
  await innerAuth.header()

  assert.equal(fetchImpl.calls.length, 1, 'the cookie binds to the authority, so it is reusable')
})

test('the exchange uses redirect: manual', async () => {
  /* Mandatory: the exchange answers 303 with the cookie, and a followed redirect
     discards it. This is measured ground truth, not a preference. */
  const { innerAuth, fetchImpl } = makeInnerAuth()
  await innerAuth.header()

  assert.equal(fetchImpl.calls[0].init.redirect, 'manual')
})

test('the exchange targets the loopback upstream authority the gateway forwards to', async () => {
  /* The cookie binds to the authority it was minted for, so the redemption MUST
     use the same authority the proxy rewrites Host to. A mismatch here is the
     exact failure mode that produces a permanent 401 with no other symptom. */
  const { innerAuth, connection, fetchImpl } = makeInnerAuth()
  await innerAuth.header()

  assert.deepEqual(connection.seen, ['http://127.0.0.1:19387/'])
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:19387/?token=LAUNCH-TOKEN')
})

test('concurrent requests share one in-flight exchange', async () => {
  /* A page load fires many requests at once; twenty exchanges would be twenty
     cookie mints for one cookie. */
  const { innerAuth, fetchImpl } = makeInnerAuth()
  const results = await Promise.all([
    innerAuth.header(),
    innerAuth.header(),
    innerAuth.header(),
    innerAuth.header(),
  ])

  assert.equal(fetchImpl.calls.length, 1)
  for (const value of results) assert.equal(value, 'dsh-auth-abc123=v1.payload.signature')
})

/* ------------------------------------------------------------------ *
 * Failure and invalidate
 * ------------------------------------------------------------------ */

test('invalidate drops the cache so the next call redeems again', async () => {
  let minted = 0
  const fetchImpl = stubFetch({
    onCall: () => { minted += 1 },
    setCookie: [INNER],
  })
  const { innerAuth } = makeInnerAuth({ fetchImpl })

  assert.equal(await innerAuth.header(), 'dsh-auth-abc123=v1.payload.signature')
  assert.equal(innerAuth.peek(), 'dsh-auth-abc123=v1.payload.signature')

  innerAuth.invalidate()
  assert.equal(innerAuth.peek(), undefined, 'the stale credential is gone')

  assert.equal(await innerAuth.header(), 'dsh-auth-abc123=v1.payload.signature')
  assert.equal(minted, 2, 're-minted exactly once')
})

test('an exchange with no dsh-auth cookie fails without caching anything', async () => {
  const fetchImpl = stubFetch({ setCookie: null, status: 200 })
  const { innerAuth, logs } = makeInnerAuth({ fetchImpl })

  assert.equal(await innerAuth.header(), undefined)
  assert.equal(innerAuth.peek(), undefined)
  assert.ok(
    logs.some((entry) => entry.level === 'warn' && /no dsh-auth-\* cookie/.test(entry.message)),
    'the degradation is logged',
  )
})

test('a network failure yields no cookie and does not throw', async () => {
  /* DSH restarting: the request must proceed without the credential and the
     upstream 401 is passed through, not turned into a 500. */
  const fetchImpl = stubFetch({ throw: true })
  const { innerAuth } = makeInnerAuth({ fetchImpl })

  await assert.doesNotReject(() => innerAuth.header())
  assert.equal(await innerAuth.header(), undefined)
})

test('a failing exchange is not retried on every request within the retry interval', async () => {
  /* Without this, an upstream that is down turns every request into an exchange
     attempt, which is a self-inflicted flood. */
  const fetchImpl = stubFetch({ setCookie: null })
  const { innerAuth, clock } = makeInnerAuth({ fetchImpl, retryIntervalMs: 1_000 })

  await innerAuth.header()
  const afterFirst = fetchImpl.calls.length

  /* Five more requests within the interval: no new exchange. */
  for (let index = 0; index < 5; index += 1) {
    clock.now += 100
    await innerAuth.header()
  }
  assert.equal(fetchImpl.calls.length, afterFirst, 'the failure is remembered for the interval')

  /* Once the interval has passed, one more attempt is allowed. */
  clock.now += 1_000
  await innerAuth.header()
  assert.equal(fetchImpl.calls.length, afterFirst + 1)
})

test('invalidate clears the retry shield too, so the one allowed retry actually happens', async () => {
  /* A 401 from upstream means "this credential is stale", not "the upstream is
     down". Suppressing the retry with the failure shield would make the single
     bounded retry a no-op exactly when it is needed. */
  let call = 0
  const fetchImpl = async (url, init) => {
    call += 1
    return {
      status: 303,
      headers: { get: () => (call === 1 ? [INNER] : ['dsh-auth-new=second; Path=/']) },
    }
  }
  const { innerAuth } = makeInnerAuth({ fetchImpl, retryIntervalMs: 60_000 })

  assert.equal(await innerAuth.header(), 'dsh-auth-abc123=v1.payload.signature')
  innerAuth.invalidate()
  assert.equal(await innerAuth.header(), 'dsh-auth-new=second')
})

/* ------------------------------------------------------------------ *
 * Optional dependency degradation
 * ------------------------------------------------------------------ */

test('with no connection service the provider degrades, warns ONCE and never throws', async () => {
  /* `ctx.connection` is optional: quality-guidelines §5 allows the downgrade but
     demands it be visible, and demands it be said once rather than per request. */
  const { innerAuth, logs } = makeInnerAuth({ getConnection: () => undefined })

  assert.equal(innerAuth.available(), false)
  for (let index = 0; index < 5; index += 1) await innerAuth.header()

  const warnings = logs.filter((entry) => entry.level === 'warn')
  assert.equal(warnings.length, 1, 'one warning, not one per request')
  assert.match(warnings[0].message, /ctx\.connection is unavailable/)
})

test('a connection service without authenticatedUrl counts as unavailable', async () => {
  const { innerAuth } = makeInnerAuth({ getConnection: () => ({}) })
  assert.equal(innerAuth.available(), false)
  assert.equal(await innerAuth.header(), undefined)
})

test('the service is read at call time, so a late-loaded connection is picked up', async () => {
  /* `ctx.get` is called per use rather than captured at construction: a
     hot-reloaded connection plugin must not leave the gateway permanently
     degraded. */
  let service
  const fetchImpl = stubFetch()
  const { innerAuth } = makeInnerAuth({ getConnection: () => service, fetchImpl })

  assert.equal(await innerAuth.header(), undefined)
  assert.equal(fetchImpl.calls.length, 0)

  service = stubConnection().service
  assert.equal(await innerAuth.header(), 'dsh-auth-abc123=v1.payload.signature')
})

test('authenticatedUrl throwing is contained and logged, not propagated', async () => {
  const { innerAuth, logs } = makeInnerAuth({
    getConnection: () => ({ authenticatedUrl: () => { throw new Error('bad base URL') } }),
  })

  await assert.doesNotReject(() => innerAuth.header())
  assert.equal(await innerAuth.header(), undefined)
  assert.ok(logs.some((entry) => entry.level === 'error' && /authenticatedUrl/.test(entry.message)))
})

/* ------------------------------------------------------------------ *
 * Security red line: the credential never travels toward a client
 * ------------------------------------------------------------------ */

test('buildUpstreamCookie prepends the inner credential', () => {
  assert.equal(
    buildUpstreamCookie(`${'dsh-rc-device'}=devtoken`, 'dsh-auth-x=secret'),
    'dsh-auth-x=secret; dsh-rc-device=devtoken',
  )
})

test('buildUpstreamCookie strips every client-supplied dsh-auth cookie', () => {
  /* A client can never hold a usable one (the value binds to the upstream
     authority), so one crossing the hop is attacker-controlled bytes occupying the
     credential slot. It is replaced, never appended to. */
  assert.equal(
    buildUpstreamCookie('dsh-auth-evil=forged; keep=1; dsh-auth-two=x', 'dsh-auth-real=v1.s'),
    'dsh-auth-real=v1.s; keep=1',
  )
})

test('buildUpstreamCookie strips dsh-auth cookies even when no real one exists', () => {
  assert.equal(buildUpstreamCookie('dsh-auth-evil=forged; keep=1', undefined), 'keep=1')
})

test('buildUpstreamCookie strips dsh-auth cookies case-insensitively', () => {
  assert.equal(buildUpstreamCookie('DSH-AUTH-evil=forged; keep=1', 'dsh-auth-real=v1.s'), 'dsh-auth-real=v1.s; keep=1')
})

test('buildUpstreamCookie returns undefined when there is nothing to send', () => {
  assert.equal(buildUpstreamCookie(undefined, undefined), undefined)
  assert.equal(buildUpstreamCookie('', undefined), undefined)
  assert.equal(buildUpstreamCookie('dsh-auth-only=x', undefined), undefined)
})

test('carriesInnerCookie recognizes an inner credential in set-cookie', () => {
  assert.equal(carriesInnerCookie('dsh-auth-abc=v1.x.y; Path=/'), true)
  assert.equal(carriesInnerCookie(['a=1', 'dsh-auth-abc=v1.x.y']), true)
  assert.equal(carriesInnerCookie(['a=1; Path=/']), false)
  assert.equal(carriesInnerCookie(undefined), false)
  assert.equal(carriesInnerCookie([]), false)
  assert.equal(carriesInnerCookie(['DSH-AUTH-abc=v1.x.y']), true, 'prefix test is case-insensitive')
})

test('no log line ever carries the inner credential value', async () => {
  /* The credential is instance-wide access. A single debug line with it in would
     hand that to anyone reading the host log. */
  const { innerAuth, logs } = makeInnerAuth()
  await innerAuth.header()
  await innerAuth.header()
  innerAuth.invalidate()
  await innerAuth.header()

  const joined = logs.map((entry) => entry.message).join('\n')
  assert.ok(!joined.includes('v1.payload.signature'), 'the credential value must never be logged')
  assert.ok(!/dsh-auth-[a-z0-9]+=v1\./.test(joined), 'not even in a recognizable credential shape')
})
