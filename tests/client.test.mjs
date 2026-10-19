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
 * What is NOT covered here, and must not be claimed as verified: anything that
 * needs a real DOM — layout, focus behaviour, `Esc` handling, clipboard writes,
 * the poll ticking in a page, the export download, and whether a phone camera can
 * actually read the QR symbol. The element TREE is inspected (the stub React
 * records it), which proves structure and data flow, not pixels.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  effectiveAddress as hostEffectiveAddress,
  formatAddress as hostFormatAddress,
  parseAddress as hostParseAddress,
} from '../src/host/addresses.js'
import {
  ADDRESS_TEXT_MAX as HOST_ADDRESS_TEXT_MAX,
  PANEL_MARKER_HEADER as HOST_PANEL_MARKER_HEADER,
  PANEL_MARKER_VALUE as HOST_PANEL_MARKER_VALUE,
  PUBLIC_ADDRESS_MAX as HOST_PUBLIC_ADDRESS_MAX,
  PUBLIC_LABEL_MAX as HOST_PUBLIC_LABEL_MAX,
} from '../src/host/constants.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readFileSync(path.join(repoRoot, 'src/client.js'), 'utf8')

/** Read and parse a repo-root JSON file. */
function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

/**
 * Minimal React stand-in.
 *
 * The factory only needs `createElement` at materialization time. The hooks are
 * trivial stand-ins so a component CAN be called as a plain function and its
 * element tree inspected (`PairingSection` below): with no DOM there is no other
 * way to check that the QR symbol really reaches the tree, and the stub records
 * the tree rather than rendering it.
 */
const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}

/**
 * Minimal `react-dom` stand-in.
 *
 * The panel is portalled to the document body (`prd.md` R1): as an absolutely
 * positioned child of the sidebar foot it was clipped by the sidebar's
 * `overflow`, and no z-index reaches that. `createPortal` is recorded rather than
 * performed — there is no DOM here — which is enough to prove the bundle asks for
 * the right module and calls the portal instead of rendering in place.
 */
function makeReactDomStub() {
  const portals = []
  return {
    createPortal: (node, target) => {
      portals.push({ node, target })
      return { type: 'portal', node, target }
    },
    portals,
  }
}

/**
 * Execute `src/client.js` against a fake `window.__ModuleLoader__` and return
 * the materialized bundle exports plus the raw registration.
 *
 * The file is evaluated with `new Function` rather than `import()` on purpose:
 * it is not an ES module, and importing it would be testing a different thing
 * than what a browser does with it.
 *
 * @param {{ React?: object, ReactDOM?: object, onWarn?: (message: string) => void }} [options]
 * @returns {{
 *   registration: { id: string, factory: Function },
 *   bundle: any,
 *   required: string[],
 *   reactDom: ReturnType<typeof makeReactDomStub>,
 * }}
 */
function loadClientBundle(options = {}) {
  const react = options.React ?? REACT_STUB
  const reactDom = options.ReactDOM ?? makeReactDomStub()
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
    if (specifier === 'react-dom') return reactDom
    /* Any other request is a contract violation this test must surface, not
       something to stub out: the baseline table is what the browser can answer. */
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })

  return { registration, bundle, required, reactDom }
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

/**
 * A context that behaves like the REAL Cordis client context.
 *
 * This matters more than it looks. Cordis hands each plugin a Proxy and refuses
 * every service the plugin did not declare: both `ctx.get('locale')` and
 * `ctx.locale` throw `cannot get property "locale" without inject` until
 * `inject` covers them. The plain `makeContext` below exposes services as
 * ordinary properties, so it cannot reproduce that — which is exactly how the
 * 2026-10-19 regression shipped (the plugin read an undeclared `locale`, threw
 * during activation, and the web boot refused to draw the whole GUI).
 *
 * @param {Record<string, any>} services services the composition provides
 * @param {{ missing?: string[] }} [options] declared-but-absent services; a
 *   service listed here never resolves, so `ctx.inject` waits forever like the
 *   real context does
 */
function makeCordisContext(services = {}, options = {}) {
  const missing = new Set(options.missing ?? [])
  const effects = []
  const injected = []

  const build = (granted) => {
    const read = (name) => {
      if (!granted.has(name)) throw new Error(`cannot get property "${name}" without inject`)
      if (missing.has(name)) return undefined
      return services[name]
    }
    const api = {
      effect(acquire, label) {
        const release = acquire()
        effects.push({ label, release: typeof release === 'function' ? release : () => {} })
        return release
      },
      get(name) {
        return read(name)
      },
      inject(names, visit) {
        injected.push(names)
        /* A declared service that never appears leaves the callback waiting, so
           nothing inside it runs — the real "the plugin still activates" case. */
        if (names.some((name) => missing.has(name))) return
        visit(build(new Set([...granted, ...names])))
      },
    }
    /* Property reads are the second door into the same guard. */
    return new Proxy(api, {
      get(target, property, receiver) {
        if (typeof property !== 'string' || property in target) return Reflect.get(target, property, receiver)
        return read(property)
      },
    })
  }

  return { ctx: build(new Set()), effects, injected }
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
     anything else fails at boot in the browser, where no test can see it.
     `react-dom` is there for ONE reason: `createPortal`, which is what gets the
     panel out of the sidebar's `overflow` (both are in the whitelist
     `tests/package.test.mjs` asserts). */
  assert.deepEqual(required, ['react', 'react-dom'])
  assert.equal(bundle.internals.hasPortal(), true, 'the portal must be available')
})

test('the bundle declares no global service, so no missing service can park the row', () => {
  const { bundle } = loadClientBundle()

  /* An `inject: ['slots']` row that never receives `slots` stays PENDING, and the
     web boot refuses to draw the GUI over any entry that did not activate
     ("Failed to load plugins"). 2026-10-19 shipped exactly that failure in the
     other direction too: an undeclared `locale` read threw during activation.
     Both facilities are therefore requested per-use inside `apply`, never on the
     plugin object. */
  assert.deepEqual(bundle.inject, [])
})

test('a Cordis context that throws on undeclared services still gets the panel', () => {
  const { bundle } = loadClientBundle()
  const slots = makeSlots()
  const locale = makeLocale()
  const { ctx, effects, injected } = makeCordisContext({ slots, locale })

  /* The fixture really is Cordis-shaped: an undeclared read throws. If this
     assertion ever stops failing, the test below stops proving anything. */
  assert.throws(() => ctx.get('locale'), /without inject/)
  assert.throws(() => ctx.locale, /without inject/)

  assert.doesNotThrow(() => bundle.apply(ctx))

  assert.deepEqual(slots.injected, ['sidebar.footer.action'])
  assert.equal(slots.registered.length, 1)
  assert.equal(locale.registrations.length, 1, 'the dictionaries must still register')
  assert.deepEqual(injected, [['locale'], ['slots']], 'each optional service is requested, then used')
  assert.ok(effects.some((entry) => entry.label === 'remote-control: styles'))
})

test('a service that never appears leaves the row activated and the GUI intact', () => {
  const { bundle } = loadClientBundle()
  const { ctx, effects, injected } = makeCordisContext({}, { missing: ['slots', 'locale'] })

  /* Nothing mounts, nothing throws: the seat's absence is a missing feature, not
     a failed boot. This is the difference between "no device panel" and "no GUI". */
  assert.doesNotThrow(() => bundle.apply(ctx))
  assert.deepEqual(injected, [['locale'], ['slots']])
  assert.equal(effects.length, 1, 'only the stylesheet, which needs no service')
})

test('a service that throws mid-mount is reported, never rethrown', () => {
  const { bundle } = loadClientBundle()
  const slots = {
    inject() {
      throw new Error('slot service exploded')
    },
    register() {
      return () => {}
    },
  }
  const { ctx } = makeContext({ slots })

  const errors = []
  const previousConsole = globalThis.console
  globalThis.console = { ...previousConsole, error: (...args) => errors.push(args.map(String).join(' ')) }
  try {
    /* The web boot aborts the WHOLE application when a client entry does not
       activate, with no per-plugin opt-out. So the plugin must swallow: one
       broken panel may cost its own seat, never the user's session. */
    assert.doesNotThrow(() => bundle.apply(ctx))
  } finally {
    globalThis.console = previousConsole
  }

  assert.equal(errors.length, 1)
  assert.match(errors[0], /\[remote-control\]/)
  assert.match(errors[0], /slot service exploded/)
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
    '192.168.1.7',
    'http://127.0.0.1:3080/',
  )
  assert.equal(url, 'http://192.168.1.7:3090/remote-control/pair#pair_abc:ABCD1234')

  const parsed = new URL(url)
  /* The whole reason for the fragment (`design.md` §3.1 step 3): a fragment is
     never sent to a server, so the one-time code cannot land in an access log. */
  assert.equal(parsed.search, '', 'the code must not be in the query string')
  assert.equal(parsed.hash, '#pair_abc:ABCD1234')
  assert.equal(parsed.pathname, '/remote-control/pair')
})

test('the pairing link is built from the selected address, not from the page', () => {
  const { pairingUrl } = loadClientBundle().bundle.internals
  const pair = { fragment: 'p:c', port: 3090 }

  /* The defect this stage exists for: the desktop page is on 127.0.0.1, so a link
     built from the page's own origin can never be opened from a phone. */
  assert.equal(
    pairingUrl(pair, '192.168.1.5', 'http://127.0.0.1:3080/'),
    'http://192.168.1.5:3090/remote-control/pair#p:c',
  )
  /* An address carrying its own port WINS over the gateway port: `:8443` is a
     statement about where the gateway is reachable (`prd.md` acceptance 5). */
  assert.equal(
    pairingUrl(pair, 'home.example.com:8443', 'http://127.0.0.1:3080/'),
    'http://home.example.com:8443/remote-control/pair#p:c',
  )
  /* An explicit scheme is preserved — `https://` is the user's proxy terminating
     TLS in front of the plain-HTTP gateway (`design.md` §6). */
  assert.equal(
    pairingUrl(pair, 'https://dsh.example.net', 'http://127.0.0.1:3080/'),
    'https://dsh.example.net:3090/remote-control/pair#p:c',
  )
  /* No scheme means the gateway's own: it speaks plain HTTP. */
  assert.equal(
    pairingUrl(pair, 'dsh.example.net', 'http://127.0.0.1:3080/'),
    'http://dsh.example.net:3090/remote-control/pair#p:c',
  )
  /* A bracketed IPv6 literal keeps its brackets, which are what make the URL parse. */
  assert.equal(
    pairingUrl(pair, '[::1]:4000', 'http://127.0.0.1:3080/'),
    'http://[::1]:4000/remote-control/pair#p:c',
  )
})

test('a public address is used exactly as written, a LAN address gets the gateway port', () => {
  /* Reported from a live panel (2026-10-19): the user typed `https://dsh-jiang.jneo.de`
     and got `https://dsh-jiang.jneo.de:3090/...`, a URL their reverse proxy does not
     serve. The two kinds of address answer different questions, so the MODE decides:
       - LAN: "this host, on the gateway port" — the port is filled in;
       - public: "whatever my proxy serves" — 443/80 is implied, the port is not ours
         to guess. An explicit port still wins in both modes. */
  const { pairingUrl } = loadClientBundle().bundle.internals
  const pair = { fragment: 'p:c', port: 3090 }

  assert.equal(
    pairingUrl(pair, 'https://dsh-jiang.jneo.de', 'http://127.0.0.1:3080/', 'public'),
    'https://dsh-jiang.jneo.de/remote-control/pair#p:c',
  )
  assert.equal(
    pairingUrl(pair, 'home.example.com', 'http://127.0.0.1:3080/', 'public'),
    'http://home.example.com/remote-control/pair#p:c',
  )
  /* An explicit port is respected even on a public address, with or without a scheme. */
  assert.equal(
    pairingUrl(pair, 'https://dsh.example.net:8443', 'http://127.0.0.1:3080/', 'public'),
    'https://dsh.example.net:8443/remote-control/pair#p:c',
  )
  assert.equal(
    pairingUrl(pair, 'dsh.example.net:8443', 'http://127.0.0.1:3080/', 'public'),
    'http://dsh.example.net:8443/remote-control/pair#p:c',
  )
  /* LAN keeps the gateway port — that is the whole point of the dropdown. */
  assert.equal(
    pairingUrl(pair, '192.168.1.5', 'http://127.0.0.1:3080/', 'lan'),
    'http://192.168.1.5:3090/remote-control/pair#p:c',
  )
  /* Omitting the mode keeps the pre-existing behaviour (LAN rules). */
  assert.equal(
    pairingUrl(pair, '192.168.1.5', 'http://127.0.0.1:3080/'),
    'http://192.168.1.5:3090/remote-control/pair#p:c',
  )
})

test('the pairing link falls back to the page host and its own port only', () => {
  const { pairingUrl } = loadClientBundle().bundle.internals

  /* No effective address at all (no NIC entry, no public row): the pre-address
     behaviour, which the panel pairs with `pair.loopbackHint` rather than
     presenting as a working link. */
  for (const missing of [null, undefined, '', 'not an address', 'http://x/a']) {
    assert.equal(
      pairingUrl({ fragment: 'p:c', port: 3090 }, missing, 'http://127.0.0.1:3080/'),
      'http://127.0.0.1:3090/remote-control/pair#p:c',
      `fallback for ${JSON.stringify(missing)}`,
    )
  }
  /* With no gateway port either, the page's own port is the honest answer (the
     panel separately warns that nothing is listening). */
  assert.equal(
    pairingUrl({ fragment: 'p:c', port: null }, null, 'http://127.0.0.1:3080/'),
    'http://127.0.0.1:3080/remote-control/pair#p:c',
  )
  /* An unusable base yields no link rather than a broken one. */
  assert.equal(pairingUrl({ fragment: 'p:c' }, null, 'not a url'), null)
  assert.equal(pairingUrl(null, '192.168.1.5', 'http://127.0.0.1:3080/'), null)
})

test('a pairing link still uses the gateway port when the page has none', () => {
  const { pairingUrl } = loadClientBundle().bundle.internals

  /* The old "gateway port, not the page port" rule must survive the address
     change: a phone cannot reach the official port. */
  assert.equal(
    pairingUrl({ fragment: 'p:c', port: 3090 }, null, 'http://127.0.0.1:3080/'),
    'http://127.0.0.1:3090/remote-control/pair#p:c',
  )
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
 * Access addresses
 * ---------------------------------------------------------------------- */

/**
 * Accept/reject matrix shared by the client and the host, so the two copies of
 * the parser are compared on the same inputs rather than on two hand-written
 * lists that would drift apart exactly where it matters.
 */
const ADDRESS_ACCEPTED = [
  '192.168.1.5',
  '10.0.0.7',
  '1.2.3.4',
  'home.example.com',
  'home.example.com:3090',
  'dsh.lan:65535',
  'http://dsh.lan',
  'https://dsh.example.net',
  'https://dsh.example.net:8443',
  'HTTP://UPPER.example',
  '[::1]',
  '[::1]:3090',
  '[2001:db8::1]:8443',
]

const ADDRESS_REJECTED = [
  '',
  '   ',
  '192.168.1.5 3090',
  '192.168.1.5:0',
  '192.168.1.5:65536',
  '192.168.1.5:',
  '192.168.1.5:abc',
  '192.168.1.5:12 34',
  'http://dsh.lan/path',
  'http://dsh.lan/?q=1',
  'http://dsh.lan/#frag',
  'user@dsh.lan',
  'http://user:pass@dsh.lan',
  'ftp://dsh.lan',
  'file:///etc/passwd',
  '//dsh.lan',
  'dsh.lan/',
  '::1',
  '[::1',
  '[zz]:3090',
  'dsh..lan',
  '-dsh.lan',
  '.dsh.lan',
  'a'.repeat(254),
]

test('the client address parser applies the same rules as the host copy', () => {
  /* The browser half cannot import `src/host/addresses.js` (single factory, no
     top-level import), so the parser is genuinely duplicated. Two copies of a
     rule set are two places to change, and a divergence ships a panel that
     accepts what the server then refuses with a 400 — so both are run over the
     same matrix here. */
  const { parseAddress, formatAddress } = loadClientBundle().bundle.internals

  for (const text of ADDRESS_ACCEPTED) {
    assert.deepEqual(parseAddress(text), hostParseAddress(text), `both must accept ${JSON.stringify(text)}`)
    assert.notEqual(parseAddress(text), null, `${JSON.stringify(text)} must parse`)
    /* Round-tripping is what `POST /settings` relies on: the panel sends the
       formatted form, the store re-parses it. */
    assert.equal(formatAddress(parseAddress(text)), hostFormatAddress(hostParseAddress(text)), text)
  }
  for (const text of ADDRESS_REJECTED) {
    assert.equal(parseAddress(text), null, `client must reject ${JSON.stringify(text)}`)
    assert.equal(hostParseAddress(text), null, `host must reject ${JSON.stringify(text)}`)
  }
})

test('the two parsers agree at the documented length boundary', () => {
  /* The matrix above pins WHICH strings are legal; this pins the BOUND the
     legality depends on. `ADDRESS_TEXT_MAX` is a duplicated constant, so a copy
     that drifted by one would accept a 254-character name in the panel and be
     refused by the server — a 400 for input the client just validated. */
  const { parseAddress } = loadClientBundle().bundle.internals
  /* Each label stays inside the 63-character label limit, so this exercises the
     total-length bound rather than the per-label one. */
  const longest = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')
  assert.equal(longest.length, HOST_ADDRESS_TEXT_MAX)

  assert.notEqual(parseAddress(longest), null, 'the limit is inclusive')
  assert.deepEqual(parseAddress(longest), hostParseAddress(longest))
  for (const text of [longest + 'e', longest + '.e']) {
    assert.equal(parseAddress(text), null, `one character too long: ${String(text.length)}`)
    assert.equal(hostParseAddress(text), null)
  }
})

test('the client copies the host limits exactly, not approximately', () => {
  /* Three numbers are duplicated across the halves and none of them is verifiable
     by behaviour alone: if the panel allowed 10 rows where the store keeps 8, the
     ninth address would vanish on the next poll with no error shown — the
     "looks like it worked, then it did not" state `quality-guidelines.md`
     forbidden pattern 7 rules out. Compared against the host constants rather
     than against literals, so raising the cap stays a one-line change. */
  const number = (name) => {
    const found = new RegExp(`const ${name} = (\\d[\\d_]*)`).exec(clientSource)
    assert.ok(found !== null, `src/client.js must define ${name}`)
    return Number(found[1].replace(/_/g, ''))
  }

  assert.equal(number('PUBLIC_ADDRESS_MAX'), HOST_PUBLIC_ADDRESS_MAX)
  assert.equal(number('PUBLIC_LABEL_MAX'), HOST_PUBLIC_LABEL_MAX)
  assert.equal(number('ADDRESS_TEXT_MAX'), HOST_ADDRESS_TEXT_MAX)
})

test('the panel marker header is one literal, and every admin call carries it', () => {
  /* The marker is the only origin proof a DESKTOP-issued write can carry: the dsh
     desktop app forwards the panel's requests from its main process with `Origin`
     and `Sec-Fetch-Site` deleted (`src/host/origin.js#checkAdminOrigin`), so a save
     that omits the header answers `403 admin/cross-origin` there while the very
     same click works in a browser. That asymmetry is why a silent mismatch between
     the two halves is worth an assertion: in a browser the header is never
     consulted, so a divergence would look like a healthy build.

     Compared against the host constants rather than against literals, so renaming
     the header stays a two-line change. */
  const { internals } = loadClientBundle().bundle
  assert.equal(internals.PANEL_MARKER_HEADER, HOST_PANEL_MARKER_HEADER)
  assert.equal(internals.PANEL_MARKER_VALUE, HOST_PANEL_MARKER_VALUE)

  /* Both request paths — the JSON transport and the audit export — must stamp it.
     Checked against the source because there is no DOM here to run a fetch. */
  const stamped = clientSource.split('[PANEL_MARKER_HEADER]: PANEL_MARKER_VALUE').length - 1
  assert.equal(stamped, 2, 'requestJson and the audit export both send the marker')
})

test('both copies of effectiveAddress resolve the same matrix', () => {
  /* `design.md` §1.2 is one rule with two implementations: the host copy is the
     reference, the client copy is what actually builds the link. A divergence
     would mean the panel links to an address the documented rule would not have
     chosen — including the fallback, which is the half no unit test of a single
     copy can catch. Hostile entries are in the matrix on purpose: `GET /state` is
     JSON the panel did not necessarily produce. */
  const { effectiveAddress } = loadClientBundle().bundle.internals

  const lanSets = [
    [],
    undefined,
    [{ address: '192.168.1.5', iface: 'WLAN' }, { address: '10.0.0.7', iface: 'Ethernet' }],
    /* Malformed rows must be skipped by BOTH, not used as the fallback. */
    [{ address: 123 }, { address: '10.0.0.7' }],
    [{ address: '' }, { address: '10.0.0.7' }],
    [null, 'x', { address: '10.0.0.7' }],
  ]
  const accesses = [
    null,
    {},
    { mode: 'lan', lanAddress: '' },
    { mode: 'lan', lanAddress: '10.0.0.7' },
    { mode: 'lan', lanAddress: '172.16.0.9' },
    { mode: 'nonsense', lanAddress: '10.0.0.7' },
    { mode: 'public', public: [] },
    { mode: 'public', public: [{ id: 'a', address: 'home.example.com:3090' }] },
    { mode: 'public', public: [{ id: 'a', address: 'home.example.com' }, { id: 'b', address: ' x ' }], selectedPublicId: 'b' },
    { mode: 'public', public: [{ id: 'a', address: 'home.example.com' }], selectedPublicId: 'gone' },
  ]

  for (const access of accesses) {
    for (const lan of lanSets) {
      assert.equal(
        effectiveAddress(access, lan),
        hostEffectiveAddress(access, lan),
        `both must resolve ${JSON.stringify({ access, lan })}`,
      )
    }
  }
})

test('the parser normalizes an address without inventing a scheme', () => {
  const { parseAddress, formatAddress } = loadClientBundle().bundle.internals

  assert.deepEqual(parseAddress('home.example.com:3090'), { scheme: null, host: 'home.example.com', port: 3090 })
  assert.equal(formatAddress({ scheme: null, host: 'home.example.com', port: 3090 }), 'home.example.com:3090')
  /* `http`/`https` only; anything else never reaches storage. */
  assert.equal(formatAddress(parseAddress('HTTPS://dsh.example.net')), 'https://dsh.example.net')
  /* Trimmed on the way in, so a pasted value with spaces still saves. */
  assert.equal(formatAddress(parseAddress('  192.168.1.5  ')), '192.168.1.5')
  assert.equal(formatAddress(null), '')
  assert.equal(formatAddress({}), '')
})

test('the effective address follows the stored choice and falls back without writing', () => {
  const { effectiveAddress } = loadClientBundle().bundle.internals
  const lan = [
    { address: '192.168.1.5', iface: 'WLAN', private: true },
    { address: '10.0.0.7', iface: 'Ethernet', private: true },
  ]

  /* LAN, stored choice still present: the choice wins over the first entry. */
  assert.equal(effectiveAddress({ mode: 'lan', lanAddress: '10.0.0.7' }, lan), '10.0.0.7')
  /* LAN, stored choice gone (cable pulled, interface renamed): first entry. */
  assert.equal(effectiveAddress({ mode: 'lan', lanAddress: '172.16.0.9' }, lan), '192.168.1.5')
  /* LAN with nothing stored / an empty list: the auto default, then nothing. */
  assert.equal(effectiveAddress({ mode: 'lan', lanAddress: '' }, lan), '192.168.1.5')
  assert.equal(effectiveAddress({ mode: 'lan' }, []), null)
  assert.equal(effectiveAddress({ mode: 'lan' }, undefined), null)

  const book = [
    { id: 'pub_a', label: 'home', address: 'home.example.com:3090' },
    { id: 'pub_b', label: 'tunnel', address: 'https://dsh.example.net' },
  ]
  assert.equal(effectiveAddress({ mode: 'public', public: book, selectedPublicId: 'pub_b' }, lan), 'https://dsh.example.net')
  /* A dangling selection resolves to the first row, never to the LAN list. */
  assert.equal(effectiveAddress({ mode: 'public', public: book, selectedPublicId: 'pub_gone' }, lan), 'home.example.com:3090')
  assert.equal(effectiveAddress({ mode: 'public', public: book, selectedPublicId: null }, lan), 'home.example.com:3090')
  assert.equal(effectiveAddress({ mode: 'public', public: [] }, lan), null)
  /* Public mode with an empty book falls back to NO address, not to the LAN list:
     the mode is an instruction about which list to read. */
  assert.equal(effectiveAddress({ mode: 'public', public: [], selectedPublicId: null }, lan), null)
})

test('the access settings are rebuilt from whatever the host sent', () => {
  const { accessOf, defaultAccess } = loadClientBundle().bundle.internals

  const fallback = defaultAccess()
  assert.deepEqual(fallback, { mode: 'lan', lanAddress: '', public: [], selectedPublicId: null })
  /* A fresh object every call: the panel hands this straight back to the API, and
     a shared literal would be one mount's mutation seen by the next. */
  assert.notEqual(defaultAccess(), fallback)

  assert.deepEqual(accessOf(null), fallback)
  assert.deepEqual(accessOf({}), fallback)
  assert.deepEqual(accessOf({ access: null }), fallback)
  /* Default off LAN, never public: public is the mode whose reachability the
     plugin cannot check, so it must never be the accidental default. */
  assert.equal(accessOf({ access: { mode: 'PUBLIC' } }).mode, 'lan')
  assert.deepEqual(accessOf({
    access: {
      mode: 'public',
      lanAddress: '192.168.1.5',
      public: [
        { id: 'pub_a', label: 'home', address: 'home.example.com' },
        { id: '', label: 'broken', address: 'x' },
        { id: 'pub_b', address: 'dsh.example.net:8443' },
        'not an object',
      ],
      selectedPublicId: 'pub_a',
    },
  }), {
    mode: 'public',
    lanAddress: '192.168.1.5',
    public: [
      { id: 'pub_a', label: 'home', address: 'home.example.com' },
      { id: 'pub_b', label: '', address: 'dsh.example.net:8443' },
    ],
    selectedPublicId: 'pub_a',
  })
})

test('a new public address id is unique inside the book', () => {
  const { newPublicId } = loadClientBundle().bundle.internals

  const existing = [{ id: 'pub_1' }, { id: 'pub_2' }]
  const id = newPublicId(existing)
  assert.match(id, /^pub_[a-z0-9]{1,20}$/)
  assert.ok(!existing.some((row) => row.id === id))
  /* Bounded loop: a stubbed constant source must not hang the panel. */
  const { newPublicId: again } = loadClientBundle().bundle.internals
  assert.equal(typeof again([]), 'string')
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

/* ---------------------------------------------------------------------- *
 * The modal — structural, because a DOM test environment does not exist here
 * ---------------------------------------------------------------------- */

test('the panel is portalled to the document body, not laid out in the sidebar', () => {
  /* `prd.md` R1. The anchored panel was CLIPPED by the sidebar's `overflow` on the
     right and bottom (2026-10-19 screenshots), and no z-index can reach a
     clipping ancestor — so the assertion is about the portal, not about a
     stacking value. `component-guidelines.md` allows `react-dom` for this. */
  assert.match(clientSource, /require\('react-dom'\)/, 'the portal comes from react-dom')
  /* The target is the body of the live document, read at call time (not a cached
     `document.body`, which a hot reload could outlive). */
  assert.match(clientSource, /const body = document\.body/, 'the portal target is document.body')
  assert.match(clientSource, /createPortal\(node, body\)/, 'the portal is performed against the body')
  assert.match(clientSource, /portal\(open \?/, 'the panel is rendered through the portal helper')
  /* Three degradations, and the throw-free order matters: no `react-dom` or a
     `document` without a body renders in place; no DOM at all renders NOTHING
     (there is nowhere to put it). `apply` may never throw
     (`quality-guidelines.md`), which is why the DOM is probed rather than
     dereferenced. */
  assert.match(clientSource, /typeof document === 'undefined'/, 'the DOM access is guarded')
  assert.match(
    clientSource,
    /if \(typeof document === 'undefined' \|\| document === null\) return null/,
    'without a DOM the panel renders nothing instead of throwing',
  )
  assert.match(
    clientSource,
    /if \(body === null \|\| body === undefined \|\| createPortal === null\) return node/,
    'a body-less or portal-less host still renders the panel, in place',
  )
})

test('the panel closes on the close button and Esc, and never on an outside click', () => {
  /* `prd.md` D1: a modal that disappears when the mouse wanders is how a user
     loses a pairing code they were reading. The old `pointerdown` listener is
     gone, and the scrim carries NO click handler at all — an absent listener
     cannot be defeated by event ordering, which a "return early" handler could. */
  assert.ok(!/addEventListener\(\s*'pointerdown'/.test(clientSource), 'the outside-pointerdown dismissal must be removed')
  assert.ok(!/addEventListener\(\s*'click'/.test(clientSource), 'no document-level click dismissal may be reintroduced')
  assert.match(clientSource, /event\.key === 'Escape'/, 'Esc still closes the panel')
  assert.match(clientSource, /onClick: onClose/, 'the close button still closes the panel')
  /* The scrim is a bare wrapper: its props object holds `className` and nothing
     else, so there is no click handler to dismiss the panel with. */
  assert.match(clientSource, /h\('div', \{ className: 'drc-overlay' \},/)
  assert.ok(
    !/className: 'drc-overlay'[^}]*on[A-Z]/.test(clientSource),
    'the scrim must bind no event handler',
  )
  /* The two dismissals are the ONLY `setOpen(false)` call sites: the keydown
     listener and the close button passed down to the panel. A third one would be
     a dismissal path nobody documented. */
  const dismissals = (clientSource.match(/setOpen\(false\)/g) ?? []).length
  assert.equal(dismissals, 2, 'exactly two dismissal paths: Esc and the close button')
})

test('the dialog exposes the ARIA contract, traps Tab and moves focus in and back out', () => {
  /* `design.md` §3.1: `role="dialog"` + `aria-modal` + a label pointing at the
     VISIBLE title (not a duplicated `aria-label` that could drift), initial focus
     inside, and focus returned to the trigger on close.
     `aria-modal="true"` promises assistive technology that everything outside the
     dialog is inert, so the Tab cycle has to stay inside it — the earlier version
     left that promise unhonoured (`ui-ux-pro-max`: focus must stay reachable and
     visible within a modal). */
  assert.match(clientSource, /role: 'dialog'/)
  assert.match(clientSource, /'aria-modal': 'true'/)
  assert.match(clientSource, /'aria-labelledby': TITLE_ID/)
  assert.match(clientSource, /id: TITLE_ID/)
  /* The label target really exists on the heading the user reads. */
  assert.match(clientSource, /const TITLE_ID = 'drc-panel-title'/)
  assert.match(clientSource, /h\('h2', \{ className: 'drc-panelTitle', id: TITLE_ID \}/)

  /* Focus in on open, and back to the trigger on close — the cleanup is what
     runs on close, which is why the return of focus lives there. */
  assert.match(clientSource, /const node = panelRef\.current[\s\S]*?node\.focus\(\)/)
  assert.match(clientSource, /const trigger = triggerRef\.current[\s\S]*?trigger\.focus\(\)/)
  assert.match(clientSource, /ref: triggerRef/)
  /* The trap intercepts only the two edges of the cycle, so ordinary Tab order in
     between stays the browser's. */
  assert.match(clientSource, /if \(event\.key !== 'Tab'\) return/)
  assert.match(clientSource, /const first = focusable\[0\]/)
  assert.match(clientSource, /event\.shiftKey === true/)
})

test('the modal card scrolls internally instead of overflowing the viewport', () => {
  /* `prd.md` acceptance 1: fully visible at 1024x700 AND at 601x1731. A card with
     a `max-height` and a scrolling body satisfies both; the old
     `bottom:calc(100% + 8px)` anchor satisfied neither. */
  const stylesheet = /const CSS = ([\s\S]*?)\]\.join\('\\n'\)/.exec(clientSource)
  assert.ok(stylesheet !== null, 'the injected stylesheet must be discoverable')
  const css = stylesheet[1]

  assert.match(css, /\.drc-overlay\{[^}]*position:fixed/)
  assert.match(css, /\.drc-overlay\{[^}]*inset:0/)
  assert.match(css, /\.drc-overlay\{[^}]*align-items:center/)
  assert.match(css, /\.drc-overlay\{[^}]*justify-content:center/)
  assert.match(css, /\.drc-panel\{[^}]*width:min\(640px,100%\)/)
  assert.match(css, /\.drc-panel\{[^}]*max-height:min\(760px,calc\(100vh - 32px\)\)/)
  assert.match(css, /\.drc-body\{[^}]*overflow-y:auto/)
  /* And the anchoring that caused the clipping is gone for good. */
  assert.ok(!/\.drc-panel\{[^}]*position:absolute/.test(css), 'the panel must not be absolutely positioned')
  assert.ok(!/bottom:calc\(100% \+ 8px\)/.test(css), 'the popover anchor must be removed')
})

test('the pairing tab owns the access point, the access tab owns the address book', () => {
  /* `prd.md` R2/R3, reshaped after review: choosing an access point belongs to
     pairing (it is what the symbol encodes), maintaining the public address book is
     administration. Asserted at source level — the browser half has no DOM test
     environment; the strings themselves are pinned by the dictionary parity tests. */
  const point = /function AccessPointSection\(\{ t, settings, addresses, updateSettings, onManagePublic \}\) \{([\s\S]*?)\n    \}/.exec(clientSource)
  assert.ok(point !== null, 'AccessPointSection must be discoverable')
  const pointBody = point[1]

  assert.match(pointBody, /segment\('lan', 'address\.modeLan'\)/)
  assert.match(pointBody, /segment\('public', 'address\.modePublic'\)/)
  /* LAN: a select over the SERVER's list (the browser cannot enumerate NICs). */
  assert.match(pointBody, /addresses\.lan/)
  assert.match(pointBody, /h\('select'/)
  assert.match(pointBody, /t\('address\.lanEmpty'\)/)
  /* Public: a PICKER, not the book — no add form, no delete here. */
  assert.match(pointBody, /t\('address\.publicEmpty'\)/)
  assert.ok(!/t\('address\.add'\)/.test(pointBody), 'the pairing tab must not manage the book')
  assert.ok(!/t\('address\.publicHint'\)/.test(pointBody), 'the reachability caveat belongs with the book')
  /* An empty public book is a dead end on this tab, so the empty state carries the
     one action that unblocks it: jump to the tab that can add an address. */
  assert.match(pointBody, /t\('address\.goManage'\)/)
  assert.match(pointBody, /onManagePublic\(\)/)
  /* Every write goes through the ONE documented field, and never optimistically:
     the value comes back from the server's answer. */
  assert.match(pointBody, /updateSettings\(\{ access: next \}\)/)

  const book = /function PublicBookSection\(\{ t, settings, updateSettings \}\) \{([\s\S]*?)\n    \}/.exec(clientSource)
  assert.ok(book !== null, 'PublicBookSection must be discoverable')
  const bookBody = book[1]

  /* The book adds with an optional label, deletes, and marks the row in use. */
  assert.match(bookBody, /t\('address\.add'\)/)
  assert.match(bookBody, /t\('address\.delete'\)/)
  assert.match(bookBody, /t\('address\.inUse'\)/)
  assert.match(bookBody, /t\('address\.publicHint'\)/)
  /* Selecting an address is NOT the book's job any more. */
  assert.ok(!/type: 'radio'/.test(bookBody), 'the radio choice moved to the pairing tab')
  assert.ok(!/drc-segments/.test(bookBody), 'the LAN/public switch moved to the pairing tab')
})

test('the pairing link hints match how the link was built', () => {
  /* `design.md` §3.3. `pair.loopbackHint` is for the LEGACY fallback (the page's
     own host, which on the desktop is 127.0.0.1); `pair.publicHint` is for a
     public address, where reachability is the user's port mapping. Showing
     neither would present a link with no caveat; showing both would contradict
     itself. */
  const section = /function PairingSection\(\{ t, pairing, gateway, addressText, mode \}\) \{([\s\S]*?)\n    \}/.exec(clientSource)
  assert.ok(section !== null, 'PairingSection must be discoverable')
  const body = section[1]

  assert.match(body, /pairingUrl\(current, addressText, documentBase\(\), mode\)/, 'the link takes the effective address and its mode')
  assert.match(body, /t\('pair\.loopbackHint'\)/)
  assert.match(body, /t\('pair\.publicHint'\)/)
  /* One hint, chosen by branch — not two independent conditions. */
  assert.match(body, /if \(usedFallback\) \{/)
  assert.match(body, /else if \(mode === 'public'\)/)
})

test('the address and pairing-link strings exist in both languages', () => {
  const { ZH, EN } = loadClientBundle().bundle.internals
  const required = [
    'address.heading',
    'address.modeLan',
    'address.modePublic',
    'address.lanEmpty',
    'address.publicEmpty',
    'address.label',
    'address.address',
    'address.add',
    'address.delete',
    'address.invalid',
    'address.tooMany',
    'address.publicHint',
    'address.staleHint',
    'pair.publicHint',
  ]
  for (const key of required) {
    assert.equal(typeof ZH[key], 'string', `zh.${key} is missing`)
    assert.equal(typeof EN[key], 'string', `en.${key} is missing`)
  }
  /* The two hints that carry a VERDICT about reachability must say the opposite of
     "verified": the plugin does not probe anything (`prd.md` D3). */
  assert.match(ZH['address.publicHint'], /不检测可达性/)
  assert.match(EN['address.publicHint'], /never checks reachability/i)
  assert.match(ZH['pair.publicHint'], /不检测可达性/)
  assert.match(EN['pair.publicHint'], /does not check reachability/i)
})

/* ---------------------------------------------------------------------- *
 * The pairing QR symbol
 *
 * `prd.md` R2/R3 and acceptance 4/5. The browser half has no DOM, so the panel is
 * rendered by CALLING `PairingSection` with the stub React: the returned element
 * tree is inspected directly. That proves the symbol reaches the tree, that it is
 * drawn from the same matrix the encoder produced, and that it follows the
 * selected address — it does NOT prove the symbol is scannable, which is what the
 * reference fixture and the one-off decoder round-trip are for.
 * ---------------------------------------------------------------------- */

/** Every node in an element tree matching a predicate. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (typeof node !== 'object') return found
  if (typeof node.type === 'string' && predicate(node)) found.push(node)
  findAll(node.children, predicate, found)
  return found
}

/** The concatenated text of an element tree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}

/** The props of a node, never undefined. */
function propsOf(node) {
  return node.props === null || node.props === undefined ? {} : node.props
}

/**
 * Repaint a `d` attribute back into a matrix.
 *
 * One `<path>` of horizontal runs is the whole picture, so replaying the runs is
 * the only way to check what was drawn.
 */
function paintPath(d, size) {
  const modules = new Uint8Array(size * size)
  const pattern = /M(\d+) (\d+)h(\d+)v1h-\3z/g
  let match
  while ((match = pattern.exec(d)) !== null) {
    const col = Number.parseInt(match[1], 10)
    const row = Number.parseInt(match[2], 10)
    const run = Number.parseInt(match[3], 10)
    for (let offset = 0; offset < run; offset++) modules[(row * size) + col + offset] = 1
  }
  return modules
}

/** A pairing snapshot shaped like `usePairing`'s result. */
function pairingSnapshot(overrides = {}) {
  const { current: currentOverrides, ...rest } = overrides
  return {
    busy: false,
    failure: null,
    remainingMs: 90_000,
    state: 'pending',
    start: async () => {},
    refresh: async () => {},
    clear: () => {},
    ...rest,
    current: {
      code: '7K3M9Q2X',
      fragment: 'AbCdEfGhIjKl:7K3M9Q2X',
      pairPath: '/remote-control/pair',
      port: 3090,
      ...(currentOverrides ?? {}),
    },
  }
}

/**
 * Render the pairing card and return the tree plus the URL it encoded.
 *
 * @param {{ addressText?: string, pairing?: object, mode?: 'lan' | 'public' }} [options]
 */
function renderPairing(options = {}) {
  const { bundle } = loadClientBundle()
  const { PairingSection, pairingUrl, fallbackTranslate } = bundle.internals
  const pairing = options.pairing ?? pairingSnapshot()
  const addressText = options.addressText ?? '192.168.9.77'
  const tree = PairingSection({
    t: fallbackTranslate,
    pairing,
    gateway: { listening: true },
    addressText,
    mode: options.mode ?? 'lan',
  })
  /* `documentBase()` degrades to 'http://localhost/' without a DOM, and with a
     usable address the fallback is never consulted. */
  const url = pairingUrl(pairing.current, addressText, 'http://localhost/')
  return { tree, url, bundle }
}

test('the pairing card renders a QR symbol built from the pairing link', () => {
  const { tree, url, bundle } = renderPairing()
  const { encodeQr, qrPathData, qrViewBox, EN } = bundle.internals

  const svg = findAll(tree, (node) => node.type === 'svg' && propsOf(node).className === 'drc-qr')
  assert.equal(svg.length, 1, 'exactly one QR symbol must be drawn')
  const props = propsOf(svg[0])
  assert.equal(props.role, 'img')
  assert.equal(props['aria-label'], EN['pair.qrAlt'], 'the label must be the readable dictionary string')
  assert.equal(props.shapeRendering, 'crispEdges', 'crisp edges, or the modules blur at small sizes')
  assert.equal(props.focusable, 'false', 'a decorative image must not enter the tab order')

  const expected = encodeQr(url)
  assert.equal(expected.ok, true, 'the fixture link must encode')
  assert.equal(props.viewBox, qrViewBox(expected.size))
  assert.deepEqual(props.viewBox, `-4 -4 ${expected.size + 8} ${expected.size + 8}`)

  const paths = findAll(svg[0], (node) => node.type === 'path')
  assert.equal(paths.length, 1, 'one path, not one node per module')
  assert.equal(propsOf(paths[0]).d, qrPathData(expected.modules, expected.size))
  assert.deepEqual(paintPath(propsOf(paths[0]).d, expected.size), expected.modules,
    'the drawn modules must be the encoder matrix')
  assert.equal(propsOf(paths[0]).fill, 'currentColor', 'the colour comes from the theme, not a literal')
})

test('the pairing card keeps the text code and the link beside the symbol', () => {
  /* `prd.md` D2: the QR is the fast path, never the only path. */
  const { tree, url } = renderPairing()
  const code = findAll(tree, (node) => propsOf(node).className === 'drc-code drc-mono')
  assert.equal(code.length, 1)
  assert.equal(textOf(code[0]), '7K3M9Q2X', 'the grouped code must still be readable and selectable')

  const link = findAll(tree, (node) => node.type === 'input')
  assert.equal(link.length, 1)
  assert.equal(propsOf(link[0]).value, url)
  assert.equal(propsOf(link[0]).readOnly, true)
})

test('switching the access address redraws the symbol and keeps the pairing code', () => {
  /* `prd.md` R3/acceptance 5: the link follows the address, the code does not. */
  const lan = renderPairing({ addressText: '192.168.9.77' })
  const other = renderPairing({ addressText: '10.0.0.4' })

  const dOf = (rendered) => {
    const path = findAll(rendered.tree, (node) => node.type === 'path')
    return propsOf(path[0]).d
  }
  const codeOf = (rendered) => textOf(findAll(rendered.tree, (node) => propsOf(node).className === 'drc-code drc-mono')[0])

  assert.notEqual(lan.url, other.url)
  assert.notEqual(dOf(lan), dOf(other), 'a different address must produce a different symbol')
  assert.equal(codeOf(lan), codeOf(other), 'the pairing code must survive an address switch')
})

test('a link too long for a symbol degrades to the text code, without throwing', () => {
  /* `prd.md` R4: never truncate, never emit a broken symbol, never take the panel
     down. The address field is capped at 253 characters, so the reachable way to
     exceed v15-M is a long host-supplied `pairPath`. */
  const pairing = pairingSnapshot({ current: { pairPath: '/' + 'p'.repeat(600) } })
  const { tree, url, bundle } = renderPairing({ pairing })
  const { encodeQr, EN } = bundle.internals

  assert.equal(encodeQr(url).ok, false, 'the fixture link must really be past capacity')
  assert.equal(findAll(tree, (node) => propsOf(node).className === 'drc-qr').length, 0,
    'no symbol may be drawn for a link that does not fit')
  assert.ok(textOf(tree).includes(EN['pair.tooLong']), 'the reason must be on screen')
  /* And the fallbacks are untouched. */
  assert.equal(textOf(findAll(tree, (node) => propsOf(node).className === 'drc-code drc-mono')[0]), '7K3M9Q2X')
  assert.equal(propsOf(findAll(tree, (node) => node.type === 'input')[0]).value, url)
})

test('the QR hint names the text code, so the symbol is never the only way in', () => {
  const { tree, bundle } = renderPairing()
  const { EN } = bundle.internals
  /* The hint sits in the TEXT column beside the symbol, not centred underneath
     it: at the symbol's width the sentence wraps to three narrow lines and pushes
     the code away from the eye that just found the symbol (2026-10-19 layout
     pass). It must still appear exactly once, and inside the pairing card. */
  const card = findAll(tree, (node) => propsOf(node).className === 'drc-pairCard')
  assert.equal(card.length, 1)
  const hints = findAll(card[0], (node) => propsOf(node).className === 'drc-hint'
    && textOf(node).includes(EN['pair.qrHint']))
  assert.equal(hints.length, 1, 'the hint must name the text code exactly once')
  const main = findAll(tree, (node) => propsOf(node).className === 'drc-pairMain')
  assert.equal(main.length, 1)
  assert.ok(textOf(main[0]).includes(EN['pair.qrHint']), 'and it belongs to the text column')
})

test('the pairing card offers a manual state refresh, and asks the host for it', () => {
  /* 2026-10-19: 已用的配对码显示已使用，支持手动刷新. The countdown cannot tell a
     waiting code from a redeemed one, and the card does not poll: the button is the
     whole mechanism (`prd.md`: no auto-refresh). */
  let asked = 0
  const { tree, bundle } = renderPairing({ pairing: pairingSnapshot({ refresh: async () => { asked += 1 } }) })
  const { EN } = bundle.internals

  const refresh = findAll(tree, (node) => node.type === 'button'
    && textOf(node) === EN['pair.refresh'])
  assert.equal(refresh.length, 1, 'one refresh button on a live code')
  propsOf(refresh[0]).onClick()
  return Promise.resolve().then(() => {
    assert.equal(asked, 1, 'the click must reach the hook, not just look like it does')
  })
})

test('a code the host reports as used shows 已使用 instead of a live countdown', () => {
  const { tree, bundle } = renderPairing({ pairing: pairingSnapshot({ state: 'used' }) })
  const { EN } = bundle.internals

  /* Nothing that invites a scan survives: a dead code's symbol, text and link are
     all removed, not merely annotated. */
  assert.equal(findAll(tree, (node) => propsOf(node).className === 'drc-qr').length, 0, 'no symbol')
  assert.equal(findAll(tree, (node) => propsOf(node).className === 'drc-code drc-mono').length, 0, 'no code')
  assert.equal(findAll(tree, (node) => node.type === 'input').length, 0, 'no link')

  const text = textOf(tree)
  assert.ok(text.includes(EN['pair.state.used']), '已使用 must be on screen')
  assert.ok(text.includes(EN['pair.state.usedHint']), 'and it must say the device is listed')
  assert.ok(text.includes(EN['pair.newCode']), 'the useful next action is offered')
  assert.ok(!text.includes(EN['pair.expires'].replace('{seconds}', '90')), 'no countdown for a dead code')
  assert.ok(!text.includes(EN['pair.refresh']), 'nothing left to refresh')
})

test('every dead pair state is named, and only a used one says the device paired', () => {
  const { bundle } = loadClientBundle()
  const { EN, pairingStateLabel, fallbackTranslate } = bundle.internals

  assert.equal(pairingStateLabel('pending', fallbackTranslate), null, 'a waiting code needs no badge')
  assert.equal(pairingStateLabel('used', fallbackTranslate), EN['pair.state.used'])
  assert.equal(pairingStateLabel('expired', fallbackTranslate), EN['pair.state.expired'])
  assert.equal(pairingStateLabel('locked', fallbackTranslate), EN['pair.state.locked'])
  assert.equal(pairingStateLabel('unknown', fallbackTranslate), EN['pair.state.unknown'])

  for (const state of ['expired', 'locked', 'unknown']) {
    const { tree } = renderPairing({ pairing: pairingSnapshot({ state }) })
    const text = textOf(tree)
    assert.ok(text.includes(EN['pair.state.' + state]), state)
    assert.ok(text.includes(EN['pair.state.deadHint']), state)
    assert.ok(!text.includes(EN['pair.state.usedHint']), `${state} must not claim the device paired`)
  }
})

test('an unrecognized host state is not trusted as a live code', () => {
  /* A newer host could report a state this bundle does not know. Painting it as
     live would invite a scan that may fail; `unknown` is the honest floor. */
  const { tree, bundle } = renderPairing({ pairing: pairingSnapshot({ state: 'rotated-out' }) })
  const { EN } = bundle.internals
  assert.ok(textOf(tree).includes(EN['pair.state.unknown']))
  assert.equal(findAll(tree, (node) => propsOf(node).className === 'drc-code drc-mono').length, 0)
})

test('the status route is a READ of one pair id, never a second mint', () => {
  /* Byte-level guard: the hook must ask `pairing/<id>` with the GET default, and
     must never post a refresh (a POST there would mint a new code). */
  assert.match(clientSource, /const PAIRING_STATUS_PATH = 'pairing'/)
  assert.match(
    clientSource,
    /requestJson\(PAIRING_STATUS_PATH \+ '\/' \+ encodeURIComponent\(current\.pairId\)\)/,
    'the refresh must name the pair and take the default method',
  )
})


test('the symbol is styled with theme tokens, a card-width cap and a real quiet zone', () => {
  /* Source level, because there is no layout engine here. The quiet zone is
     GEOMETRY — four modules carried by the viewBox — rather than a padding in
     pixels, because a fixed padding is ~1 module on a v1 symbol and ~3 on a v11
     one: it cannot be the four the standard asks for on every version. The CSS
     padding stays as extra breathing room around it. */
  const stylesheet = /const CSS = ([\s\S]*?)\]\.join\('\\n'\)/.exec(clientSource)
  assert.ok(stylesheet !== null, 'the injected stylesheet must be discoverable')
  const css = stylesheet[1]

  /* 176px, not a viewport-relative cap: the pairing card is two columns and the
     symbol column has to leave ~374px for the code, the countdown and the link
     inside a 640px modal. Growing it is a layout decision, not a fluid one. */
  assert.match(css, /\.drc-qr\{[^}]*width:176px/)
  assert.match(css, /\.drc-qr\{[^}]*aspect-ratio:1/)
  assert.match(css, /\.drc-qr\{[^}]*padding:10px/, 'the extra margin around the quiet zone')

  /* A QR symbol is dark modules on a LIGHT surround in every theme. The
     `--dsw-alias-*` pair used to be asked for that, but it flips: on a dark theme
     label-primary turns light and bg-layer-1 turns dark, so the panel drew a
     light-on-dark symbol. The theme-independent members of the token set are the
     only ones that keep the polarity fixed, and they are still tokens. */
  assert.match(css, /\.drc-qr\{[^}]*color:var\(--dsw-static-neutral-bluish-1000\)/)
  assert.match(css, /\.drc-qr\{[^}]*background:var\(--dsw-static-neutral-bluish-00\)/)
  assert.ok(!/\.drc-qr\{[^}]*color:var\(--dsw-alias-label-primary\)/.test(css),
    'the module colour must not follow the theme, or a dark theme inverts the symbol')
  assert.ok(!/\.drc-qr\{[^}]*background:var\(--dsw-alias-bg-layer-1\)/.test(css),
    'the surround must stay light on every theme')
  /* No literal colour anywhere near the symbol. */
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no hex colour may appear in the stylesheet')
})

test('the QR strings exist in both languages and in the locale files', () => {
  const { ZH, EN } = loadClientBundle().bundle.internals
  const zhFile = readJson('locale/zh.json')
  const enFile = readJson('locale/en.json')
  for (const key of ['pair.qrAlt', 'pair.qrHint', 'pair.tooLong']) {
    assert.equal(typeof ZH[key], 'string', `zh.${key} is missing`)
    assert.equal(typeof EN[key], 'string', `en.${key} is missing`)
    assert.equal(zhFile[key], ZH[key], `locale/zh.json disagrees with the inline ZH for ${key}`)
    assert.equal(enFile[key], EN[key], `locale/en.json disagrees with the inline EN for ${key}`)
  }
  /* The label has to be readable on its own: it is what a screen reader announces
     in place of the image. */
  assert.ok(EN['pair.qrAlt'].length >= 8 && ZH['pair.qrAlt'].length >= 4)
  /* And the too-long message must point at the fallback rather than just refuse. */
  assert.match(EN['pair.tooLong'], /text code/i)
  assert.match(ZH['pair.tooLong'], /文本码/)
})

/* ---------------------------------------------------------------------- *
 * Panel tabs (`prd.md` R1–R3) and audit detail (R5–R7)
 *
 * Structure and data flow only: the tab bar's ARIA graph, the default-tab rule, the
 * status strip's three states and the four fields of an audit row are all element
 * trees returned by plain functions. Layout, real focus movement and the network
 * are NOT covered here — `implement.md` step 5 checks those in a real browser.
 * ---------------------------------------------------------------------- */

test('the default tab follows whether pairing is usable right now', () => {
  const { preferredTab } = loadClientBundle().bundle.internals

  /* `prd.md` R2: a pairing code cannot be minted while nothing is listening, so the
     access screen is the honest first screen. */
  assert.equal(preferredTab({ enabled: true, port: 3090 }, { listening: true }), 'pairing')
  assert.equal(preferredTab({ enabled: true, port: 3090 }, { listening: false }), 'access')
  assert.equal(preferredTab({ enabled: false, port: 3090 }, { listening: false }), 'access')
  /* The setting is not the listener's truth: a stale `enabled: false` must not win
     over a gateway that is actually listening, and vice versa. */
  assert.equal(preferredTab({ enabled: false, port: 3090 }, { listening: true }), 'access')
  /* Nothing has arrived yet, and a host with no gateway at all. */
  assert.equal(preferredTab(null, null), 'access')
  assert.equal(preferredTab(undefined, undefined), 'access')
  assert.equal(preferredTab('nope', 'nope'), 'access')
})

test('the chosen tab is never remembered across opens', () => {
  /* `prd.md` constraint 4: the panel unmounts on close, so the tab is component
     state and nothing else. A stored tab would re-open the panel on a screen whose
     state may no longer exist — "pairing" with nothing listening, for instance. */
  assert.ok(!/localStorage\.|sessionStorage\./.test(clientSource), 'no tab persistence')
  assert.match(clientSource, /const \[tab, setTab\] = useState\(null\)/)
  assert.match(clientSource, /preferredTab\(settings, gateway\)/)
  /* `null` until the user chooses is what makes the FIRST screen follow the host
     rather than a default frozen at mount. */
  assert.match(clientSource, /tab === null \|\| !TAB_KEYS\.includes\(tab\)/)
})

test('the tab bar exposes the ARIA tabs contract in both directions', () => {
  const { bundle } = loadClientBundle()
  const { TabList, TABS, EN, fallbackTranslate } = bundle.internals

  const tree = TabList({ t: fallbackTranslate, current: 'devices', onSelect: () => {} })

  const lists = findAll(tree, (node) => propsOf(node).role === 'tablist')
  assert.equal(lists.length, 1, 'one tablist')

  const tabs = findAll(tree, (node) => propsOf(node).role === 'tab')
  assert.equal(tabs.length, 4, 'four tabs, one per panel')
  assert.deepEqual(
    tabs.map((node) => propsOf(node).id),
    ['drc-tab-pairing', 'drc-tab-access', 'drc-tab-devices', 'drc-tab-audit'],
  )
  assert.deepEqual(
    tabs.map((node) => propsOf(node)['aria-controls']),
    ['drc-panel-pairing', 'drc-panel-access', 'drc-panel-devices', 'drc-panel-audit'],
  )
  /* Exactly one selected — the whole point of `aria-selected`. */
  const selected = tabs.filter((node) => propsOf(node)['aria-selected'] === true)
  assert.equal(selected.length, 1)
  assert.equal(propsOf(selected[0]).id, 'drc-tab-devices')
  /* Roving tabindex: the bar is ONE stop in the page's Tab order. */
  assert.deepEqual(tabs.map((node) => propsOf(node).tabIndex), [-1, -1, 0, -1])
  /* Every tab is a real button, labelled from the dictionary and keyed. */
  for (const node of tabs) {
    assert.equal(node.type, 'button')
    assert.equal(propsOf(node).type, 'button')
    assert.equal(typeof propsOf(node).onKeyDown, 'function')
    assert.equal(typeof propsOf(node).onClick, 'function')
  }
  assert.deepEqual(tabs.map((node) => textOf(node)), TABS.map((tab) => EN[tab.labelKey]))

  /* The panel side is wired from the SAME key, and every panel element exists so
     `aria-controls` always resolves; only the active one is visible. */
  assert.match(clientSource, /'aria-labelledby': 'drc-tab-' \+ key/)
  assert.match(clientSource, /id: 'drc-panel-' \+ key/)
  assert.match(clientSource, /hidden: key !== activeTab/)
})

test('a visited tab stays mounted, so switching cannot discard a draft or a pending request', () => {
  /* `prd.md` constraint 4 + review finding: rendering only the active section
     unmounted the others on every switch, and those sections own live state — an
     unsaved address row, a port draft, a revoke confirmation, a page cursor. The
     panel keeps them mounted and marks them `hidden`, which is also what removes
     them from the accessibility tree and the tab order. */
  assert.match(clientSource, /const mounted = key === activeTab \|\| \(visited !== null && visited\[key\] === true\)/)
  assert.match(clientSource, /\}, mounted \? sectionsOf\(key\) : null\)/)

  /* A tab that has never been opened must NOT be mounted: laziness is what keeps a
     fresh panel free of four pre-fetched sections. */
  const visited = /const \[visited, setVisited\] = useState\(null\)/
  assert.match(clientSource, visited ? visited : /$^/)
  assert.match(clientSource, /previous\[activeTab\] === true/)
})

test('the audit detail list does not open a second scroll container', () => {
  /* Review finding: the list capped itself at 260px with its own overflow while
     `.drc-body` also scrolled, so wheel/trackpad input moved two independent
     tracks. One scrollbar, at the panel level. */
  const stylesheet = /const CSS = ([\s\S]*?)\]\.join\('\\n'\)/.exec(clientSource)
  assert.ok(stylesheet !== null)
  const css = stylesheet[1]
  const list = /\.drc-auditEvents\{[^}]*\}/.exec(css)
  assert.ok(list !== null, 'the detail list must have a rule')
  assert.ok(!/overflow-y:auto/.test(list[0]), 'the detail list must not scroll on its own')
  assert.ok(!/max-height/.test(list[0]), 'and must not cap its own height')
  assert.match(css, /\.drc-body\{[^}]*overflow-y:auto/, 'the panel body remains the only scroller')
})

test('ArrowLeft/ArrowRight wrap, Home/End jump, and focus follows selection', () => {
  const { tabIndexAfterKey } = loadClientBundle().bundle.internals

  assert.equal(tabIndexAfterKey('ArrowRight', 0, 4), 1)
  assert.equal(tabIndexAfterKey('ArrowRight', 3, 4), 0, 'the last tab wraps to the first')
  assert.equal(tabIndexAfterKey('ArrowLeft', 0, 4), 3, 'and the first wraps backwards')
  assert.equal(tabIndexAfterKey('ArrowLeft', 2, 4), 1)
  assert.equal(tabIndexAfterKey('Home', 2, 4), 0)
  assert.equal(tabIndexAfterKey('End', 1, 4), 3)
  /* Only the documented keys move. `Tab` in particular must stay the browser's, or
     the modal's focus trap stops being the only thing that decides where Tab goes. */
  assert.equal(tabIndexAfterKey('Tab', 1, 4), null)
  assert.equal(tabIndexAfterKey('ArrowUp', 1, 4), null)
  assert.equal(tabIndexAfterKey('Escape', 1, 4), null)
  assert.equal(tabIndexAfterKey('ArrowRight', 9, 4), 1, 'an out-of-range index starts from the first')
  assert.equal(tabIndexAfterKey('ArrowRight', 0, 0), null)

  /* The handler prevents the default (or the page would also scroll) and selects;
     the selection moves focus itself, so a keyboard user is never left behind. */
  const handler = /const onKeyDown = \(index\) => \(event\) => \{([\s\S]*?)\n      \}/.exec(clientSource)
  assert.ok(handler !== null, 'the tab keydown handler must be discoverable')
  assert.match(handler[1], /event\.preventDefault\(\)/)
  assert.match(handler[1], /select\(next\)/)

  const select = /const select = \(index\) => \{([\s\S]*?)\n      \}/.exec(clientSource)
  assert.ok(select !== null, 'the tab selection helper must be discoverable')
  assert.match(select[1], /onSelect\(key\)/)
  assert.match(select[1], /\.focus\(\)/, 'focus must follow the selected tab')
})

test('the panel shell renders the status strip, the tabs and one visible panel', () => {
  /* The whole shell in one tree: header, status strip, tab bar, and one panel body
     per tab with exactly one visible. Called as a plain function with the stub React
     and no DOM — the hooks return their initial values, so this is the "nothing has
     loaded yet" state.
     `findAll` only walks NATIVE elements (`node.type` a string), so the component
     children are located by their function identity instead. */
  const { bundle } = loadClientBundle()
  const { Panel, TabList, StatusStrip, fallbackTranslate, EN } = bundle.internals

  const tree = Panel({ t: fallbackTranslate, onClose: () => {}, panelRef: { current: null } })
  const flatten = (nodes) => (Array.isArray(nodes) ? nodes.flat(Infinity) : [nodes]).filter((node) => node != null)

  assert.equal(propsOf(tree).className, 'drc-overlay')
  const card = flatten(tree.children)[0]
  assert.equal(propsOf(card).role, 'dialog')
  assert.equal(propsOf(card)['aria-modal'], 'true')

  /* Status strip and tab bar live inside the dialog, above the scrolling body, so
     neither scrolls away with a tab's content. */
  const parts = flatten(card.children)
  const strip = parts.find((node) => node.type === StatusStrip)
  assert.ok(strip !== undefined, 'the status strip must be rendered by the shell')
  /* Nothing has loaded: the strip is told about the null state rather than inventing
     one, which is what makes "远程接入未启用" honest before the first read. */
  assert.equal(strip.props.settings, null)
  assert.equal(strip.props.gateway, null)

  const tabs = parts.find((node) => node.type === TabList)
  assert.ok(tabs !== undefined, 'the tab bar must be rendered by the shell')
  /* No state yet, so the default tab is the access screen (R2's "otherwise"). */
  assert.equal(tabs.props.current, 'access')
  assert.equal(typeof tabs.props.onSelect, 'function')

  const body = parts.find((node) => node.type === 'div' && propsOf(node).className === 'drc-body')
  assert.ok(body !== undefined, 'the scrolling body must be present')
  const panels = flatten(body.children).filter((node) => propsOf(node).role === 'tabpanel')
  assert.equal(panels.length, 4, 'one panel per tab, so every aria-controls resolves')

  /* Exactly one visible panel, and with nothing loaded it says so rather than
     rendering a form from `null`. */
  const visible = panels.filter((node) => propsOf(node).hidden !== true)
  assert.equal(visible.length, 1)
  assert.equal(propsOf(visible[0])['aria-labelledby'], 'drc-tab-access')
  assert.ok(textOf(visible[0]).includes(EN['panel.loading']))
})

test('the modal focus trap still owns Tab, roving tabs included', () => {
  /* A tab that is not selected carries `tabIndex:-1` but is still a `button`, so the
     trap's query matches it. Counting it as a stop would put the cycle's edge on an
     element the browser skips over — the tabs must not become a Tab-escape hatch. */
  assert.match(clientSource, /if \(event\.key !== 'Tab'\) return/)
  assert.match(clientSource, /node\.tabIndex !== -1/)
  assert.match(clientSource, /const first = focusable\[0\]/)
  assert.match(clientSource, /event\.shiftKey === true/)
  /* Esc still closes the dialog, and the tabs bind no dismissal of their own. */
  assert.match(clientSource, /event\.key === 'Escape'/)
  assert.equal((clientSource.match(/setOpen\(false\)/g) ?? []).length, 2,
    'still exactly two ways out: Esc and the close button')
})

test('the status strip reports the listener truth, on every tab', () => {
  const { bundle } = loadClientBundle()
  const { StatusStrip, fallbackTranslate, EN } = bundle.internals

  const listening = StatusStrip({
    t: fallbackTranslate,
    settings: { enabled: true, port: 3090 },
    gateway: { listening: true, port: 3090, liveConnections: 0 },
    devices: { active: 2, total: 3 },
  })
  assert.equal(textOf(listening), 'Listening on 3090 · 0 connection(s) · 2 device(s)')
  assert.equal(propsOf(listening).className, 'drc-statusStrip')

  /* Enabled but nothing listening: the access section's OWN sentence, so one
     condition never gets two different explanations. */
  const notListening = StatusStrip({
    t: fallbackTranslate,
    settings: { enabled: true },
    gateway: { listening: false },
    devices: { active: 2 },
  })
  assert.equal(textOf(notListening), EN['access.gatewayNotListening'])

  /* Off: plain text, no state colour — being off is a fact, not an error. */
  const off = StatusStrip({ t: fallbackTranslate, settings: { enabled: false }, gateway: null, devices: null })
  assert.equal(textOf(off), EN['status.disabled'])
  assert.equal(propsOf(off).className, 'drc-statusStrip')

  /* A gateway that has not reported its port yet degrades instead of throwing. */
  const unknownPort = StatusStrip({
    t: fallbackTranslate,
    settings: { enabled: true },
    gateway: { listening: true },
    devices: null,
  })
  assert.equal(textOf(unknownPort), 'Listening on ? · 0 connection(s) · 0 device(s)')

  /* And it lives OUTSIDE the scrolling body, which is what keeps it visible. */
  const stripAt = clientSource.indexOf('h(StatusStrip,')
  const bodyAt = clientSource.indexOf("h('div', { className: 'drc-body' }")
  assert.ok(stripAt > 0 && bodyAt > 0 && stripAt < bodyAt, 'the status strip must not scroll away')
})

test('an audit row renders four fields, and never meta', () => {
  const { bundle } = loadClientBundle()
  const { AuditEventList, AuditEventRow, normalizeAuditEvent, fallbackTranslate, EN } = bundle.internals

  const sameDay = new Date(2026, 9, 17, 17, 42, 3).toISOString()
  const otherDay = new Date(2026, 9, 15, 9, 5, 0).toISOString()
  const devices = [{ id: 'dev_known', name: 'Pixel · Chrome' }]
  /* The row takes its clock as a parameter, so 「今天」 is a fixed instant here
     instead of whatever day the suite happens to run on. */
  const now = new Date(2026, 9, 17, 18, 0, 0).getTime()

  const older = normalizeAuditEvent({ ts: otherDay, event: 'pair', deviceId: 'dev_gone', ip: '192.168.1.7' })
  const newer = normalizeAuditEvent({ ts: sameDay, event: 'send_message', deviceId: 'dev_known', meta: { text: 'hunter2' } })

  /* The row is rendered directly: a component element is not EXPANDED by the stub
     React, so asserting on the list alone would only prove it produces elements. */
  const rows = [older, newer].map((event) => AuditEventRow({ t: fallbackTranslate, event, devices, now }))
  assert.deepEqual(rows.map((row) => row.type), ['li', 'li'])
  for (const row of rows) {
    assert.equal(findAll(row, (node) => node.type === 'span').length, 4, 'four cells: time, action, device, address')
  }

  /* The date appears only when the record is not from today. */
  assert.equal(textOf(rows[0]), '10-15 09:05:00' + EN['audit.event.pair'] + 'dev_gone' + '192.168.1.7')
  assert.equal(textOf(rows[1]), '17:42:03' + EN['audit.event.send_message'] + 'Pixel · Chrome' + '—')
  /* The full instant stays reachable on the time cell's `title`. */
  const timeCell = findAll(rows[1], (node) => propsOf(node).className === 'drc-auditEventTime')[0]
  assert.equal(propsOf(timeCell).title, new Date(sameDay).toISOString())

  /* The list is one keyed row per record, in the order the host returned them. */
  const list = AuditEventList({ t: fallbackTranslate, events: [older, newer], devices })
  assert.equal(list.type, 'ul')
  assert.equal(propsOf(list).className, 'drc-auditEvents')
  const children = list.children[0]
  assert.equal(children.length, 2)
  assert.deepEqual(children.map((node) => node.type), [AuditEventRow, AuditEventRow])
  assert.deepEqual(children.map((node) => propsOf(node).key), ['e0', 'e1'])

  /* The DOM half of `prd.md` D5: even a record that DOES carry `meta` renders only
     the four projected fields — there is no slot for free text. */
  const hostile = AuditEventRow({
    t: fallbackTranslate,
    event: { ts: sameDay, event: 'pair', deviceId: 'dev_1', ip: '10.0.0.1', meta: { text: 'hunter2' }, body: 'prompt' },
  })
  assert.ok(!textOf(hostile).includes('hunter2'), 'free text in meta must never be rendered')
  assert.ok(!textOf(hostile).includes('prompt'))
})

test('the audit detail request names no page size and pages with the cursor', () => {
  const { auditEventsQuery, AUDIT_EVENTS_PATH } = loadClientBundle().bundle.internals

  assert.equal(AUDIT_EVENTS_PATH, 'audit/events')
  assert.ok(!AUDIT_EVENTS_PATH.startsWith('/'), 'mount-relative, like every other admin path')
  assert.equal(auditEventsQuery(), 'audit/events')
  assert.equal(auditEventsQuery('', ''), 'audit/events')
  assert.equal(auditEventsQuery('pair'), 'audit/events?action=pair')
  assert.equal(auditEventsQuery('', '1792206283003.4'), 'audit/events?before=1792206283003.4')
  assert.equal(auditEventsQuery('pair', '1.2'), 'audit/events?action=pair&before=1.2')
  /* The page size has ONE definition, on the host (`AUDIT_EVENTS_PAGE_SIZE`), so the
     panel never sends one. */
  assert.ok(!/limit=/.test(auditEventsQuery('pair', '1.2')))
  /* Values are data, not path syntax. */
  assert.match(auditEventsQuery('a b', '1.2/3'), /action=a%20b/)
  assert.match(auditEventsQuery('a b', '1.2/3'), /before=1\.2%2F3/)
})

test('loading more appends, and a filter change restarts the list', () => {
  const { appendAuditPage, normalizeAuditEvent } = loadClientBundle().bundle.internals

  const a = { ts: '2026-10-17T03:04:43.000Z', event: 'pair', deviceId: 'dev_a' }
  const b = { ts: '2026-10-17T03:04:42.000Z', event: 'connect', deviceId: 'dev_b' }
  const c = { ts: '2026-10-17T03:04:41.000Z', event: 'pair', deviceId: 'dev_c' }

  assert.deepEqual(appendAuditPage([], [a], null), [a])
  assert.deepEqual(appendAuditPage([a], [b], 'cursor'), [a, b], 'a later page is appended, not swapped')
  assert.deepEqual(appendAuditPage([a, b], [c], null), [c],
    'a first page replaces: that is what makes the filter switch a reset')
  /* A record carrying anything extra is normalized on the way in. */
  assert.deepEqual(normalizeAuditEvent({ ...a, meta: { text: 'hunter2' }, body: 'prompt' }), a)
  assert.equal(normalizeAuditEvent({ event: 'pair' }), null, 'a record without a usable ts is not renderable')
  assert.equal(normalizeAuditEvent(null), null)
  /* Junk in the page is dropped rather than rendered as an empty row. */
  assert.deepEqual(appendAuditPage([], [a, null, 42, { event: 'pair' }], null), [a])

  /* The component resets paging state when the filter changes, and appends on
     「加载更多」 — both are state transitions, so only the source can show them. */
  assert.match(clientSource, /const changeAction = \(value\) => \{[\s\S]*?setEvents\(\[\]\)[\s\S]*?setNextBefore\(null\)/)
  assert.match(clientSource, /setEvents\(\(current\) => appendAuditPage\(current, page, before\)\)/)
  assert.match(clientSource, /void fetchPage\(nextBefore\)/)
})

test('the audit filter is built from the host action list, never a client copy', () => {
  const { bundle } = loadClientBundle()
  const { auditActionsOf, AuditEventsSection, fallbackTranslate, EN } = bundle.internals

  /* Nothing to invent: no state, no `actions`, no valid entries. */
  assert.deepEqual(auditActionsOf(null), [])
  assert.deepEqual(auditActionsOf({}), [])
  assert.deepEqual(auditActionsOf({ audit: null }), [])
  assert.deepEqual(auditActionsOf({ audit: { actions: 'nope' } }), [])
  assert.deepEqual(auditActionsOf({ audit: { actions: ['pair', '', 7, 'revoke'] } }), ['pair', 'revoke'])

  /* The dropdown is 「全部」 plus the host's list, labelled from the dictionary. */
  const tree = AuditEventsSection({ t: fallbackTranslate, actions: ['pair', 'revoke'], devices: [] })
  const select = findAll(tree, (node) => node.type === 'select')
  assert.equal(select.length, 1)
  assert.equal(propsOf(select[0])['aria-label'], EN['audit.detail.filter'])
  const options = findAll(select[0], (node) => node.type === 'option')
  assert.deepEqual(options.map((node) => propsOf(node).value), ['', 'pair', 'revoke'])
  assert.deepEqual(
    options.map((node) => textOf(node)),
    [EN['audit.detail.all'], EN['audit.event.pair'], EN['audit.event.revoke']],
  )
  /* First render, before any response: the loading line, not an empty list claim. */
  assert.ok(textOf(tree).includes(EN['audit.detail.loading']))
})

test('the client half carries no copy of the audit action closed set', () => {
  /* `design.md` §3. A duplicated literal drifts, and the drift shows up as a
     dropdown entry the server answers with 400 or a missing entry that can never be
     filtered to — so the list lives on the host and arrives through `GET /state`. */
  const auditSource = readFileSync(path.join(repoRoot, 'src/host/audit.js'), 'utf8')
  const block = /export const AUDIT_EVENTS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(auditSource)
  assert.ok(block !== null, 'AUDIT_EVENTS must be discoverable in src/host/audit.js')
  const events = [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  assert.ok(events.length >= 5)

  /* A copied array must contain at least one ADJACENT pair of the ordered list, so
     checking every pair cannot be evaded by reordering. (A single name is not
     enough: `unknown` is legitimately a failure kind, not an action list.) */
  for (let index = 0; index + 1 < events.length; index += 1) {
    const pattern = new RegExp(`'${events[index]}'\\s*,\\s*'${events[index + 1]}'`)
    assert.equal(
      pattern.test(clientSource),
      false,
      `the client must not hardcode the action pair ${events[index]}/${events[index + 1]}`,
    )
  }

  /* And the intended data path is present instead. */
  assert.match(clientSource, /auditActionsOf\(state\)/)
  assert.match(clientSource, /Array\.isArray\(audit\.actions\)/)
  assert.match(clientSource, /t\('audit\.event\.' \+ name\)/)
})

test('the tab, status and audit-detail strings exist in all four copies', () => {
  const { bundle } = loadClientBundle()
  const { ZH, EN, TABS } = bundle.internals
  const zhFile = readJson('locale/zh.json')
  const enFile = readJson('locale/en.json')

  const keys = [
    'tabs.pairing',
    'tabs.access',
    'tabs.devices',
    'tabs.audit',
    'status.listening',
    'status.disabled',
    'audit.detail.heading',
    'audit.detail.filter',
    'audit.detail.all',
    'audit.detail.loading',
    'audit.detail.shown',
    'audit.detail.loadMore',
    'audit.detail.loadingMore',
    'audit.detail.noMore',
  ]
  for (const key of keys) {
    assert.equal(typeof ZH[key], 'string', `zh.${key} is missing`)
    assert.equal(typeof EN[key], 'string', `en.${key} is missing`)
    assert.equal(zhFile[key], ZH[key], `locale/zh.json disagrees with the inline ZH for ${key}`)
    assert.equal(enFile[key], EN[key], `locale/en.json disagrees with the inline EN for ${key}`)
  }
  /* Every tab names a label, or a tab renders as a raw key on screen. */
  assert.deepEqual(TABS.map((tab) => tab.labelKey), ['tabs.pairing', 'tabs.access', 'tabs.devices', 'tabs.audit'])
  for (const tab of TABS) assert.equal(typeof EN[tab.labelKey], 'string')
})

test('the panel puts its two global settings above the tabs, and each tab keeps one job', () => {
  /* Review reshape: the master switch and the listener port are panel-wide facts, so
     they live in a configuration row above the tablist; 配对 owns the access point,
     接入 owns the address book alone. */
  for (const name of ['ConfigBar', 'PublicBookSection', 'AccessPointSection', 'PairingSection', 'DeviceSection', 'AuditSection']) {
    assert.match(clientSource, new RegExp(`h\\(${name}, \\{`), `${name} must still be rendered`)
  }
  /* Header → configuration → status → tabs. */
  assert.match(clientSource, /h\(ConfigBar, \{ t, settings, updateSettings: status\.updateSettings \}\)/)
  assert.match(clientSource, /h\(StatusStrip, \{ t, settings, gateway, devices: deviceCounts \}\)/)
  assert.match(clientSource, /h\(TabList, \{ t, current: activeTab, onSelect: \(key\) => setTab\(key\) \}\)/)
  /* Both global controls really are in that row, and nowhere else. */
  const bar = /function ConfigBar\(\{ t, settings, updateSettings \}\) \{([\s\S]*?)\n    \}/.exec(clientSource)
  assert.ok(bar !== null, 'ConfigBar must be discoverable')
  assert.match(bar[1], /role: 'switch'/)
  assert.match(bar[1], /t\('access\.port'\)/)
  assert.match(bar[1], /t\('access\.save'\)/)
  /* 配对 = access point + pairing card; 接入 = the book, and only the book. */
  assert.match(clientSource, /case 'pairing':[\s\S]{0,800}?h\(AccessPointSection, \{/)
  assert.match(clientSource, /h\(AccessPointSection, \{[\s\S]{0,900}?h\(PairingSection, \{/)
  assert.match(clientSource, /case 'access':[\s\S]{0,400}?h\(PublicBookSection, \{/)
  assert.match(clientSource, /case 'audit':[\s\S]{0,200}?h\(AuditEventsSection, \{/)

  /* The tab shell's stylesheet: theme tokens only, and one scrolling layer. */
  const stylesheet = /const CSS = ([\s\S]*?)\]\.join\('\\n'\)/.exec(clientSource)
  assert.ok(stylesheet !== null)
  const css = stylesheet[1]
  for (const selector of ['.drc-tabs{', '.drc-tab{', '.drc-tabActive{', '.drc-statusStrip{', '.drc-panelBody{']) {
    assert.ok(css.includes(selector), `${selector} must be defined`)
  }
  assert.match(css, /\.drc-panelBody\[hidden\]\{display:none\}/,
    'a hidden panel must be display:none, or the class overrides the attribute')
  assert.match(css, /\.drc-body\{[^}]*flex:1 1 auto/)
  assert.match(css, /\.drc-body\{[^}]*min-height:0/, 'a flex child must be allowed to shrink to scroll')
  assert.match(css, /\.drc-tabActive\{[^}]*var\(--dsw-alias-brand-primary\)/)
  /* One scrolling layer: the panel body. The detail list used to cap itself at
     260px with its own `overflow-y:auto`, which put a second scrollbar inside the
     scrolling modal (review finding) — see the dedicated test below. */
  const detailList = /\.drc-auditEvents\{[^}]*\}/.exec(css)
  assert.ok(detailList !== null)
  assert.ok(!/overflow/.test(detailList[0]), 'the detail list must not scroll on its own')
})

