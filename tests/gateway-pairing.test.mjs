/**
 * The pairing bootstrap, end to end over a real gateway on port 0.
 *
 * Before this suite existed, `pairing.redeem()` had **zero call sites**: the panel
 * minted a code, handed out a `pairPath`, and nothing served it, so a phone opening
 * the link got the gateway's 401 forever. Every test here therefore goes through a
 * real socket and a real store rather than mocking the pieces — the gap was a
 * WIRING gap, and only an end-to-end request can see wiring.
 *
 * The upstream stub is a real listener too, and it records every request. Most
 * assertions here are of the form "the pairing path answered, and the upstream
 * heard nothing": the pairing routes are exempt from `authorize()`, and the reason
 * that exemption is not the stage-2 laundering hole is precisely that they never
 * reach `proxy.js` and never inject the inner credential. Asserting
 * `upstream.state.requests.length === 0` is how that property is proven rather than
 * trusted.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createAudit, dayKeyOf } from '../src/host/audit.js'
import { DEVICE_COOKIE_NAME, PAIRING_ROUTE_PATH } from '../src/host/constants.js'
import { createPairingStore } from '../src/host/pairing.js'
import { createStore } from '../src/host/store.js'
import { startGateway } from '../src/host/gateway/server.js'
import { TEST_JWT_KEY, cleanupDir, makeTempDir } from './helpers.mjs'

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

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/**
 * Start a gateway with a real store, a real pairing store and a stub upstream.
 *
 * `enabled` defaults to TRUE because a disabled gateway must refuse the pairing
 * routes — that is one of the behaviours under test, so the happy path needs the
 * switch on.
 *
 * @param {object} [spec]
 * @param {boolean} [spec.enabled] `settings.enabled`.
 * @param {number} [spec.ttlMs] Pairing TTL, so "expired" needs no sleep.
 * @param {number} [spec.maxAttempts] Per-pair failure budget.
 * @param {number} [spec.ipMaxFailures] Per-source failure budget.
 */
async function makeGateway(spec = {}) {
  const dir = makeTempDir()
  const clock = { now: AT }
  const store = createStore({ baseDir: dir, now: () => clock.now })
  store.updateSettings({ enabled: spec.enabled !== false })

  const audit = createAudit({ baseDir: dir, now: () => clock.now })
  const pairing = createPairingStore({
    now: () => clock.now,
    ttlMs: spec.ttlMs,
    maxAttempts: spec.maxAttempts,
    ipMaxFailures: spec.ipMaxFailures,
    /* The same wiring `createRuntime` installs, so `pair_failed` is produced by the
       REAL call path rather than by a test-local callback. */
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

  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      upstream.state.requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true,"upstream":true}')
    })
  })
  upstream.state = { requests: [] }
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  const gateway = await startGateway({
    ctx: { effect: () => () => {}, get: () => undefined },
    store,
    pairing,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
    now: () => clock.now,
    audit,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  })

  const stop = async () => {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
    cleanupDir(dir)
  }
  started.push(stop)

  return { gateway, store, pairing, audit, clock, dir, upstream, stop }
}

/** Issue one request against the gateway. */
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

/**
 * The `Host` a REMOTE device sends.
 *
 * A LAN-style authority, not loopback: the socket peer in a test is always
 * loopback, so a loopback `Host` too would make every request local and exempt and
 * the suite would silently assert the wrong branch.
 */
function lanHost(port) {
  return `192.168.1.7:${String(port)}`
}

/** A same-origin `Origin` for that authority, i.e. what a real phone's page sends. */
function lanOrigin(port) {
  return `http://${lanHost(port)}`
}

/** The JSON POST a phone's pairing page makes. */
function redeem(gateway, pairId, code, extraHeaders = {}) {
  return send({
    port: gateway.port,
    method: 'POST',
    path: PAIRING_ROUTE_PATH,
    headers: {
      host: lanHost(gateway.port),
      origin: lanOrigin(gateway.port),
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify({ pairId, code }),
  })
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

/** The single `set-cookie` value, or undefined. */
function cookieOf(res) {
  const raw = res.headers['set-cookie']
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  return raw[0]
}

/**
 * The JWT out of a `Set-Cookie` value.
 *
 * A JWS compact serialization is letters, digits, `-`, `_` and two `.`, so the
 * value is read up to the first `;` and nothing else.
 */
function tokenOf(setCookie) {
  const match = /^dsh-rc-jwt=([^;]+)/.exec(setCookie ?? '')
  return match === null ? undefined : match[1]
}

/* ------------------------------------------------------------------ *
 * The happy path
 * ------------------------------------------------------------------ */

test('a correct code pairs the device: 303, a signed JWT, and a device row with no verifier', async () => {
  const { gateway, store, pairing, dir, upstream, stop } = await makeGateway()
  try {
    const pair = pairing.create({ label: 'phone' })

    const res = await redeem(gateway, pair.pairId, pair.code)

    assert.equal(res.status, 303, 'the success transition is a redirect')
    assert.equal(res.headers.location, '/', 'to the dsh UI, same origin')
    assert.equal(res.body, '', 'a 303 has nothing to say')

    /* The cookie, attribute by attribute. `Secure` is the one that must be ABSENT:
       the LAN transport is plain HTTP, and a Secure cookie is never sent back, so
       adding it would make pairing appear to succeed and then fail on the next
       request (`design.md` §3.2, a documented boundary). */
    const setCookie = cookieOf(res)
    assert.ok(typeof setCookie === 'string', 'exactly one Set-Cookie is issued')
    assert.match(setCookie, /^dsh-rc-jwt=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/, 'a signed JWT')
    assert.match(setCookie, /; Max-Age=2592000;/, '30 days')
    assert.match(setCookie, /; Path=\//)
    assert.match(setCookie, /; HttpOnly/)
    assert.match(setCookie, /; SameSite=Lax/)
    assert.ok(!/;\s*Secure/i.test(setCookie), 'NO Secure: the LAN transport is plain HTTP')

    /* The inner credential is the instance-wide `dsh-auth-*` cookie and it must
       never leave this process towards a client (`design.md` §4.4 security red
       line). The pairing response is a NEW response the gateway generates — the
       one place a future edit could plausibly attach one "for convenience" — so it
       is asserted here rather than only in the proxy's `set-cookie` filter. */
    for (const [name, value] of Object.entries(res.headers)) {
      const flattened = Array.isArray(value) ? value.join('\n') : String(value)
      assert.ok(!/dsh-auth-/i.test(flattened), `response header ${name} carries inner credential material`)
    }
    assert.equal(
      (res.headers['set-cookie'] ?? []).length,
      1,
      'exactly one cookie is set, and it is the device cookie',
    )

    const jwt = tokenOf(setCookie)
    assert.ok(typeof jwt === 'string' && jwt !== '')
    assert.equal(jwt.split('.').length, 3, 'three segments: header, payload, signature')

    /* The store holds ONE device — its ROW, and nothing about the credential. */
    const devices = store.listDevices()
    assert.equal(devices.length, 1)
    const device = devices[0]
    assert.match(device.id, /^dev_[A-Za-z0-9_-]{1,80}$/, 'a store-shaped id')
    assert.equal(device.tokenHash, undefined, 'no verifier is stored: the credential is the JWT')
    assert.equal(device.revokedAt, null)
    assert.equal(device.ua, '', 'no User-Agent was sent, so none was invented')
    assert.equal(device.name, 'Paired device', 'and a neutral label rather than a guess')

    /* The token's `sub` IS that row's id — the binding that makes the credential
       mean something (`research/jwt-device-credential.md` §3.2). */
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
    assert.equal(claims.sub, device.id, 'the JWT names the row it was minted for')
    assert.equal(claims.iss, 'dsh-remote-control')
    assert.equal(claims.aud, 'dsh-gateway')
    assert.equal(claims.name, device.name, 'and carries the label as a convenience claim')
    assert.deepEqual(Object.keys(claims), ['iss', 'sub', 'aud', 'iat', 'exp', 'jti', 'name'])
    assert.ok(claims.exp > claims.iat, 'a real lifetime')

    /* Nothing on disk carries the credential in ANY form. */
    const raw = readFileSync(path.join(dir, 'devices.json'), 'utf8')
    assert.ok(!raw.includes(jwt), 'the JWT is never persisted')
    assert.ok(!raw.includes('tokenHash'), 'and no verifier is either')
    assert.ok(!raw.includes(jwt.split('.')[2]), 'not even the signature segment')

    /* The `pair` audit event: device, address, and the opaque pair id — never the code. */
    const events = auditLines(dir)
    const paired = events.filter((line) => line.event === 'pair')
    assert.equal(paired.length, 1)
    assert.equal(paired[0].deviceId, device.id)
    assert.equal(paired[0].ip, '127.0.0.1', 'the real socket peer')
    assert.equal(paired[0].meta.pairId, pair.pairId)
    const auditText = readFileSync(path.join(dir, `audit-${dayKeyOf(AT)}.jsonl`), 'utf8')
    assert.ok(!auditText.includes(pair.code), 'the pairing code is not in the trail')
    assert.ok(!auditText.includes(jwt), 'and not the device JWT either')
    assert.ok(!auditText.includes(jwt.split('.')[2]), 'nor its signature')

    /* The pairing path never reaches the proxy — which is why its exemption from
       `authorize()` is not the stage-2 laundering hole. */
    assert.equal(upstream.state.requests.length, 0, 'no upstream request was made for a pairing')

    /* The pair is consumed. */
    assert.equal(pairing.pending(), 0, 'the code is spent')
  } finally {
    await stop()
  }
})

test('the JWT it hands out actually authenticates the next request (round trip)', async () => {
  /* THE assertion that closes the loop, and the one the user's OAuth request really
     asks for. A `Set-Cookie` that looks right and a token that cannot be verified is
     exactly the failure a header-only test would miss: the pairing route signs with
     the gateway's key, and `authorize` verifies with the same key, so a mismatch
     anywhere — the `sub` versus the stored id, the issuer, the audience — would
     leave a device that pairs successfully and can never connect.

     It goes over a REAL socket because that is the only way to catch a wiring gap
     between the two modules. */
  const { gateway, pairing, upstream, store, stop } = await makeGateway()
  try {
    const pair = pairing.create()
    const res = await redeem(gateway, pair.pairId, pair.code)
    assert.equal(res.status, 303)
    const jwt = tokenOf(cookieOf(res))
    assert.ok(typeof jwt === 'string')

    /* A request on a DIFFERENT path, carrying only that cookie — no loopback
       exemption can apply, because the Host is a LAN authority. */
    const read = await send({
      port: gateway.port,
      path: '/api/session/list',
      headers: { host: lanHost(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${jwt}` },
    })

    assert.equal(read.status, 200, 'the fresh JWT is accepted by authorize()')
    const proxied = upstream.state.requests.filter((entry) => !entry.url.includes('token='))
    assert.equal(proxied.length, 1, 'and the request was proxied')
    assert.equal(proxied[0].url, '/api/session/list')

    /* The device cookie is forwarded upstream with the inner credential, and the
       JWT is what travels — no translation layer re-mints a different value. */
    assert.match(proxied[0].headers.cookie ?? '', /dsh-rc-jwt=/, 'the credential crosses the hop')

    /* Activity was recorded for the new device, so the panel's "last seen" works
       from the first request rather than after the first 30-second window. */
    const device = store.listDevices()[0]
    assert.equal(gateway.activity.stats.recorded, 1)
    assert.equal(device.lastSeenAt, new Date(AT).toISOString())
  } finally {
    await stop()
  }
})

test('the paired JWT is revoked instantly: the SAME token is 401 after a revoke', async () => {
  /* `prd.md` constraint 5, end to end, over a real socket — the pairing-produced
     credential in its real lifecycle. The JWT is not touched between the two
     requests: its signature still verifies and its `exp` is unchanged. Only the
     gateway's revoked set changed, which is exactly the property a stateless JWT
     could not provide. */
  const { gateway, pairing, upstream, store, stop } = await makeGateway()
  try {
    const pair = pairing.create()
    const res = await redeem(gateway, pair.pairId, pair.code)
    const jwt = tokenOf(cookieOf(res))
    const [device] = store.listDevices()

    const before = await send({
      port: gateway.port,
      path: '/api/session/list',
      headers: { host: lanHost(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${jwt}` },
    })
    assert.equal(before.status, 200)
    const proxiedBefore = upstream.state.requests.filter((entry) => !entry.url.includes('token=')).length

    /* The panel button. `gateway.revokeDevice` is the single entry point
       (`quality-guidelines.md` §18), so the Set is updated by the same call. */
    const outcome = gateway.revokeDevice(device.id)
    assert.equal(outcome.device.revokedAt !== null, true)
    assert.equal(gateway.isRevoked(device.id), true, 'the in-memory set knows immediately')

    const after = await send({
      port: gateway.port,
      path: '/api/session/list',
      headers: { host: lanHost(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${jwt}` },
    })

    assert.equal(after.status, 401, 'the same still-signature-valid JWT is refused')
    assert.equal(JSON.parse(after.body).error.code, 'gateway/device-revoked')
    assert.equal(
      upstream.state.requests.filter((entry) => !entry.url.includes('token=')).length,
      proxiedBefore,
      'and nothing reached DSH',
    )
    const setCookie = cookieOf(after)
    assert.ok(typeof setCookie === 'string', 'the dead cookie is cleared')
    assert.match(setCookie, /^dsh-rc-jwt=;/)
    assert.match(setCookie, /Max-Age=0/)
  } finally {
    await stop()
  }
})

test('a paired device is named from its User-Agent', async () => {
  /* `design.md` §3.1: the panel shows "iPhone · Safari" and lets the user rename.
     A UA parser would be a dependency; two substring tables are enough for a label. */
  const { gateway, pairing, store, stop } = await makeGateway()
  try {
    const pair = pairing.create({ label: 'phone' })
    const res = await redeem(gateway, pair.pairId, pair.code, {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    })
    assert.equal(res.status, 303)

    const device = store.listDevices()[0]
    assert.equal(device.name, 'iPhone · Safari', 'a readable label')
    assert.match(device.ua, /iPhone/, 'the raw agent is kept for the panel')
  } finally {
    await stop()
  }
})

test('the pairing page is served, carries no code, and asks for the fragment', async () => {
  /* The page is the half that reads `location.hash`, which the server never sees.
     It must therefore: (a) fetch nothing, (b) contain no credential, (c) actually
     read the fragment, and (d) offer the manual field `design.md` §3.1 promises. */
  const { gateway, upstream, stop } = await makeGateway()
  try {
    const res = await send({
      port: gateway.port,
      path: PAIRING_ROUTE_PATH,
      headers: { host: lanHost(gateway.port), accept: 'text/html' },
    })

    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/html/)

    /* Self-contained: no external asset, and nothing that could be fetched. */
    assert.ok(!/<script[^>]+src=/i.test(res.body), 'no external script')
    assert.ok(!/<link[^>]+href=/i.test(res.body), 'no stylesheet or icon')
    assert.ok(!/https?:\/\/[a-z]/i.test(res.body.replace(/http:\/\/localhost/g, '')), 'no absolute URL')

    /* Reads the fragment client-side — the only place the code can be. */
    assert.match(res.body, /location\.hash/, 'the page reads the fragment')
    assert.match(res.body, /location\.pathname/, 'and POSTs back to its own path')

    /* The manual fallback (`design.md` §3.1: 二维码为主 + 纯文本码手输). */
    assert.match(res.body, /id="pairId"/)
    assert.match(res.body, /id="code"/)

    /* No credential of any kind, and nothing reflected. */
    assert.ok(!/dsh-rc-jwt/.test(res.body), 'the page names no cookie')
    assert.ok(!/dsh-rc-device/.test(res.body), 'and not the retired one either')
    assert.ok(!/eyJ[A-Za-z0-9_-]{6,}\./.test(res.body), 'no JWT anywhere in the document')
    assert.ok(!/pair_[A-Za-z0-9_-]{6,}/.test(res.body), 'no pairing id')
    assert.ok(!/[A-Za-z0-9_-]{43}/.test(res.body), 'no token-shaped value')

    /* Framing and referrer: the page accepts a credential, so it must not be
       framed, and it must not leak its own URL (which carries the fragment). */
    assert.match(res.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/)
    assert.match(res.headers['content-security-policy'] ?? '', /connect-src 'self'/, 'it POSTs to itself')
    assert.equal(res.headers['x-frame-options'], 'DENY')
    assert.equal(res.headers['referrer-policy'], 'no-referrer')
    for (const [name, value] of Object.entries(res.headers)) {
      const flattened = Array.isArray(value) ? value.join('\n') : String(value)
      assert.ok(!/dsh-auth-/i.test(flattened), `the page's ${name} header carries inner credential material`)
    }

    assert.equal(upstream.state.requests.length, 0, 'serving the page reaches no upstream')
  } finally {
    await stop()
  }
})

test('the page does not echo a pairId passed in the query string', async () => {
  /* The id belongs in the fragment. Accepting it in the query would put it in an
     access log and, worse, invite reflecting it into the document. Both are
     avoided by not reading the query at all. */
  const { gateway, stop } = await makeGateway()
  try {
    const res = await send({
      port: gateway.port,
      path: `${PAIRING_ROUTE_PATH}?pairId=pair_reflected&code=ABCD2345`,
      headers: { host: lanHost(gateway.port) },
    })
    assert.equal(res.status, 200)
    assert.ok(!res.body.includes('pair_reflected'), 'nothing from the query is reflected')
    assert.ok(!res.body.includes('ABCD2345'), 'and not the code either')
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * Failure paths
 * ------------------------------------------------------------------ */

test('a wrong code is refused, audited as pair_failed, and issues no cookie', async () => {
  const { gateway, pairing, store, dir, upstream, stop } = await makeGateway()
  try {
    const pair = pairing.create()

    const res = await redeem(gateway, pair.pairId, 'ZZZZZZZZ')

    assert.equal(res.status, 403)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'pairing/invalid-code')
    assert.equal(cookieOf(res), undefined, 'a failed pair hands out no credential')
    assert.equal(store.listDevices().length, 0, 'and creates no device')
    assert.equal(upstream.state.requests.length, 0)

    /* The brute-force signal (`research/official-connection-fence.md` §7.1). */
    const failed = auditLines(dir).filter((line) => line.event === 'pair_failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0].ip, '127.0.0.1')
    assert.equal(failed[0].meta.pairId, pair.pairId)
    assert.equal(failed[0].meta.code, 'pairing/invalid-code')
    assert.ok(!JSON.stringify(failed[0]).includes('ZZZZZZZZ'), 'the guess is not recorded')
    assert.ok(!JSON.stringify(failed[0]).includes(pair.code), 'nor is the real code')
    assert.equal(auditLines(dir).filter((line) => line.event === 'pair').length, 0)
  } finally {
    await stop()
  }
})

test('an unknown pairId is refused and audited, because it is a guess too', async () => {
  const { gateway, dir, stop } = await makeGateway()
  try {
    const res = await redeem(gateway, 'pair_doesnotexist', 'ABCD2345')
    assert.equal(res.status, 404)
    assert.equal(JSON.parse(res.body).error.code, 'pairing/unknown')
    assert.equal(auditLines(dir).filter((line) => line.event === 'pair_failed').length, 1)
  } finally {
    await stop()
  }
})

test('an expired code is refused but NOT audited as pair_failed', async () => {
  /* `design.md` §3.1's TTL is normal operation. A `pair_failed` line for it is
     noise a user learns to ignore — and a learned-to-ignore signal is how a real
     attack gets overlooked (`implement.md` stage 4). */
  const { gateway, pairing, clock, dir, store, stop } = await makeGateway({ ttlMs: 1_000 })
  try {
    const pair = pairing.create()
    clock.now = AT + 5_000

    const res = await redeem(gateway, pair.pairId, pair.code)

    assert.equal(res.status, 410, 'gone, not wrong')
    assert.equal(JSON.parse(res.body).error.code, 'pairing/expired')
    assert.equal(cookieOf(res), undefined)
    assert.equal(store.listDevices().length, 0)
    assert.deepEqual(auditLines(dir), [], 'no line at all: this was not a guess')
  } finally {
    await stop()
  }
})

test('an already-used code is refused but NOT audited as pair_failed', async () => {
  const { gateway, pairing, dir, stop } = await makeGateway()
  try {
    const pair = pairing.create()
    const first = await redeem(gateway, pair.pairId, pair.code)
    assert.equal(first.status, 303)
    const afterFirst = auditLines(dir).length

    const second = await redeem(gateway, pair.pairId, pair.code)
    assert.equal(second.status, 409, 'consumed, not wrong')
    assert.equal(JSON.parse(second.body).error.code, 'pairing/used')
    assert.equal(cookieOf(second), undefined)
    assert.equal(auditLines(dir).length, afterFirst, 'no new line: reusing a code is not a guess')
  } finally {
    await stop()
  }
})

test('five wrong attempts lock the pair and a sixth with the RIGHT code still fails', async () => {
  /* The measured stage-1 hole (`research/official-connection-fence.md` §7.1): five
     wrong codes left the pair intact and the right code still redeemable. The
     budget lives in `pairing.js`; what this proves is that the HTTP route passes
     the real source address in — without it the per-source half is dead and the
     per-pair half is the only thing standing. */
  const { gateway, pairing, store, dir, stop } = await makeGateway({ ipMaxFailures: 100 })
  try {
    const pair = pairing.create()

    for (let index = 0; index < 4; index += 1) {
      const res = await redeem(gateway, pair.pairId, 'ZZZZZZZZ')
      assert.equal(res.status, 403, `attempt ${String(index + 1)} is a plain mismatch`)
    }
    const locking = await redeem(gateway, pair.pairId, 'ZZZZZZZZ')
    assert.equal(locking.status, 429, 'the fifth wrong guess locks the pair')
    assert.equal(JSON.parse(locking.body).error.code, 'pairing/locked')

    const correct = await redeem(gateway, pair.pairId, pair.code)
    assert.equal(correct.status, 429, 'the right code is no help once the pair is locked')
    assert.equal(JSON.parse(correct.body).error.code, 'pairing/locked')
    assert.equal(cookieOf(correct), undefined)
    assert.equal(store.listDevices().length, 0, 'no device was created')

    /* Five guesses, five lines — the locked-time attempts included. Recording only
       the ones that "still counted" would go blind at the loudest moment. */
    const failed = auditLines(dir).filter((line) => line.event === 'pair_failed')
    assert.equal(failed.length, 6, 'the fifth guess and the locked retry are both recorded')
    assert.equal(failed[4].meta.code, 'pairing/locked')
  } finally {
    await stop()
  }
})

test('the per-source budget blocks guessing across rotated pairIds', async () => {
  /* The per-pair budget alone is bypassed by varying `pairId`, which is
     attacker-chosen. The per-source window is the arm that closes that, and it is
     only reachable if the route forwards the real peer address. */
  const { gateway, pairing, store, dir, stop } = await makeGateway({ ipMaxFailures: 3 })
  try {
    const codes = []
    for (let index = 0; index < 5; index += 1) {
      const pair = pairing.create()
      codes.push(pair)
      const res = await redeem(gateway, pair.pairId, 'ZZZZZZZZ')
      assert.notEqual(res.status, 303)
    }

    /* The last attempts name a FRESH, valid pair each time — a per-pair counter
       would have let them continue indefinitely. */
    const blocked = await redeem(gateway, codes.at(-1).pairId, 'ZZZZZZZZ')
    assert.equal(blocked.status, 429)
    assert.equal(JSON.parse(blocked.body).error.code, 'pairing/source-locked')

    /* And the CORRECT code for a brand-new pair is refused too: the address itself
       has spent its budget, which is the whole point of a source-level limit. */
    const fresh = pairing.create()
    const correct = await redeem(gateway, fresh.pairId, fresh.code)
    assert.equal(correct.status, 429)
    assert.equal(JSON.parse(correct.body).error.code, 'pairing/source-locked')
    assert.equal(cookieOf(correct), undefined)
    assert.equal(store.listDevices().length, 0)

    /* The budget is spent by GUESSES, so the trail shows one line per guess. */
    assert.ok(auditLines(dir).filter((line) => line.event === 'pair_failed').length >= 4)
  } finally {
    await stop()
  }
})

test('a malformed body is refused WITHOUT spending the brute-force budget', async () => {
  /* A client bug must not burn the user's address. Shape validation runs before
     `redeem`, so a body that cannot guess a code cannot spend a guess. */
  const { gateway, pairing, store, dir, stop } = await makeGateway({ ipMaxFailures: 2 })
  try {
    for (let index = 0; index < 5; index += 1) {
      const res = await send({
        port: gateway.port,
        method: 'POST',
        path: PAIRING_ROUTE_PATH,
        headers: {
          host: lanHost(gateway.port),
          origin: lanOrigin(gateway.port),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pairId: 'pair_x', code: '' }),
      })
      assert.equal(res.status, 400)
      assert.equal(JSON.parse(res.body).error.code, 'pairing/bad-request')
    }

    assert.deepEqual(auditLines(dir), [], 'no pair_failed line, because no guess was made')

    /* And the budget really is untouched: the right code still works. */
    const pair = pairing.create()
    const res = await redeem(gateway, pair.pairId, pair.code)
    assert.equal(res.status, 303)
    assert.equal(store.listDevices().length, 1)
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * The origin fence and the body bound
 * ------------------------------------------------------------------ */

test('a cross-site POST is refused before the body is read or a device is created', async () => {
  /* The attack this stops: a page on `evil.example` pairs the user's browser to an
     attacker-controlled device record without the user ever seeing a pairing page.
     The attacker still needs the code, but the fence is what makes the OPEN page
     the only place a POST can originate. `Sec-Fetch-Site` is the unfakeable arm. */
  const { gateway, pairing, store, dir, upstream, stop } = await makeGateway()
  try {
    const pair = pairing.create()

    const crossSite = await send({
      port: gateway.port,
      method: 'POST',
      path: PAIRING_ROUTE_PATH,
      headers: {
        host: lanHost(gateway.port),
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pairId: pair.pairId, code: pair.code }),
    })

    assert.equal(crossSite.status, 403, 'the RIGHT code from a cross-site page is still refused')
    assert.equal(JSON.parse(crossSite.body).error.code, 'gateway/cross-origin')
    assert.equal(cookieOf(crossSite), undefined)
    assert.equal(store.listDevices().length, 0)
    assert.equal(pairing.pending(), 1, 'and the code was not consumed')
    assert.equal(upstream.state.requests.length, 0)

    /* A cross-site ORIGIN with no Sec-Fetch-Site: the arm a non-browser forgery
       takes. */
    const forged = await send({
      port: gateway.port,
      method: 'POST',
      path: PAIRING_ROUTE_PATH,
      headers: {
        host: lanHost(gateway.port),
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pairId: pair.pairId, code: pair.code }),
    })
    assert.equal(forged.status, 403)
    assert.equal(store.listDevices().length, 0)

    /* And a write with NEITHER header — nothing proves where it came from. */
    const unmarked = await send({
      port: gateway.port,
      method: 'POST',
      path: PAIRING_ROUTE_PATH,
      headers: { host: lanHost(gateway.port), 'content-type': 'application/json' },
      body: JSON.stringify({ pairId: pair.pairId, code: pair.code }),
    })
    assert.equal(unmarked.status, 403)
    assert.equal(store.listDevices().length, 0)

    /* None of the three refusals reached `redeem`, so none spent a guess. */
    assert.deepEqual(auditLines(dir).filter((line) => line.event === 'pair_failed'), [])

    /* The same-origin POST still works, which is what keeps a real phone paired. */
    const legit = await redeem(gateway, pair.pairId, pair.code)
    assert.equal(legit.status, 303)
  } finally {
    await stop()
  }
})

test('a non-JSON body is refused without reading it, so a form POST gets nowhere', async () => {
  /* `text/plain` and `application/x-www-form-urlencoded` are the two shapes a
     cross-site page can POST without a CORS preflight. Refusing on the media type
     costs one header comparison and never buffers the payload. */
  const { gateway, dir, store, stop } = await makeGateway()
  try {
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data']) {
      const res = await send({
        port: gateway.port,
        method: 'POST',
        path: PAIRING_ROUTE_PATH,
        headers: {
          host: lanHost(gateway.port),
          origin: lanOrigin(gateway.port),
          'sec-fetch-site': 'same-origin',
          'content-type': type,
        },
        body: 'pairId=pair_x&code=ABCD2345',
      })
      assert.equal(res.status, 415, type)
      assert.equal(JSON.parse(res.body).error.code, 'pairing/unsupported-media-type')
    }
    assert.equal(store.listDevices().length, 0)
    assert.deepEqual(auditLines(dir), [])
  } finally {
    await stop()
  }
})

test('an oversized body is refused with 413 and is never buffered in full', async () => {
  /* `PAIRING_MAX_BODY_BYTES` is 4 KB. The assertion is not only the status: a
     request far larger than the bound must still ANSWER, which it can only do if
     the excess is drained rather than accumulated (answering mid-upload races the
     413 against a socket reset, and the client loses the answer). */
  const { gateway, store, dir, stop } = await makeGateway()
  try {
    const huge = JSON.stringify({
      pairId: 'pair_x',
      code: 'ABCD2345',
      padding: 'A'.repeat(64 * 1024),
    })
    assert.ok(huge.length > 64 * 1024)

    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: PAIRING_ROUTE_PATH,
      headers: {
        host: lanHost(gateway.port),
        origin: lanOrigin(gateway.port),
        'content-type': 'application/json',
      },
      body: huge,
    })

    assert.equal(res.status, 413)
    assert.equal(JSON.parse(res.body).error.code, 'pairing/body-too-large')
    assert.equal(res.headers.connection, 'close', 'the connection is not reused after a partial read')
    assert.equal(store.listDevices().length, 0)
    assert.deepEqual(auditLines(dir), [], 'an oversized body is not a guess')

    /* The gateway is still serving. */
    const after = await send({ port: gateway.port, path: PAIRING_ROUTE_PATH, headers: { host: lanHost(gateway.port) } })
    assert.equal(after.status, 200)
  } finally {
    await stop()
  }
})

test('a body that is not valid JSON is a 400, not a throw and not a guess', async () => {
  const { gateway, dir, stop } = await makeGateway()
  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: PAIRING_ROUTE_PATH,
      headers: {
        host: lanHost(gateway.port),
        origin: lanOrigin(gateway.port),
        'content-type': 'application/json',
      },
      body: '{"pairId": ',
    })
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(res.body).error.code, 'pairing/invalid-json')
    /* The parse error must not be echoed: it quotes the input. */
    assert.ok(!res.body.includes('pairId'))
    assert.deepEqual(auditLines(dir), [])
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * settings.enabled — the switch is real
 * ------------------------------------------------------------------ */

test('with remote access switched off, BOTH pairing routes are refused', async () => {
  /* `prd.md` D1 and acceptance 1. The panel can turn the switch off while the
     listener is still bound (`requiresReload: true`), so the check is a
     per-request read of the store rather than a value captured at start. */
  const { gateway, pairing, store, dir, upstream, stop } = await makeGateway({ enabled: false })
  try {
    const page = await send({
      port: gateway.port,
      path: PAIRING_ROUTE_PATH,
      headers: { host: lanHost(gateway.port) },
    })
    assert.equal(page.status, 503)
    assert.equal(JSON.parse(page.body).error.code, 'gateway/pairing-disabled')

    const pair = pairing.create()
    const post = await redeem(gateway, pair.pairId, pair.code)
    assert.equal(post.status, 503)
    assert.equal(cookieOf(post), undefined)
    assert.equal(store.listDevices().length, 0, 'the right code mints nothing while off')
    assert.equal(upstream.state.requests.length, 0)
    assert.deepEqual(auditLines(dir).filter((line) => line.event === 'pair'), [])
  } finally {
    await stop()
  }
})

test('switching remote access off takes effect on the NEXT request, with no reload', async () => {
  const { gateway, pairing, store, stop } = await makeGateway()
  try {
    const first = pairing.create()
    assert.equal((await redeem(gateway, first.pairId, first.code)).status, 303)

    store.updateSettings({ enabled: false })

    const second = pairing.create()
    const refused = await redeem(gateway, second.pairId, second.code)
    assert.equal(refused.status, 503, 'the switch is honoured without restarting the listener')
    assert.equal(cookieOf(refused), undefined)
    assert.equal(store.listDevices().length, 1, 'only the device paired before the switch-off')
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * Route surface — one path, two methods, nothing falls through
 * ------------------------------------------------------------------ */

test('a pairing request never reaches the proxy, so it cannot be laundered into an upstream write', async () => {
  /* The property that makes the `authorize()` exemption safe. `proxy.js` is the hop
     that injects the instance-wide `dsh-auth-*` credential and strips `Origin`; the
     stage-2 hole was an exempted request reaching it. This asserts that nothing on
     the pairing path does — including the failure paths, which are the ones a
     future edit is most likely to route through the proxy by accident. */
  const { gateway, pairing, upstream, stop } = await makeGateway()
  try {
    const pair = pairing.create()

    const cases = [
      { method: 'GET', path: PAIRING_ROUTE_PATH, headers: { host: lanHost(gateway.port) } },
      { method: 'POST', path: PAIRING_ROUTE_PATH, headers: { host: lanHost(gateway.port) } },
      { method: 'POST', path: `${PAIRING_ROUTE_PATH}/`, headers: { host: lanHost(gateway.port) } },
      { method: 'PUT', path: PAIRING_ROUTE_PATH, headers: { host: lanHost(gateway.port) } },
    ]
    for (const spec of cases) {
      await send({ port: gateway.port, ...spec })
    }
    await redeem(gateway, pair.pairId, 'ZZZZZZZZ')

    assert.equal(upstream.state.requests.length, 0, 'not one pairing request reached DSH')
  } finally {
    await stop()
  }
})

test('the pairing route accepts only GET, HEAD and POST', async () => {
  const { gateway, stop } = await makeGateway()
  try {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await send({
        port: gateway.port,
        method,
        path: PAIRING_ROUTE_PATH,
        headers: { host: lanHost(gateway.port), origin: lanOrigin(gateway.port) },
      })
      assert.equal(res.status, 405, method)
      assert.equal(JSON.parse(res.body).error.code, 'gateway/method-not-allowed')
      assert.equal(res.headers.allow, 'GET, HEAD, POST')
    }
  } finally {
    await stop()
  }
})

test('a HEAD on the pairing page answers the head and no body', async () => {
  const { gateway, stop } = await makeGateway()
  try {
    const res = await send({
      port: gateway.port,
      method: 'HEAD',
      path: PAIRING_ROUTE_PATH,
      headers: { host: lanHost(gateway.port) },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body, '', 'a HEAD has no body')
    const length = Number(res.headers['content-length'])
    assert.ok(Number.isInteger(length) && length > 0, 'but it declares the document length')
  } finally {
    await stop()
  }
})

test('the pairing page and its inline script parse as real JavaScript', async () => {
  /* `node --check` cannot see inside a template literal, so the page's script is
     the one piece of this package that ships unverified by the syntax gate. A
     syntax error there is invisible to `npm test` and to `check:syntax`, and the
     only symptom would be a phone showing "Reading the pairing link…" forever.
     Parsing it here is cheap and closes that hole; `new Function` compiles without
     running. */
  const { gateway, stop } = await makeGateway()
  try {
    const res = await send({
      port: gateway.port,
      path: PAIRING_ROUTE_PATH,
      headers: { host: lanHost(gateway.port) },
    })
    const scripts = [...res.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    assert.equal(scripts.length, 1, 'the page ships exactly one script')
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new-func
      new Function(scripts[0])
    }, 'the inline script must parse as JavaScript')

    /* And the document is balanced enough to be a document. */
    assert.match(res.body, /^<!doctype html>/)
    assert.match(res.body, /<\/html>\s*$/)
    assert.equal((res.body.match(/<form\b/g) ?? []).length, 1)
  } finally {
    await stop()
  }
})

test('the page is readable from a chat-app tap, but the POST from that origin is not', async () => {
  /* The asymmetry, asserted on both halves with the SAME header.
   *
   * A pairing link is normally tapped in a chat app or a mail client, and a browser
   * reports that top-level navigation as `Sec-Fetch-Site: cross-site`. Fencing the
   * GET would refuse the page in the single most common way a link is opened — and
   * would protect nothing, because the page is a constant and the POST it makes is
   * same-origin. So the read is lenient and the write is not.
   *
   * Both halves have to be tested together: a future edit that "tightened" the read
   * breaks real use, and one that loosened the write is a CSRF hole. One assertion
   * per half, one request shape. */
  const { gateway, pairing, store, upstream, stop } = await makeGateway()
  try {
    const crossSiteGet = await send({
      port: gateway.port,
      path: PAIRING_ROUTE_PATH,
      headers: {
        host: lanHost(gateway.port),
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        accept: 'text/html',
      },
    })
    assert.equal(crossSiteGet.status, 200, 'a tapped link still opens the pairing page')
    assert.match(crossSiteGet.headers['content-type'], /text\/html/)
    assert.equal(crossSiteGet.headers['x-frame-options'], 'DENY', 'and it still cannot be framed')
    assert.equal(upstream.state.requests.length, 0)

    /* The very same origin, doing a WRITE. This is the CSRF attempt. */
    const pair = pairing.create()
    const crossSitePost = await send({
      port: gateway.port,
      method: 'POST',
      path: PAIRING_ROUTE_PATH,
      headers: {
        host: lanHost(gateway.port),
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pairId: pair.pairId, code: pair.code }),
    })
    assert.equal(crossSitePost.status, 403, 'the write from a cross-site origin is refused')
    assert.equal(JSON.parse(crossSitePost.body).error.code, 'gateway/cross-origin')
    assert.equal(store.listDevices().length, 0, 'and no device was created')
    assert.equal(pairing.pending(), 1, 'and the code is still usable by the legitimate device')
  } finally {
    await stop()
  }
})

test('a path that merely starts with the pairing route is NOT the pairing route', async () => {
  /* Exact match plus the trailing-slash spelling, deliberately not a prefix. The
     stage-3 CSWSH defect was a rule shared with a request shape it was not written
     for; a `/remote-control/pair/anything` that inherited the bootstrap exemption
     would be the same mistake again (`quality-guidelines.md` §17). */
  const { gateway, upstream, stop } = await makeGateway()
  try {
    const res = await send({
      port: gateway.port,
      path: `${PAIRING_ROUTE_PATH}/extra`,
      headers: { host: lanHost(gateway.port) },
    })
    /* It falls through to `authorize`, which answers 401 for a device with no
       cookie — never the pairing page, and never an upstream request. */
    assert.equal(res.status, 401)
    assert.equal(upstream.state.requests.length, 0)
  } finally {
    await stop()
  }
})

test('the admin API prefix is still refused on the pairing path family', async () => {
  /* The two exemptions must not overlap: `/remote-control/api` stays refused even
     though `/remote-control/pair` is now served here. */
  const { gateway, stop } = await makeGateway()
  try {
    const res = await send({
      port: gateway.port,
      method: 'POST',
      path: '/remote-control/api/pairing',
      headers: { host: lanHost(gateway.port), origin: lanOrigin(gateway.port) },
      body: '{}',
    })
    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).error.code, 'gateway/admin-not-here')
  } finally {
    await stop()
  }
})

/* ------------------------------------------------------------------ *
 * A host that did not wire the pairing store
 * ------------------------------------------------------------------ */

test('a gateway with no pairing store answers 503 rather than a misleading 401', async () => {
  /* `startGateway` treats the pairing store as optional so a host that never
     mounted one still gets a listener. The ONE thing it must not do is let an
     unpaired phone conclude "pair first" from a 401 when pairing cannot happen. */
  const dir = makeTempDir()
  const clock = { now: AT }
  const store = createStore({ baseDir: dir, now: () => clock.now })
  store.updateSettings({ enabled: true })

  const upstream = createServer((req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  const gateway = await startGateway({
    ctx: { effect: () => () => {}, get: () => undefined },
    store,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    jwtKey: TEST_JWT_KEY,
  })
  started.push(async () => {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
    cleanupDir(dir)
  })

  const page = await send({
    port: gateway.port,
    path: PAIRING_ROUTE_PATH,
    headers: { host: lanHost(gateway.port) },
  })
  assert.equal(page.status, 200, 'the page still explains what to do')

  const post = await send({
    port: gateway.port,
    method: 'POST',
    path: PAIRING_ROUTE_PATH,
    headers: {
      host: lanHost(gateway.port),
      origin: lanOrigin(gateway.port),
      'content-type': 'application/json',
    },
    body: '{"pairId":"pair_x","code":"ABCD2345"}',
  })
  assert.equal(post.status, 503)
  assert.equal(JSON.parse(post.body).error.code, 'pairing/unavailable')
})
