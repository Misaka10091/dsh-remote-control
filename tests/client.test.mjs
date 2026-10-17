/**
 * Client-half invariants and behaviour the browser cannot be tested for.
 *
 * The browser half has no DOM test environment (no jsdom, by design —
 * `.trellis/spec/frontend/quality-guidelines.md`). What CAN be verified without
 * a DOM falls into two groups, and both live here:
 *
 *   1. **Load-contract invariants.** This file is a plain script wrapped in
 *      `window.__ModuleLoader__.load({ id, factory })`, so its dependencies must
 *      arrive through `factory(require)`. A top-level `import` is valid ESM and
 *      therefore passes `node --check`, but it breaks the loader contract — only
 *      an assertion catches it. `tests/package.test.mjs` covers the file-level
 *      shape; the tests below cover the RUNTIME shape (what the factory actually
 *      asks for, what it registers, and that a plugin disable leaves nothing).
 *
 *   2. **The pure decision surface.** URL construction, failure classification,
 *      the pairing link built around a URL fragment, and the dictionaries are
 *      plain functions of their arguments. These are exactly the parts that must
 *      not ship unverified: a mount-relative path that silently resolves against
 *      the origin root 404s under a sub-path deployment, and a 403 rendered as
 *      "load failed" sends a user to the wrong place for the wrong reason.
 *
 * What is NOT covered here, and must not be claimed as verified: rendering,
 * focus behaviour, `Esc` handling, clipboard writes, the poll ticking in a real
 * page, and the export download. Those need the real GUI (`implement.md` stage 6).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readFileSync(path.join(repoRoot, 'src/client.js'), 'utf8')

/** Read and parse a repo-root JSON file. */
function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

/**
 * Minimal React stand-in.
 *
 * The factory only needs `createElement` at materialization time; the hooks are
 * never called because no component is rendered here. `createElement` returns a
 * small descriptor so a test could inspect a tree, but nothing currently does —
 * the point is that `require('react')` must not throw.
 */
const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}

/**
 * Execute `src/client.js` against a fake `window.__ModuleLoader__` and return
 * the materialized bundle exports plus the raw registration.
 *
 * The file is evaluated with `new Function` rather than `import()` on purpose:
 * it is not an ES module, and importing it would be testing a different thing
 * than what a browser does with it.
 *
 * @param {{ React?: object, onWarn?: (message: string) => void }} [options]
 * @returns {{
 *   registration: { id: string, factory: Function },
 *   bundle: any,
 *   required: string[],
 * }}
 */
function loadClientBundle(options = {}) {
  const react = options.React ?? REACT_STUB
  const registrations = []
  const required = []

  const previousWindow = globalThis.window
  const previousConsole = globalThis.console
  globalThis.window = {
    __ModuleLoader__: {
      load: (registration) => {
        registrations.push(registration)
      },
    },
  }
  if (options.onWarn !== undefined) {
    /* The browser half's only sink when no host logger exists is the console; a
       test that asserts the warning must not also print it. */
    globalThis.console = { ...previousConsole, warn: (message) => options.onWarn(String(message)) }
  }

  try {
    /* eslint-disable-next-line no-new-func */
    new Function(clientSource)()
  } finally {
    globalThis.window = previousWindow
    if (options.onWarn !== undefined) globalThis.console = previousConsole
  }

  assert.equal(registrations.length, 1, 'the file must submit exactly one ModuleLoader registration')
  const registration = registrations[0]
  assert.equal(typeof registration.id, 'string')
  assert.equal(typeof registration.factory, 'function')

  const bundle = registration.factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return react
    /* Any other request is a contract violation this test must surface, not
       something to stub out: the baseline table is what the browser can answer. */
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })

  return { registration, bundle, required }
}

/** A fake Cordis client context recording every effect and service probe. */
function makeContext(services = {}) {
  const effects = []
  const warnings = []
  const ctx = {
    effect(acquire, label) {
      const release = acquire()
      effects.push({ label, release: typeof release === 'function' ? release : () => {} })
      return release
    },
    get(name) {
      return services[name]
    },
    ...services,
  }
  return { ctx, effects, warnings }
}

/** A fake slot service recording injections and registrations. */
function makeSlots() {
  const injected = []
  const registered = []
  return {
    inject(name, factory) {
      injected.push(name)
      const release = factory()
      return () => {
        if (typeof release === 'function') release()
      }
    },
    register(options, Component) {
      registered.push({ options, Component })
      return () => {}
    },
    injected,
    registered,
  }
}

/* ---------------------------------------------------------------------- *
 * Load contract
 * ---------------------------------------------------------------------- */

test('the bundle registers one entry under the package name and requires only the baseline', () => {
  const { registration, bundle, required } = loadClientBundle()

  assert.equal(registration.id, '@misaka10091/dsh-remote-control')
  assert.equal(bundle.name, 'dsh-remote-control')
  assert.equal(typeof bundle.apply, 'function')

  /* Exactly the modules the host seeds into the platform table. A request for
     anything else fails at boot in the browser, where no test can see it. */
  assert.deepEqual(required, ['react'])
})

test('the bundle declares the one service it cannot work without', () => {
  const { bundle } = loadClientBundle()

  /* `slots` is required: without the slot service there is no seat to fill.
     `locale` is deliberately NOT declared — a composition without it must still
     mount the panel (English fallback) instead of parking the plugin forever. */
  assert.deepEqual(bundle.inject, ['slots'])
  assert.ok(!bundle.inject.includes('locale'), 'locale must stay optional')
})

test('applying the plugin registers the sidebar footer seat exactly once', () => {
  const { bundle } = loadClientBundle()
  const slots = makeSlots()
  const { ctx } = makeContext({ slots })

  bundle.apply(ctx)

  assert.deepEqual(slots.injected, ['sidebar.footer.action'])
  assert.equal(slots.registered.length, 1)
  assert.equal(slots.registered[0].options.name, 'sidebar.footer.action')
  assert.equal(slots.registered[0].options.id, 'remote-control')
  assert.equal(slots.registered[0].options.locale, 'remote-control')
  assert.equal(typeof slots.registered[0].Component, 'function')
})

test('every registration is owned by an effect, so disabling the plugin leaves nothing', () => {
  const { bundle } = loadClientBundle()
  const slots = makeSlots()
  let released = 0
  const release = slots.inject
  slots.inject = (name, factory) => {
    const disposer = release(name, factory)
    return () => {
      released += 1
      disposer()
    }
  }

  const { ctx, effects } = makeContext({ slots, locale: makeLocale() })
  bundle.apply(ctx)

  /* One effect per owned resource: dictionaries, styles, the seat. A resource
     registered outside an effect cannot be released on hot reload. */
  const labels = effects.map((entry) => entry.label)
  assert.ok(labels.includes('remote-control: sidebar footer action'), 'the seat must be effect-owned')
  assert.ok(labels.includes('remote-control: dictionaries'), 'the dictionaries must be effect-owned')
  assert.ok(labels.includes('remote-control: styles'), 'the stylesheet must be effect-owned')

  for (const entry of effects) assert.equal(typeof entry.release, 'function')
  for (const entry of effects) entry.release()
  assert.equal(released, 1, 'releasing the effects must release the seat')
})

test('a host without the slot service warns once instead of throwing', () => {
  const { bundle } = loadClientBundle()
  const { ctx } = makeContext({})

  /* The console stub has to wrap the APPLY call, not the load: the warning is
     emitted from `apply`, which the test drives. */
  const warnings = []
  const previousConsole = globalThis.console
  globalThis.console = { ...previousConsole, warn: (message) => warnings.push(String(message)) }
  try {
    /* Unmountable composition: the panel simply is not shown, and the user gets a
       reason rather than a blank sidebar (`quality-guidelines.md` §5 — visible
       degradation). Throwing here would fail the whole plugin row. */
    assert.doesNotThrow(() => bundle.apply(ctx))
  } finally {
    globalThis.console = previousConsole
  }

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /\[remote-control\]/)
})

test('a host without the locale service still mounts the panel in English', () => {
  const { bundle } = loadClientBundle()
  const slots = makeSlots()
  const { ctx, effects } = makeContext({ slots })

  assert.doesNotThrow(() => bundle.apply(ctx))
  assert.equal(slots.registered.length, 1, 'the seat must register without a translator')
  /* No dictionary effect was attempted, because there is no locale service. */
  assert.ok(!effects.some((entry) => entry.label === 'remote-control: dictionaries'))
})

/** A locale service recording registrations. */
function makeLocale() {
  const registrations = []
  return {
    register(namespace, dictionaries) {
      registrations.push({ namespace, dictionaries })
      return () => {}
    },
    registrations,
  }
}

/* ---------------------------------------------------------------------- *
 * Dictionaries
 * ---------------------------------------------------------------------- */

test('the two shipped dictionaries are key-identical and value-distinct', () => {
  const { bundle } = loadClientBundle()
  const { ZH, EN } = bundle.internals

  const zhKeys = Object.keys(ZH).sort()
  const enKeys = Object.keys(EN).sort()
  assert.deepEqual(zhKeys, enKeys, 'a key present in one language must exist in the other')

  for (const key of zhKeys) {
    assert.equal(typeof ZH[key], 'string')
    assert.equal(typeof EN[key], 'string')
    assert.ok(ZH[key].length > 0, `zh.${key} must not be empty`)
    assert.ok(EN[key].length > 0, `en.${key} must not be empty`)
    /* Placeholder sets must match or a template renders a literal `{count}`. */
    const placeholders = (text) => (text.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort()
    assert.deepEqual(placeholders(ZH[key]), placeholders(EN[key]), `placeholders differ for ${key}`)
  }
})

test('locale/*.json agree with the inline dictionaries the bundle actually ships', () => {
  const { bundle } = loadClientBundle()
  const { ZH, EN } = bundle.internals
  const zhFile = readJson('locale/zh.json')
  const enFile = readJson('locale/en.json')

  /* The bundle cannot fetch its own locale files (the loader serves it from a
     combo URL), so the strings are inline. These assertions are what keep the
     shipped copy and the reviewed copy from drifting: a mismatch means one of
     the two was edited alone. */
  assert.deepEqual(Object.keys(zhFile).sort(), Object.keys(ZH).sort(), 'locale/zh.json is out of sync')
  assert.deepEqual(Object.keys(enFile).sort(), Object.keys(EN).sort(), 'locale/en.json is out of sync')
  assert.deepEqual(zhFile, ZH)
  assert.deepEqual(enFile, EN)
})

test('every failure kind has its own, distinct pair of messages', () => {
  const { bundle } = loadClientBundle()
  const { FAILURE_KINDS, ZH, EN } = bundle.internals

  const titles = new Set()
  for (const kind of FAILURE_KINDS) {
    for (const dictionary of [ZH, EN]) {
      assert.equal(typeof dictionary[`error.${kind}.title`], 'string', `error.${kind}.title is missing`)
      assert.equal(typeof dictionary[`error.${kind}.body`], 'string', `error.${kind}.body is missing`)
    }
    const title = ZH[`error.${kind}.title`]
    /* 「不要统一显示"失败"」: two conditions sharing a title is the defect. */
    assert.ok(!titles.has(title), `duplicate failure title for ${kind}`)
    titles.add(title)
  }

  /* The one the spec calls out by name must say "local only", not "failed". */
  assert.match(ZH['error.loopback.title'], /仅本机/)
  assert.match(EN['error.loopback.title'], /local-only/i)
})

test('every audit event in the host closed set has a label', () => {
  const { bundle } = loadClientBundle()
  /* Read the host's authoritative list rather than re-listing it: a new event
     added there must not reach the panel as a raw identifier. */
  const auditSource = readFileSync(path.join(repoRoot, 'src/host/audit.js'), 'utf8')
  const block = /export const AUDIT_EVENTS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(auditSource)
  assert.ok(block !== null, 'AUDIT_EVENTS must be discoverable in src/host/audit.js')

  const events = [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  assert.ok(events.length > 0)
  for (const event of events) {
    assert.equal(typeof bundle.internals.ZH[`audit.event.${event}`], 'string', `zh label missing for ${event}`)
    assert.equal(typeof bundle.internals.EN[`audit.event.${event}`], 'string', `en label missing for ${event}`)
  }
})

/* ---------------------------------------------------------------------- *
 * Request targets
 * ---------------------------------------------------------------------- */

test('the admin API is addressed with a mount-relative path, never an absolute one', () => {
  const { bundle } = loadClientBundle()
  const { adminUrl, API_BASE } = bundle.internals

  /* Forbidden pattern 5: a hard-coded `/…` path resolves against the origin
     root, so a GUI served under a sub-path 404s with no visible cause. */
  assert.ok(!API_BASE.startsWith('/'), 'API_BASE must be mount-relative')

  assert.equal(
    adminUrl('devices', 'http://127.0.0.1:3080/'),
    'http://127.0.0.1:3080/remote-control/api/devices',
  )
  /* Under a sub-path the segment is preserved — the whole point of the rule. */
  assert.equal(
    adminUrl('devices', 'http://127.0.0.1:3080/gui/'),
    'http://127.0.0.1:3080/gui/remote-control/api/devices',
  )
  /* A leading slash in the caller's suffix must not escape the mount. */
  assert.equal(
    adminUrl('/audit/export', 'http://127.0.0.1:3080/gui/'),
    'http://127.0.0.1:3080/gui/remote-control/api/audit/export',
  )
  /* No suffix addresses the state read. */
  assert.equal(adminUrl(undefined, 'http://127.0.0.1:3080/'), 'http://127.0.0.1:3080/remote-control/api')
})

/* ---------------------------------------------------------------------- *
 * Failure classification
 * ---------------------------------------------------------------------- */

test('the four documented failure states are told apart', () => {
  const { classifyFailure } = loadClientBundle().bundle.internals

  /* 403 with the API's loopback code: this machine only. */
  assert.equal(classifyFailure(403, { ok: false, error: { code: 'admin/loopback-only' } }, true), 'loopback')
  /* 403 from the origin fence is a different fix, so it is a different state. */
  assert.equal(classifyFailure(403, { ok: false, error: { code: 'admin/cross-origin' } }, true), 'crossOrigin')
  /* 409 is the "gateway not listening" answer. */
  assert.equal(classifyFailure(409, { ok: false, error: { code: 'gateway/not-listening' } }, true), 'gatewayDown')
  /* A transport failure has no status at all. */
  assert.equal(classifyFailure(null, null, false), 'network')
  assert.equal(classifyFailure(undefined, null, false), 'network')
  /* Server faults. */
  assert.equal(classifyFailure(500, null, true), 'server')
  assert.equal(classifyFailure(503, null, true), 'server')
})

test('a 200 that is not JSON means the route is not mounted, not a server fault', () => {
  const { classifyFailure } = loadClientBundle().bundle.internals

  /* The official server's SPA fallback answers an unknown route with 200 + HTML.
     Reporting that as a server error sends the user looking in the host log for
     a fault that is really "the plugin's route is not there". */
  assert.equal(classifyFailure(200, null, false), 'notMounted')
  assert.equal(classifyFailure(404, null, false), 'notMounted')
})

test('every kind the classifier can return is renderable', () => {
  const { classifyFailure, FAILURE_KINDS, ZH } = loadClientBundle().bundle.internals

  const produced = new Set([
    classifyFailure(403, null, true),
    classifyFailure(403, { error: { code: 'admin/cross-origin' } }, true),
    classifyFailure(409, null, true),
    classifyFailure(404, null, true),
    classifyFailure(null, null, false),
    classifyFailure(500, null, true),
    classifyFailure(200, null, true),
  ])
  /* An unrenderable kind would fall through to a raw key on screen. */
  for (const kind of produced) {
    assert.ok(FAILURE_KINDS.includes(kind), `${kind} is not a declared failure kind`)
    assert.equal(typeof ZH[`error.${kind}.title`], 'string')
  }
})

/* ---------------------------------------------------------------------- *
 * Pairing
 * ---------------------------------------------------------------------- */

test('the pairing link carries the code in the fragment, never the query', () => {
  const { pairingUrl } = loadClientBundle().bundle.internals

  const url = pairingUrl(
    { fragment: 'pair_abc:ABCD1234', pairPath: '/remote-control/pair', port: 3090 },
    'http://192.168.1.7:3080/',
  )
  assert.equal(url, 'http://192.168.1.7:3090/remote-control/pair#pair_abc:ABCD1234')

  const parsed = new URL(url)
  /* The whole reason for the fragment (`design.md` §3.1 step 3): a fragment is
     never sent to a server, so the one-time code cannot land in an access log. */
  assert.equal(parsed.search, '', 'the code must not be in the query string')
  assert.equal(parsed.hash, '#pair_abc:ABCD1234')
  assert.equal(parsed.pathname, '/remote-control/pair')
})

test('the pairing link uses the gateway port, which is the only reachable listener', () => {
  const { pairingUrl } = loadClientBundle().bundle.internals

  /* The desktop page is on the official port (3080); a phone cannot reach that,
     so the link must point at the gateway instead. */
  assert.equal(
    pairingUrl({ fragment: 'p:c', port: 3090 }, 'http://127.0.0.1:3080/'),
    'http://127.0.0.1:3090/remote-control/pair#p:c',
  )
  /* With no gateway there is no port to offer, and the page's own is the honest
     fallback (the panel also warns that nothing is listening). */
  assert.equal(
    pairingUrl({ fragment: 'p:c', port: null }, 'http://127.0.0.1:3080/'),
    'http://127.0.0.1:3080/remote-control/pair#p:c',
  )
  /* An unusable base yields no link rather than a broken one. */
  assert.equal(pairingUrl({ fragment: 'p:c' }, 'not a url'), null)
  assert.equal(pairingUrl(null, 'http://127.0.0.1:3080/'), null)
})

test('the pairing code is grouped for reading but not altered', () => {
  const { pairingCodeGroups } = loadClientBundle().bundle.internals

  assert.deepEqual(pairingCodeGroups('ABCD1234'), ['ABCD', '1234'])
  assert.deepEqual(pairingCodeGroups('ABCDE'), ['ABCD', 'E'])
  assert.deepEqual(pairingCodeGroups(''), [])
  assert.deepEqual(pairingCodeGroups(undefined), [])
  /* Grouping must be lossless: a truncated code is an unusable one. */
  assert.equal(pairingCodeGroups('ABCDEFGH').join(''), 'ABCDEFGH')
})

/* ---------------------------------------------------------------------- *
 * Small helpers
 * ---------------------------------------------------------------------- */

test('the port field accepts only usable ports', () => {
  const { parsePort } = loadClientBundle().bundle.internals

  assert.equal(parsePort('3090'), 3090)
  assert.equal(parsePort(' 80 '), 80)
  assert.equal(parsePort('65535'), 65535)
  for (const bad of ['', '0', '65536', '-1', 'abc', '30 90', '3090.5', '0x10', '1e3']) {
    assert.equal(parsePort(bad), null, `${JSON.stringify(bad)} must be rejected`)
  }
})

test('a device source falls back to the user agent when no address is projected', () => {
  const { deviceSource } = loadClientBundle().bundle.internals

  /* `src/host/api.js#publicDevice` currently projects no address, and the store
     has no column for one (`design.md` §5). Inventing an IP would be worse than
     showing the user agent, which is a real fact about the device. */
  assert.deepEqual(deviceSource({ ua: 'iPhone · Safari' }), { labelKey: 'devices.client', value: 'iPhone · Safari' })
  /* Forward-compatible: whichever field a future projection adds is preferred. */
  assert.deepEqual(deviceSource({ ip: '192.168.1.7', ua: 'iPhone' }), { labelKey: 'devices.ip', value: '192.168.1.7' })
  assert.deepEqual(deviceSource({ sourceIp: '10.0.0.2' }), { labelKey: 'devices.ip', value: '10.0.0.2' })
  assert.equal(deviceSource({}), null)
  assert.equal(deviceSource(null), null)
})

test('relative times degrade from "just now" to an absolute instant', () => {
  const { formatRelative, fallbackTranslate } = loadClientBundle().bundle.internals
  const now = Date.parse('2026-10-17T12:00:00.000Z')

  assert.equal(formatRelative(new Date(now - 5_000).toISOString(), now, fallbackTranslate), 'just now')
  assert.equal(formatRelative(new Date(now - 120_000).toISOString(), now, fallbackTranslate), '2 min ago')
  assert.equal(formatRelative(new Date(now - 7_200_000).toISOString(), now, fallbackTranslate), '2 h ago')
  /* Older than a day becomes a locale-formatted instant, not "N days ago". */
  const old = formatRelative(new Date(now - 5 * 86_400_000).toISOString(), now, fallbackTranslate)
  assert.equal(typeof old, 'string')
  assert.ok(!/ago/.test(old))
  /* Nothing usable in, nothing rendered out. */
  assert.equal(formatRelative(null, now, fallbackTranslate), null)
  assert.equal(formatRelative('not a date', now, fallbackTranslate), null)
  assert.equal(formatRelative('', now, fallbackTranslate), null)
})

test('the fallback translator interpolates and never renders a bare key', () => {
  const { fallbackTranslate } = loadClientBundle().bundle.internals

  assert.equal(fallbackTranslate('access.gatewayListening', { port: 3090, live: 2 }), 'Listening on port 3090 with 2 live remote connection(s).')
  /* An unknown key is surfaced verbatim: it is loud, and the dictionary parity
     tests are what keep it from ever shipping. */
  assert.equal(fallbackTranslate('no.such.key'), 'no.such.key')
  /* A missing parameter leaves the placeholder rather than printing "undefined". */
  assert.equal(fallbackTranslate('access.gatewayListening', { port: 3090 }), 'Listening on port 3090 with {live} live remote connection(s).')
})

test('the export attachment name is read off the response header', () => {
  const { attachmentName } = loadClientBundle().bundle.internals

  assert.equal(attachmentName('attachment; filename="dsh-remote-control-audit-2026-10-17.jsonl"'), 'dsh-remote-control-audit-2026-10-17.jsonl')
  assert.equal(attachmentName('attachment; filename=plain.jsonl'), 'plain.jsonl')
  assert.equal(attachmentName(null), null)
  assert.equal(attachmentName('inline'), null)
})

test('loopback detection covers the spellings a browser and a socket produce', () => {
  const { isLoopbackName } = loadClientBundle().bundle.internals

  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
    assert.equal(isLoopbackName(host), true, `${host} is loopback`)
  }
  for (const host of ['192.168.1.7', '10.0.0.2', 'example.com', '']) {
    assert.equal(isLoopbackName(host), false, `${host} is not loopback`)
  }
})

/* ---------------------------------------------------------------------- *
 * Static shape — the rules a browser would only discover at boot
 * ---------------------------------------------------------------------- */

test('the client half never hardcodes a colour or a theme value', () => {
  /* Forbidden pattern 4: colour must come from the theme, so a transparent or
     re-coloured theme still works. A hex/rgb/hsl literal in the stylesheet is
     the defect; the `--dsw-alias-*` tokens are the only colour source allowed. */
  const stylesheet = /const CSS = ([\s\S]*?)\]\.join\('\\n'\)/.exec(clientSource)
  assert.ok(stylesheet !== null, 'the injected stylesheet must be discoverable')
  const css = stylesheet[1]

  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'the stylesheet must not contain a hex colour')
  assert.ok(!/\brgba?\(/.test(css), 'the stylesheet must not contain an rgb() colour')
  assert.ok(!/\bhsla?\(/.test(css), 'the stylesheet must not contain an hsl() colour')
  /* And it must actually use the theme, or the check above passes vacuously. */
  assert.match(css, /var\(--dsw-alias-/)
})

test('every DOM class the client half emits uses the drc- prefix', () => {
  /* `component-guidelines.md`: one prefix, so nothing collides with another
     plugin's markup. Both halves are checked — the class NAMES the components
     emit, and the SELECTORS the injected stylesheet defines — because a stray
     stylesheet rule leaks styling onto the host page just as effectively as a
     stray class name. */
  const emitted = [...clientSource.matchAll(/className:\s*'([^']+)'/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter((name) => name !== '')

  assert.ok(emitted.length > 0, 'the component tree must carry class names')
  for (const name of emitted) {
    assert.ok(name.startsWith('drc-'), `emitted class ${name} must use the drc- prefix`)
  }

  /* Selectors inside the injected stylesheet. `[aria-*]`, `:hover` and `>` chains
     are attribute/state/parent selectors on our own classes, so only the base
     class token is checked. */
  const stylesheet = /const CSS = ([\s\S]*?)\]\.join\('\\n'\)/.exec(clientSource)
  assert.ok(stylesheet !== null, 'the injected stylesheet must be discoverable')
  const selectors = [...stylesheet[1].matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => match[1])
  assert.ok(selectors.length > 0, 'the stylesheet must define class selectors')
  for (const name of selectors) {
    assert.ok(name.startsWith('drc-'), `stylesheet selector .${name} must use the drc- prefix`)
  }
})

test('every subscription and timer in the client half is cleared by a cleanup', () => {
  /* Forbidden pattern 3: an EventSource / interval / listener in module scope
     keeps running after the panel closes. COUNTED, not merely "appears at least
     once": one cleanup for two timers still leaks one. A "released >= 1" form of
     this assertion was verified to survive the mutation `return () => {}` in
     place of a `clearInterval`, which is why it counts. */
  const paired = [
    { create: /setInterval\(/g, release: /clearInterval\(/g, name: 'setInterval' },
    { create: /setTimeout\(/g, release: /clearTimeout\(/g, name: 'setTimeout' },
    { create: /addEventListener\(/g, release: /removeEventListener\(/g, name: 'addEventListener' },
    { create: /new EventSource\(/g, release: /\.close\(\)/g, name: 'EventSource' },
  ]

  for (const { create, release, name } of paired) {
    const created = (clientSource.match(create) ?? []).length
    const released = (clientSource.match(release) ?? []).length
    if (created === 0) continue
    assert.ok(
      released >= created,
      `${name}: ${created} created but only ${released} released — at least one leaks`,
    )
  }

  /* Object URLs and abort controllers release through a different call than the
     one that acquires them, so presence in both directions is what is asserted. */
  if (/createObjectURL\(/.test(clientSource)) assert.match(clientSource, /revokeObjectURL\(/)
  if (/new AbortController\(\)/.test(clientSource)) assert.match(clientSource, /\.abort\(/)

  /* A module-scope EventSource is the specific defect the spec names. */
  assert.ok(!/^\s*const \w+ = new EventSource/m.test(clientSource), 'no module-scope EventSource')

  /* And no timer may be created outside a function body: every one must live
     inside a callback or an effect, where a cleanup can reach it. */
  assert.equal(
    /^ {4}(?:const|let)\s+\w+\s*=\s*set(?:Interval|Timeout)\(/m.test(clientSource),
    false,
    'no module-scope timer',
  )
})

test('the panel renders a revoked device as revoked, with no action offered', () => {
  /* `store.listDevices()` deliberately includes revoked rows and
     `api.js#listDevices` projects them unchanged. Showing one with a live
     "revoke" button reads as still-authorized — the same security lie as an
     optimistic revoke in the other direction. */
  const row = /function DeviceRow\(\{ t, device, onRevoke \}\) \{([\s\S]*?)\n    \}/.exec(clientSource)
  assert.ok(row !== null, 'DeviceRow must be discoverable')
  const body = row[1]

  /* The state must be DERIVED from the record. Asserting only that a `revoked`
     binding exists was verified to survive the mutation `const revoked = false`,
     which renders every device as active — so the data source is asserted. */
  assert.match(body, /device\.revokedAt/, 'the revoked state must read device.revokedAt')
  assert.match(body, /const revoked = /)

  /* And it must gate the destructive action. Asserting the bare word `revoked`
     was verified to survive BOTH of these mutations: `const revoked = false`,
     and rendering a revoke button inside the revoked branch. So what is checked
     here is (a) the state is derived from `device.revokedAt`, and (b) the action
     ternary's revoked arm contains no clickable control while the active arm
     owns the revoke text.

     The anchor is the ACTIONS ternary specifically. A looser `revoked ? h(`
     pattern silently matched the earlier `revoked ? h('span', …) : null` meta
     line, which is why the anchor names the actions container. */
  assert.match(body, /device\.revokedAt/, 'the revoked state must read device.revokedAt')

  const actionsAt = body.indexOf("? h('div', { className: 'drc-deviceActions' }")
  assert.ok(actionsAt > 0, 'the actions branch must be discoverable')
  const activeAt = body.indexOf(": h('div', { className: 'drc-deviceActions' }", actionsAt)
  assert.ok(activeAt > actionsAt, 'the actions must be a ternary with a revoked and an active arm')

  const revokedArm = body.slice(actionsAt, activeAt)
  const activeArm = body.slice(activeAt)

  /* `devices\.revoke\b` and not `devices\.revoke`: `devices.revoked` contains
     `devices.revoke` as a prefix, so the unanchored form matched the read-only
     "Revoked" label inside the revoked arm and failed on correct code. */
  assert.ok(!/devices\.revoke\b/.test(revokedArm), 'the revoked arm must not render a revoke control')
  assert.ok(!/onClick/.test(revokedArm), 'the revoked arm must offer no clickable action')
  assert.match(activeArm, /devices\.revoke\b/, 'the revoke control belongs to the active arm')

  assert.match(body, /t\('devices\.revoked'\)/, 'a revoked row must say so')
  assert.equal(typeof readJson('locale/zh.json')['devices.revoked'], 'string')
})

test('the panel never updates the device list without the server confirming', () => {
  /* Forbidden pattern 6: an optimistic revoke shows a still-working device as
     revoked, which is a security lie. The revoke path must await the API and
     then re-read; it must never splice the row out locally. */
  const revokePath = /const revokeDevice = useCallback\(async \(deviceId\) => \{([\s\S]*?)\}, \[load\]\)/.exec(clientSource)
  assert.ok(revokePath !== null, 'the revoke path must be discoverable')
  const body = revokePath[1]

  assert.match(body, /await requestJson\(/, 'revocation must wait for the server')
  assert.match(body, /await load\(\)/, 'revocation must re-read the list from the server')
  /* A local mutation would be the optimistic update this test forbids. */
  assert.ok(!/setSnapshot/.test(body), 'revocation must not mutate the list directly')
  assert.ok(!/filter\(/.test(body), 'revocation must not remove the row locally')
})

test('the panel sends no request shaped like a credential', () => {
  /* The device cookie is the gateway's business and the inner `dsh-auth-*`
     credential is the gateway's alone. The panel talks to a loopback admin API
     that takes no credential, so it must never touch either name: confusing them
     is the mistake `constants.js` documents at length. */
  assert.ok(!/dsh-rc-device/.test(clientSource), 'the panel must not handle the device cookie')
  assert.ok(!/dsh-auth-/.test(clientSource), 'the panel must never touch the inner credential')
  /* It also never forwards the token; revocation is by device id only. */
  assert.ok(!/Authorization/i.test(clientSource))
  assert.ok(!/tokenHash/.test(clientSource), 'the panel must not read the token verifier')
})

test('no automatic retry is wired into the request path', () => {
  /* `hook-guidelines.md`: a retrying fetch turns one genuinely broken API into a
     log storm and hides the failure. Recovery is the explicit, user-initiated
     `panel.retry` button — so the word "retry" itself is fine; what must not
     exist is a retry LOOP or a retry TIMER around the transport. */
  const requestJson = /async function requestJson\(([\s\S]*?)\n    \}/.exec(clientSource)
  assert.ok(requestJson !== null, 'requestJson must be discoverable')
  assert.ok(!/for\s*\(/.test(requestJson[1]), 'requestJson must not loop')
  assert.ok(!/while\s*\(/.test(requestJson[1]), 'requestJson must not loop')

  /* No timer may re-issue the transport: that is the automatic retry. The only
     timers are the poll (which calls `load`) and the countdown (which only
     recomputes remaining time), and both are effect-owned. */
  const timers = [...clientSource.matchAll(/setTimeout\(([\s\S]*?)\}, /g)].map((match) => match[1])
  for (const body of timers) {
    assert.ok(!/requestJson\(|fetch\(/.test(body), `a timer must not re-issue a request: ${body.trim()}`)
  }
})
