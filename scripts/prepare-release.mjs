/**
 * Release gate.
 *
 * Everything that can be wrong about a release *before* `npm publish` runs is
 * checked here, in a pure function, so it is unit-testable and can be dry-run
 * locally against the real repository files (`node scripts/prepare-release.mjs
 * vX.Y.Z <dir>`). The workflow only orchestrates; it does not judge.
 *
 * The validations, in order — the first failure stops the release:
 *
 * 1. The tag is `vX.Y.Z` or `vX.Y.Z-prerelease`, with no build metadata.
 * 2. Pre-release numeric identifiers carry no leading zero (`beta.01` is invalid).
 * 3. `package.json` names this package (a wrong repo publishes the wrong thing).
 * 4. `package.json#version` equals the tag.
 * 5. `dsh.plugin.json#version` equals the tag.
 * 6. `repository.url` identifies this repository, because npm provenance binds the
 *    published artifact to the repository it was built from — a wrong URL means
 *    provenance points somewhere else.
 * 7. `CHANGELOG.md` has a non-empty `## <tag> — ` section, which becomes the
 *    GitHub Release body.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repository = 'https://github.com/Misaka10091/dsh-remote-control'

/**
 * Validate one release and build the artifacts describing it.
 *
 * @param {object} input
 * @param {string} input.tag Git tag, e.g. `v0.1.0`.
 * @param {object} input.pkg Parsed `package.json`.
 * @param {object} input.manifest Parsed `dsh.plugin.json`.
 * @param {string} input.changelog Raw `CHANGELOG.md`.
 * @returns {{ package: string, version: string, tag: string, dist_tag: string, prerelease: boolean, notes: string }}
 */
export function prepareRelease({ tag, pkg, manifest, changelog }) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/.exec(tag)
  assert.ok(match, 'Release tag must be vX.Y.Z or vX.Y.Z-prerelease (no build metadata).')
  const [, version, prerelease] = match
  if (prerelease) {
    assert.ok(prerelease.split('.').every((id) => !/^\d+$/.test(id) || !/^0\d/.test(id)), 'Numeric prerelease identifiers must not have leading zeros.')
  }
  assert.equal(pkg.name, '@misaka10091/dsh-remote-control', 'Unexpected npm package name.')
  assert.equal(pkg.version, version, 'Tag and package.json version must agree.')
  assert.equal(manifest.version, version, 'Tag and dsh.plugin.json version must agree.')
  assert.equal(pkg.repository?.url, `git+${repository}.git`, 'repository.url must identify this project for npm provenance.')

  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith(`## ${tag} — `))
  assert.ok(start >= 0, `CHANGELOG.md needs a section for ${tag}.`)
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  const body = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim()
  assert.ok(body, 'The release changelog section must not be empty.')
  /* `--profile web`, not `desktop`: the desktop profile is managed by the Electron
     app and rejects CLI plugin commands (README "Install"). */
  const notes = `${body}\n\n### Installation\n\n\`\`\`sh\ndsh plugin --profile web add ${pkg.name}@${version}\n\`\`\`\n\nThe attached .tgz is the same package published to npm.\n`
  return {
    package: pkg.name,
    version,
    tag,
    dist_tag: prerelease ? 'next' : 'latest',
    prerelease: Boolean(prerelease),
    notes,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [tag, outputDirectory] = process.argv.slice(2)
  assert.ok(outputDirectory, 'Usage: node scripts/prepare-release.mjs vX.Y.Z <output-directory>')
  const result = prepareRelease({
    tag,
    pkg: JSON.parse(fs.readFileSync('package.json', 'utf8')),
    manifest: JSON.parse(fs.readFileSync('dsh.plugin.json', 'utf8')),
    changelog: fs.readFileSync('CHANGELOG.md', 'utf8'),
  })
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, 'notes.md'), result.notes)
  fs.writeFileSync(path.join(outputDirectory, 'metadata.json'), JSON.stringify(result, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) {
    for (const key of ['package', 'version', 'dist_tag', 'prerelease']) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${result[key]}\n`)
    }
  }
  console.log(`Validated ${result.package}@${result.version} (${result.dist_tag}); release notes ready.`)
}
