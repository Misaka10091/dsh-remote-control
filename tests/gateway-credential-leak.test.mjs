/**
 * The credential never leaves the process except to the device that owns it.
 *
 * This is the file-wide assertion the project's rules demand
 * (`quality-guidelines.md` §6: no token, cookie, pairing code or message body in a
 * log, an audit record, or a response body). It is deliberately NOT folded into the
 * per-module suites: those test one module's behaviour, and the leak being guarded
 * against here is a property of the WHOLE run — a JWT could land in a log line in
 * `server.js`, an audit field in `api.js`, or a response header in `proxy.js`, and
 * every one of those would look fine to a module-local test.
 *
 * The whole flow is driven through a real gateway: pair a device over a socket,
 * use the credential, be refused, be revoked, be refused again, and fail to pair
 * with a wrong code. Everything the run produces — the logger's lines, the audit
 * file on disk, every response header and body — is then searched for the JWT, its
 * signature segment, the pairing code, the signing key, and the inner credential.
 *
 * Why the signature segment separately: the header and payload of a JWT are public
 * (a base64url of a constant claim set), so a leak of those two would often be a
 * coincidence. The signature is the secret part; if it appears anywhere, the whole
 * token has leaked.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { createAudit, dayKeyOf } from '../src/host/audit.js'
import { ADMIN_API_PREFIX, DEVICE_COOKIE_NAME, PAIRING_ROUTE_PATH } from '../src/host/constants.js'
import { createPairingStore } from '../src/host/pairing.js'
import { createStore } from '../src/host/store.js'
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
 * A gateway whose logger CAPTURES every line, so a leak is assertable.
 *
 * Every level is captured, not just the ones the code currently uses: a future
 * `debug` line is exactly the place a token would be added "for diagnosis".
 */
async function makeCapturingGateway() {
  const dir = makeTempDir()
  const clock = { now: AT }
  const store = createStore({ baseDir: dir, now: () => clock.now })
  store.updateSettings({ enabled: true })

  const audit = createAudit({ baseDir: dir, now: () => clock.now })
  const pairing = createPairingStore({
    now: () => clock.now,
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

  /** Every line every level produced. */
  const log = []
  const logger = {
    debug: (message) => log.push({ level: 'debug', message: String(message) }),
    info: (message) => log.push({ level: 'info', message: String(message) }),
    warn: (message) => log.push({ level: 'warn', message: String(message) }),
    error: (message) => log.push({ level: 'error', message: String(message) }),
  }

  /** Every response the upstream stub saw, so a forwarded credential is visible. */
  const upstreamSaw = []
  const upstream = createServer((req, res) => {
    upstreamSaw.push({ url: req.url, headers: { ...req.headers } })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  const gateway = await startGateway({
    ctx: { effect: () => () => {}, get: () => undefined },
    store,
    pairing,
    officialPort: upstream.address().port,
    port: 0,
    host: '127.0.0.1',
    cookieName: DEVICE_COOKIE_NAME,
    /* The REAL key management is exercised too, so the key file that a bug could
       leak is actually on disk under the temp dir. */
    baseDir: dir,
    audit,
    logger,
    now: () => clock.now,
  })

  const stop = async () => {
    await gateway.close()
    await new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve) })
    cleanupDir(dir)
  }
  started.push(stop)

  return { gateway, store, pairing, audit, clock, dir, upstream, upstreamSaw, log, stop }
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

/** The `Host` a remote device sends: a LAN authority over a real loopback socket. */
function lanHost(port) {
  return `192.168.1.7:${String(port)}`
}

/** The `Origin` matching that authority. */
function lanOrigin(port) {
  return `http://${lanHost(port)}`
}

/** The JWT out of a `Set-Cookie` value. */
function tokenOf(res) {
  const raw = res.headers['set-cookie']
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const match = /^dsh-rc-jwt=([^;]+)/.exec(raw[0])
  return match === null ? undefined : match[1]
}

/**
 * Everything observable about one response, EXCEPT the `set-cookie` header.
 *
 * The credential has to reach its own device somehow, and the pairing response's
 * `Set-Cookie` is that delivery — excluding it is what makes the assertion mean "the
 * token appears nowhere it does not have to" rather than "the feature does not
 * work". Every other header and the whole body is included, so a token echoed into
 * a body, a log-shaped header or an error message is still caught.
 *
 * The `set-cookie` header is searched separately and strictly: the only value it may
 * ever hold is the credential cookie itself, and only on the pairing response.
 */
function flattenExceptSetCookie(res) {
  const headerText = Object.entries(res.headers)
    .filter(([name]) => name !== 'set-cookie')
    .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join('\n') : String(value)}`)
    .join('\n')
  return `${headerText}\n\n${res.body}`
}

/** The `set-cookie` values of a response, as one searchable string. */
function setCookieText(res) {
  const raw = res.headers['set-cookie']
  if (raw === undefined) return ''
  return Array.isArray(raw) ? raw.join('\n') : String(raw)
}

/**
 * Drive one complete lifecycle and return everything it produced.
 *
 * The point is coverage of the OUTPUTS, not of the flow — the flow is asserted in
 * `gateway-pairing.test.mjs`. So this deliberately triggers every kind of line and
 * record the gateway can write: a successful pair, an admitted request, a revoke, a
 * refusal of a revoked device, a refusal with no credential, a cross-site write, a
 * wrong pairing code, an admin-API refusal, and a request to an unpaired path.
 */
async function runLifecycle() {
  const env = await makeCapturingGateway()
  const { gateway, pairing, store } = env
  const responses = []

  /* A successful pairing: the one response that carries a real credential. */
  const pair = pairing.create({ label: 'phone' })
  const paired = await send({
    port: gateway.port,
    method: 'POST',
    path: PAIRING_ROUTE_PATH,
    headers: { host: lanHost(gateway.port), origin: lanOrigin(gateway.port), 'content-type': 'application/json' },
    body: JSON.stringify({ pairId: pair.pairId, code: pair.code }),
  })
  responses.push({ label: 'pair success', res: paired })
  const jwt = tokenOf(paired)
  assert.ok(typeof jwt === 'string', 'the pairing produced a JWT to search for')

  /* An admitted request: the credential is used and forwarded. */
  responses.push({
    label: 'admitted read',
    res: await send({
      port: gateway.port,
      path: '/api/session/list',
      headers: { host: lanHost(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${jwt}` },
    }),
  })

  /* Admitting also writes an audit line with a `path`, and activity data. */
  responses.push({
    label: 'admitted write',
    res: await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/session/prompt',
      headers: {
        host: lanHost(gateway.port),
        cookie: `${DEVICE_COOKIE_NAME}=${jwt}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: '{"text":"a message body that must never be audited"}',
    }),
  })

  /* Every refusal shape. */
  responses.push({
    label: 'no cookie',
    res: await send({ port: gateway.port, path: '/', headers: { host: lanHost(gateway.port), accept: 'text/html' } }),
  })
  responses.push({
    label: 'cross-site write',
    res: await send({
      port: gateway.port,
      method: 'POST',
      path: '/api/message',
      headers: { host: lanHost(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${jwt}`, origin: 'https://evil.example' },
      body: '{}',
    }),
  })
  responses.push({
    label: 'admin API on the gateway port',
    res: await send({
      port: gateway.port,
      path: `${ADMIN_API_PREFIX}/devices`,
      headers: { host: lanHost(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${jwt}` },
    }),
  })
  responses.push({
    label: 'wrong pairing code',
    res: await send({
      port: gateway.port,
      method: 'POST',
      path: PAIRING_ROUTE_PATH,
      headers: { host: lanHost(gateway.port), origin: lanOrigin(gateway.port), 'content-type': 'application/json' },
      body: JSON.stringify({ pairId: pairing.create().pairId, code: 'ZZZZZZZZ' }),
    }),
  })

  /* The revoke, then the refusal that carries the cookie deletion. */
  const [device] = store.listDevices()
  gateway.revokeDevice(device.id)
  responses.push({
    label: 'revoked',
    res: await send({
      port: gateway.port,
      path: '/api/session/list',
      headers: { host: lanHost(gateway.port), cookie: `${DEVICE_COOKIE_NAME}=${jwt}` },
    }),
  })

  return { ...env, jwt, pair, responses, key: gateway.jwtKey }
}

test('no JWT, key, pairing code or inner credential reaches a log, an audit record or a response', async () => {
  const env = await runLifecycle()
  try {
    const { jwt, pair, responses, log, dir, key } = env
    const signature = jwt.split('.')[2]
    const keyHex = Buffer.from(key).toString('hex')
    const keyBase64 = Buffer.from(key).toString('base64')

    /** The secrets that must appear nowhere. */
    const secrets = [
      ['the JWT', jwt],
      ['its signature segment', signature],
      ['the signing key (hex)', keyHex],
      ['the signing key (base64)', keyBase64],
      ['the pairing code', pair.code],
    ]
    /* `pairId` is deliberately NOT in that list: it is an opaque `pair_*` identifier
       that the audit records on purpose, for correlation
       (`research/official-connection-fence.md` §7.3). The CODE is the credential; the
       id is a name. */

    /* 1. Every log line, at every level. */
    assert.ok(log.length > 0, 'the run produced log lines, so the assertion is not vacuous')
    for (const line of log) {
      for (const [label, secret] of secrets) {
        assert.ok(!line.message.includes(secret), `a ${line.level} line carries ${label}: ${line.message}`)
      }
    }

    /* 2. Every response header and body, minus the one header that must carry the
          credential (see `flattenExceptSetCookie`). */
    for (const { label, res } of responses) {
      const text = flattenExceptSetCookie(res)
      for (const [name, secret] of secrets) {
        assert.ok(!text.includes(secret), `the "${label}" response carries ${name}`)
      }
      /* The inner credential is the instance-wide one: it must never appear on this
         side of the hop at all (`design.md` §4.4 security red line). */
      assert.ok(!/dsh-auth-/i.test(text), `the "${label}" response carries inner credential material`)
      /* Nor a file path or an upstream URL (`error-handling.md`). */
      assert.ok(!text.includes(dir), `the "${label}" response carries a filesystem path`)
      assert.ok(!/127\.0\.0\.1:\d+/.test(text), `the "${label}" response carries the upstream authority`)

      /* The `set-cookie` header, searched strictly: on the pairing response it is
         the credential (the point of the response), and on the revoked response it
         is the DELETION — a cookie named `dsh-rc-jwt` with an empty value. Nowhere
         may it carry the signing key or the pairing code. */
      const cookies = setCookieText(res)
      for (const [name, secret] of secrets) {
        if (name === 'the JWT' || name === 'its signature segment') continue
        assert.ok(!cookies.includes(secret), `the "${label}" response's set-cookie carries ${name}`)
      }
      if (label !== 'pair success') {
        assert.ok(
          !cookies.includes(jwt),
          `only the pairing response may hand out the JWT, and "${label}" did`,
        )
      }
      if (label === 'revoked') {
        assert.match(cookies, /^dsh-rc-jwt=;/, 'the revoked response clears the cookie rather than replaying it')
      }
    }

    /* 3. The audit trail on disk, file-wide. */
    const auditFiles = readdirSync(dir).filter((entry) => entry.startsWith('audit-'))
    assert.ok(auditFiles.length > 0, 'the run produced an audit file, so this is not vacuous')
    for (const file of auditFiles) {
      const text = readFileSync(path.join(dir, file), 'utf8')
      for (const [label, secret] of secrets) {
        assert.ok(!text.includes(secret), `the audit trail carries ${label}`)
      }
      /* A message body is on the never-record list (`prd.md` D5). */
      assert.ok(!text.includes('a message body that must never be audited'), 'the audit trail carries a message body')
    }

    /* 4. Every file in the runtime directory, not only the audit trail. A JWT
          written into `devices.json` would be a credential at rest. */
    for (const file of readdirSync(dir)) {
      const text = readFileSync(path.join(dir, file), 'utf8')
      assert.ok(!text.includes(jwt), `${file} carries the JWT`)
      assert.ok(!text.includes(signature), `${file} carries the JWT signature`)
      assert.ok(!text.includes(pair.code), `${file} carries the pairing code`)
      /* The key file itself obviously holds the key; its NAME must not leak into any
         other file, and it must not be world-readable (checked in jwt-key.test.mjs). */
      if (file !== 'jwt-key') {
        assert.ok(!text.includes(keyHex), `${file} carries the signing key`)
        assert.ok(!text.includes(keyBase64), `${file} carries the signing key (base64)`)
      }
    }

    /* 5. What the upstream DID see, contrasted on purpose: the forwarded request
          carries the device cookie (the gateway is a proxy, and the device's own
          cookie is not a secret from the hop it chose to talk to), but it must NOT
          carry the signing key, and no response ever carried the inner credential. */
    const forwarded = env.upstreamSaw.map((entry) => entry.headers.cookie ?? '').join('\n')
    assert.ok(forwarded.includes('dsh-rc-jwt='), 'the device cookie is forwarded, as designed')
    assert.ok(!forwarded.includes(keyHex), 'but never the signing key')
  } finally {
    await env.stop()
  }
})

test('the audit trail records actions and identifiers, never content', async () => {
  /* The other half of the same rule, asserted positively: the trail must actually
     contain the events, or "nothing leaked" would be satisfiable by recording
     nothing at all.
   *
   * The `revoke` event is deliberately NOT asserted here: it is written by
   * `api.js` from the panel action, not by `gateway.revokeDevice` (which is the
   * store + socket half — `quality-guidelines.md` §18 keeps one entry point for the
   * EFFECT, and the audit record belongs to the route that performed it). The
   * `tests/admin-api.test.mjs` suite covers that line. */
  const env = await runLifecycle()
  try {
    const { dir } = env
    const lines = readdirSync(dir)
      .filter((entry) => entry.startsWith('audit-'))
      .flatMap((file) => readFileSync(path.join(dir, file), 'utf8').split('\n'))
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))

    const events = new Set(lines.map((line) => line.event))
    assert.ok(events.has('pair'), 'the successful pairing is recorded')
    assert.ok(events.has('pair_failed'), 'the failed guess is recorded')
    /* The admitted POST `/api/session/prompt` is classified as `send_message`
       (`classify.js`), which is the action it actually is — not a generic `connect`. */
    assert.ok(events.has('send_message'), 'the admitted action is recorded')
    assert.ok(events.size >= 3, `several event kinds are present, got: ${[...events].join(', ')}`)

    for (const line of lines) {
      /* `ts`, `event` and identifiers only. A `meta` key outside the whitelist would
         be a field nobody validated. */
      for (const [key, value] of Object.entries(line)) {
        assert.ok(
          ['ts', 'event', 'deviceId', 'ip', 'meta'].includes(key),
          `unexpected audit field: ${key}`,
        )
        if (key === 'meta') {
          for (const metaKey of Object.keys(value)) {
            assert.ok(
              ['sessionId', 'pairId', 'turnId', 'requestId', 'count', 'method', 'path', 'status', 'code', 'closedSockets'].includes(metaKey),
              `unexpected meta field: ${metaKey}`,
            )
          }
        }
      }
    }
  } finally {
    await env.stop()
  }
})

test('the key file is the only place the signing key exists', async () => {
  /* Belt and braces on the sibling concern: the key must be on disk (so a restart
     keeps devices paired) and NOT copied into any other file. Driven through one
     real pairing first, so the audit file and `devices.json` both exist and the loop
     below searches real content rather than an empty directory. */
  const env = await makeCapturingGateway()
  try {
    /* One real pairing, so the audit file and `devices.json` both exist and the loop
       below searches real content rather than an empty directory. */
    const pair = env.pairing.create()
    const paired = await send({
      port: env.gateway.port,
      method: 'POST',
      path: PAIRING_ROUTE_PATH,
      headers: { host: lanHost(env.gateway.port), origin: lanOrigin(env.gateway.port), 'content-type': 'application/json' },
      body: JSON.stringify({ pairId: pair.pairId, code: pair.code }),
    })
    assert.equal(paired.status, 303, 'a device was really paired')

    const files = readdirSync(env.dir)
    assert.ok(files.includes('jwt-key'), 'the key is persisted')
    assert.ok(files.includes('devices.json'), 'the device table was written')
    assert.ok(files.some((file) => file === `audit-${dayKeyOf(AT)}.jsonl`), 'the audit file was written')

    const keyHex = Buffer.from(env.gateway.jwtKey).toString('hex')
    for (const file of files) {
      const text = readFileSync(path.join(env.dir, file), 'latin1')
      if (file === 'jwt-key') {
        assert.equal(text.length, 32, 'and it is exactly 32 raw bytes')
        continue
      }
      assert.ok(!text.includes(keyHex), `${file} must not hold the key`)
      assert.ok(!text.includes('jwt-key'), `${file} must not even name the key file`)
    }
  } finally {
    await env.stop()
  }
})
