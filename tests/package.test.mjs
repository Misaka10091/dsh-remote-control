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
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Read and parse a repo-root file. */
function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

const pkg = readJson('package.json')
const manifest = readJson('dsh.plugin.json')

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
  const sources = ['src/index.js', 'src/host/store.js', 'src/host/pairing.js', 'src/host/tokens.js']
  for (const relative of sources) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8')
    assert.ok(!/shell\s*:\s*true/.test(source), `${relative} must not use shell: true`)
    assert.ok(!/\bexecSync\b|\bexec\(/.test(source), `${relative} must not execute external commands`)
    assert.ok(!/node:child_process/.test(source), `${relative} must not import node:child_process`)
  }
})

test('the host half logs through ctx.logger, never console', () => {
  for (const relative of ['src/index.js']) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8')
    assert.ok(!/console\.(log|info|warn|error|debug)\(/.test(source), `${relative} must not log to the console`)
  }
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
