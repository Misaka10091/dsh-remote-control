/**
 * Package-level invariants.
 *
 * The kind of test that catches a release mistake rather than a logic bug
 * (`dsh-git-panel` ships the same shape as `tests/smoke.mjs`): the two manifests
 * must agree on the version, every path listed in `files` must exist, and the
 * host half must stay dependency-free and shell-free.
 *
 * These assertions are deliberately brittle: if a future edit makes one of them
 * fail, the release is wrong, not the test.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Read and parse a repo-root file. */
function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

const pkg = readJson('package.json')
const manifest = readJson('dsh.plugin.json')

/**
 * Every host-side source file the package ships.
 *
 * Enumerated from disk rather than hand-listed: the point of the assertions that
 * use it is to cover files a future edit adds, and a hard-coded list would silently
 * stop covering the new ones.
 *
 * @returns {string[]} Repo-relative POSIX paths.
 */
function hostSources() {
  const sources = ['src/index.js']
  const hostDir = path.join(repoRoot, 'src', 'host')
  for (const entry of readdirSync(hostDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) sources.push(`src/host/${entry.name}`)
  }
  const gatewayDir = path.join(hostDir, 'gateway')
  if (existsSync(gatewayDir)) {
    for (const entry of readdirSync(gatewayDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) sources.push(`src/host/gateway/${entry.name}`)
    }
  }
  return sources
}

test('package.json carries the documented identity', () => {
  assert.equal(pkg.name, '@misaka10091/dsh-remote-control')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.main, 'src/index.js')
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './src/client.js')
  assert.equal(pkg.icon, undefined, 'icon is referenced through the files list unless a host needs it')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('the engine floor matches the documented floor', () => {
  assert.equal(pkg.engines.node, '>=18')
  assert.equal(pkg.engines.dsh, '>=0.2.0-rc.2')
  assert.equal(manifest.engines.dsh, pkg.engines.dsh)
})

test('the two manifests agree on the version', () => {
  assert.equal(manifest.version, pkg.version)
})

test('the dsh manifest carries the documented id and entry point', () => {
  assert.equal(manifest.id, 'dsh-external/dsh-remote-control')
  assert.equal(manifest.main, './src/index.js')
  assert.ok(typeof manifest.description === 'string' && manifest.description.length > 0)
  assert.deepEqual(manifest.contributes, { tools: [], skills: [] })
})

test('the package is dependency-free apart from Node built-ins', () => {
  /* Zero runtime dependencies is a design decision, not an accident: the whole
     host half uses node: built-ins, including the WebSocket passthrough (raw
     sockets, no `ws`). A dependency showing up here needs a README paragraph. */
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
})

test('every path listed in files exists', () => {
  for (const entry of pkg.files) {
    assert.ok(existsSync(path.join(repoRoot, entry)), `missing packaged file: ${entry}`)
  }
})

test('the entry points named by the manifests exist and are reachable', () => {
  assert.ok(existsSync(path.join(repoRoot, 'src/index.js')))
  assert.ok(existsSync(path.join(repoRoot, 'src/client.js')))
  assert.ok(existsSync(path.join(repoRoot, 'cordis.patch.yml')))
  assert.ok(existsSync(path.join(repoRoot, 'dsh.plugin.json')))
  assert.ok(existsSync(path.join(repoRoot, 'locale/zh.json')))
  assert.ok(existsSync(path.join(repoRoot, 'locale/en.json')))
})

test('the bundle patch inserts exactly one row for this package', () => {
  const patch = readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8')
  const rows = patch.match(/^\s*-\s+id:/gm) ?? []
  assert.equal(rows.length, 1, 'the patch must insert one row')
  assert.match(patch, /- insert:\s*\n\s*- id: remote-control/)
  assert.match(patch, /name: '@misaka10091\/dsh-remote-control'/)
})

test('the patch row id and the package name match what the loader will look for', () => {
  const patch = readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8')
  const id = patch.match(/^\s*- id:\s*(\S+)/m)[1]
  const name = patch.match(/^\s*name:\s*'([^']+)'/m)[1]
  assert.equal(id, 'remote-control')
  assert.equal(name, pkg.name)
})

test('the locale files are valid JSON and share one key set', () => {
  const zh = readJson('locale/zh.json')
  const en = readJson('locale/en.json')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('the host half never shells out', () => {
  /* No external process is needed anywhere in this package; `shell: true` or an
     `exec` would be a supply-chain surface for no benefit. */
  const sources = hostSources()
  for (const relative of sources) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8')
    assert.ok(!/shell\s*:\s*true/.test(source), `${relative} must not use shell: true`)
    assert.ok(!/\bexecSync\b|\bexec\(/.test(source), `${relative} must not execute external commands`)
    assert.ok(!/node:child_process/.test(source), `${relative} must not import node:child_process`)
  }
})

test('the host half logs through ctx.logger, never console', () => {
  for (const relative of hostSources()) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8')
    /* `console.` in a comment is fine; a call is not. */
    assert.ok(
      !/console\.(log|info|warn|error|debug)\s*\(/.test(source),
      `${relative} must not log to the console`,
    )
  }
})

test('the host half imports only node: built-ins and its own modules', () => {
  /* Zero runtime dependencies is locked by the test above, but an import of a bare
     package would escape it: the module resolution would simply fail at load time
     on a host that does not happen to have it. */
  const allowedBare = new Set()
  for (const relative of hostSources()) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8')
    for (const match of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1]
      const ok = specifier.startsWith('node:')
        || specifier.startsWith('./')
        || specifier.startsWith('../')
        || allowedBare.has(specifier)
      assert.ok(ok, `${relative} imports ${specifier}, which is outside the allowed set`)
    }
  }
})

test('the WebSocket proxy imports no frame library, so zero dependencies holds', () => {
  /* `research/official-connection-fence.md` §6.1: the measured ground truth is
     that a byte-forwarding upgrade needs no `ws` — bare `node:net`, a hand-written
     request line and a bidirectional pipe. The zero-dependency claim survives
     stage 3 because of it, so this guards the claim from being quietly abandoned
     for a library that would only parse frames nobody reads. */
  for (const relative of hostSources()) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8')
    assert.ok(!/from\s+['"]ws['"]/.test(source), `${relative} must not import ws`)
    assert.ok(!/require\(\s*['"]ws['"]\s*\)/.test(source), `${relative} must not require ws`)
    assert.ok(!/node:http2/.test(source), `${relative} must not pull in the http2 stack`)
  }

  /* And the passthrough really is built on raw sockets. */
  const wsproxy = readFileSync(path.join(repoRoot, 'src/host/gateway/wsproxy.js'), 'utf8')
  assert.match(wsproxy, /from 'node:net'/, 'the upgrade hop speaks the handshake over node:net')
  assert.match(wsproxy, /connection = 'Upgrade'/, 'this hop writes its own upgrade handshake')
})

test('the gateway modules exist and are all packaged', () => {
  /* `files` is the publish boundary; a gateway module missing from it ships a
     package that cannot start. */
  const gatewayModules = [
    'src/host/gateway/server.js',
    'src/host/gateway/auth.js',
    'src/host/gateway/origin.js',
    'src/host/gateway/inner-auth.js',
    'src/host/gateway/proxy.js',
    'src/host/gateway/wsproxy.js',
    'src/host/gateway/activity.js',
    'src/host/gateway/wire.js',
  ]
  for (const relative of gatewayModules) {
    assert.ok(existsSync(path.join(repoRoot, relative)), `missing gateway module: ${relative}`)
    assert.ok(pkg.files.includes(relative), `${relative} must be listed in files`)
  }
})

test('every host source is syntax-checked by check:syntax', () => {
  /* A module added without being wired into the script is a module whose syntax
     error is only discovered at load time. The script enumerates files explicitly
     (not a glob), so this is the assertion that keeps the list honest. */
  for (const relative of hostSources()) {
    assert.ok(
      pkg.scripts['check:syntax'].includes(relative),
      `${relative} is missing from check:syntax`,
    )
  }
})

test('the gateway never logs or transmits inner credential material', () => {
  /* The security red line (`design.md` §4.4): the `dsh-auth-*` cookie is
     equivalent to full access to the instance. It may exist only on the
     gateway → upstream hop. A log call or a response header carrying it would hand
     it to anyone who can read the host log or the client. */
  for (const relative of hostSources()) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8')
    /* Any log line interpolating a value named like the inner credential. */
    assert.ok(
      !/(emit|logger\.\w+)\([^)]*\$\{[^}]*(innerCookie|cookieValue|inner)\b/i.test(source),
      `${relative} appears to interpolate credential material into a log line`,
    )
  }

  /* `proxy.js` must filter the upstream `set-cookie`, and `inner-auth.js` must
     filter the client's outbound one. Both directions, or the credential leaks at
     one hop or the other. */
  const proxy = readFileSync(path.join(repoRoot, 'src/host/gateway/proxy.js'), 'utf8')
  assert.match(proxy, /carriesInnerCookie/, 'the proxy must filter upstream set-cookie')

  const innerAuth = readFileSync(path.join(repoRoot, 'src/host/gateway/inner-auth.js'), 'utf8')
  assert.match(innerAuth, /startsWith\(COOKIE_PREFIX\)/, 'outbound client cookies must be filtered')
})

test('the host half stores no plaintext token field', () => {
  const source = readFileSync(path.join(repoRoot, 'src/host/store.js'), 'utf8')
  assert.ok(!/\btoken\s*:/.test(source), 'the store must only deal in tokenHash')
  assert.ok(/tokenHash/.test(source))
})

test('the client half is one __ModuleLoader__ entry with no top-level import/export', () => {
  /* The browser half is a plain script wrapped in window.__ModuleLoader__.load:
     dependencies arrive through the factory's `require`, never through a module
     import. A top-level `import` would still pass `node --check` (it is valid
     ESM) while breaking the loader contract, so it needs this assertion rather
     than a syntax check. See .trellis/spec/frontend/quality-guidelines.md. */
  const source = readFileSync(path.join(repoRoot, 'src/client.js'), 'utf8')
  const entries = source.match(/__ModuleLoader__\.load\(/g) ?? []
  assert.equal(entries.length, 1, 'exactly one ModuleLoader entry is allowed')
  assert.ok(!/^\s*import\s/m.test(source), 'src/client.js must not use top-level import')
  assert.ok(!/^\s*export\s/m.test(source), 'src/client.js must not use top-level export')
  assert.match(source, /id:\s*'@misaka10091\/dsh-remote-control'/)
})

test('the client half depends only on modules the host baseline can provide', () => {
  /* Every `require('x')` in the browser half must name a module the host loads
     into the plugin's module table. A typo here fails at boot in the browser,
     where the test suite cannot see it. */
  const source = readFileSync(path.join(repoRoot, 'src/client.js'), 'utf8')
  const baseline = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ])
  const required = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  for (const name of required) {
    assert.ok(baseline.has(name), `src/client.js requires ${name}, which is outside the client baseline`)
  }
})
