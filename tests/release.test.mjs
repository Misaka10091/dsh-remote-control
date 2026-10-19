/**
 * Release gate (`scripts/prepare-release.mjs`).
 *
 * The script is a pure function of its four inputs, so every release mistake it
 * exists to catch is testable here without touching npm, git or the network. That
 * is the whole point of putting the validations in a unit-testable module: a
 * workflow YAML cannot be unit-tested, so a check written inside it is a check
 * nobody can prove works.
 *
 * The `--profile web` case is the one addition over the reference implementation
 * (`dsh-git-panel`): that package installs with `--profile desktop`, and copying
 * its release notes verbatim would publish an install command that this project's
 * README explicitly says cannot work.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { prepareRelease } from '../scripts/prepare-release.mjs'

const PACKAGE = '@misaka10091/dsh-remote-control'

function input(version = '0.1.0') {
  return {
    tag: `v${version}`,
    pkg: { name: PACKAGE, version, repository: { url: `git+https://github.com/Misaka10091/dsh-remote-control.git` } },
    manifest: { version },
    changelog: `# Changelog\n\n## v${version} — 2026-10-17\n\n- Current changes.\n\n## v0.0.9 — 2026-10-01\n\n- Older changes.\n`,
  }
}

test('stable release uses latest and excludes other published versions', () => {
  const release = prepareRelease(input())
  assert.equal(release.dist_tag, 'latest')
  assert.equal(release.prerelease, false)
  assert.equal(release.package, PACKAGE)
  assert.equal(release.version, '0.1.0')
  assert.equal(release.tag, 'v0.1.0')
  assert.match(release.notes, /Current changes/)
  assert.doesNotMatch(release.notes, /Older changes/)
  assert.match(release.notes, /@misaka10091\/dsh-remote-control@0\.1\.0/)
})

test('prerelease uses next without promoting to latest', () => {
  const release = prepareRelease(input('0.2.0-beta.1'))
  assert.equal(release.dist_tag, 'next')
  assert.equal(release.prerelease, true)
  assert.equal(release.version, '0.2.0-beta.1')
})

test('the release notes install with the web profile, never desktop', () => {
  /* `README.md` "Install": the `desktop` profile is managed by the Electron app and
     rejects CLI plugin commands. A release note copied from the sibling package
     would tell every user to run a command that fails. */
  for (const version of ['0.1.0', '0.2.0-beta.1']) {
    const { notes } = prepareRelease(input(version))
    assert.match(notes, new RegExp(`dsh plugin --profile web add ${PACKAGE.replace(/[/@]/g, (c) => `\\${c}`)}@${version.replace(/\./g, '\\.')}`))
    assert.doesNotMatch(notes, /--profile desktop/)
  }
})

test('invalid tags and tag/version mismatches stop publication', () => {
  /* The reason is pinned, not just "something threw": `v0.1.1` and
     `v0.1.0+build` would also be refused by the manifest comparison, so a bare
     `assert.throws` keeps passing with the tag-grammar rule deleted. Every case
     has to fail for the rule it is here to prove. */
  for (const tag of ['main', 'v01.1.0', 'v0.1', 'v0.1.0+build']) {
    assert.throws(() => prepareRelease({ ...input(), tag }), /Release tag must be vX\.Y\.Z/)
  }
  assert.throws(() => prepareRelease({ ...input(), tag: 'v0.1.1' }), /Tag and package\.json version must agree/)
  assert.throws(() => prepareRelease({ ...input(), manifest: { version: '0.1.1' } }), /dsh\.plugin\.json/)
})

test('a numeric prerelease identifier may not carry a leading zero', () => {
  /* Tag and both manifests agree in these inputs, so the leading-zero rule is
     the only one that can refuse them. Routing `v0.1.0-beta.01` through the
     version-mismatch path instead — as the reference implementation's test did —
     passes even with the rule deleted. */
  for (const version of ['1.2.3-beta.01', '1.2.3-01', '1.2.3-rc.01.1']) {
    assert.throws(() => prepareRelease(input(version)), /leading zeros/)
  }
  assert.equal(prepareRelease(input('1.2.3-beta.2')).dist_tag, 'next')
})

test('wrong package identity or repository stops publication', () => {
  const data = input()
  assert.throws(() => prepareRelease({ ...data, pkg: { ...data.pkg, name: 'dsh-remote-control' } }), /package name/)
  assert.throws(() => prepareRelease({ ...data, pkg: { ...data.pkg, repository: undefined } }), /repository\.url/)
  assert.throws(
    () => prepareRelease({ ...data, pkg: { ...data.pkg, repository: { url: 'git+https://github.com/Misaka10091/dsh-git-panel.git' } } }),
    /repository\.url/,
  )
})

test('missing or empty changelog stops publication', () => {
  assert.throws(() => prepareRelease({ ...input(), changelog: '## v0.1.1 — 2026-10-17\n- Other.' }), /needs a section/)
  assert.throws(() => prepareRelease({ ...input(), changelog: '## v0.1.0 — 2026-10-17\n\n## v0.0.9 — 2026-10-01\n- Older.' }), /must not be empty/)
})
