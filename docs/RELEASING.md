# Releasing

Repository: <https://github.com/Misaka10091/dsh-remote-control>. npm package:
`@misaka10091/dsh-remote-control`.

## Read this first: `0.1.0` must be published by hand

`@misaka10091/dsh-remote-control` **is not on npm yet** (checked 2026-10-19:
`npm view` returns `E404`). npm Trusted Publisher can only be configured from the
Settings page of a package that already exists, so the automation cannot perform
the first publish. Continuing in the wrong order gets stuck at "package does not
exist → cannot configure Trusted Publisher".

```
0.1.0 (first release)  →  publish by hand, interactively, with 2FA
        ↓  the package now exists on npm
one-time configuration  →  npm Settings → Trusted Publisher → GitHub Actions
        ↓
0.1.1 and later         →  push tag vX.Y.Z; npm-publish.yml does the rest
```

Never publish the same version twice through both routes: npm refuses to overwrite
a published version, and the "identical content" branch below only exists to let a
*retry* finish a release that already reached npm.

## One-time: publish `0.1.0` by hand

Manual publishing needs two-factor authentication enabled on the npm account, or a
granular access token with bypass-2FA permission. This project's first release uses
interactive login plus 2FA: on npmjs.com go to Account → Two-Factor
Authentication → Enable 2FA, add a security key or passkey (Windows Hello works),
and save the recovery codes. If a publish fails with
`E403 ... Two-factor authentication ... is required`, finish the account
configuration and re-run `npm login --auth-type=web`. Official steps:
<https://docs.npmjs.com/configuring-two-factor-authentication/>.

Run the same gate the workflows run, then publish from the tagged commit:

```bash
npm test
npm run check:syntax
npm pack --dry-run

git tag -a v0.1.0 -m "Release v0.1.0"
git push --atomic origin main v0.1.0

npm publish --access public     # interactive, 2FA
```

Then confirm it is public:

```bash
npm view @misaka10091/dsh-remote-control@0.1.0 version --prefer-online --registry=https://registry.npmjs.org
```

If staged publishing is in play, a successful upload only means "staged": when the
package page shows **Temporary Holding Version / `0.0.0-stage`**, the maintainer
must open **Staged Packages** on npm, check the real version and click **Approve**
(2FA required) before it is public. That state is not a registry sync delay and not
a manual npm review. Official note: <https://docs.npmjs.com/staged-publishing/>.

## One-time: configure npm Trusted Publisher

`misaka10091` must be an npm user or organization scope you can publish to; a
matching GitHub username does **not** grant the npm scope by itself.

On the npm package's Settings → Trusted Publisher, choose GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `Misaka10091` |
| Repository | `dsh-remote-control` |
| Workflow filename | `npm-publish.yml` (the filename only) |
| Environment name | leave empty (this workflow uses no environment) |
| Allow npm publish | checked — lets the workflow publish directly |
| Allow npm dist-tag | unchecked — the dist-tag is set at publish time (`--tag`), not by a separate operation |

Setting the dist-tag on `npm publish` is part of the publish operation itself;
separate dist-tag management (`npm dist-tag add`) is what the second switch grants,
and this workflow never runs it. The sibling project ships with only
`Allow npm publish` checked and its stable releases land on `latest`. If a
prerelease run is ever refused for a dist-tag reason, check
`Allow npm dist-tag` — that changes the npm-side grant, not the workflow. npm's
advice under `Allow npm publish` prefers staged publishing with manual approval;
this project grants the named repository and workflow direct publish instead.
`npm stage publish` permission is not the same as direct publish permission.

After saving, the entry may show **Pending validation** with a deadline. It is
cleared only by that workflow really publishing a version that is **not public
yet** — re-running an already published version skips the npm upload (identical
content branch below) and therefore cannot complete the validation, and neither can
a local manual publish or `npm whoami`. Refresh the Settings page to see the state
change.

No `NPM_TOKEN` is needed and none should be added. `id-token: write` is the OIDC
credential; `contents: write` is only for creating the Release and uploading its
asset. The workflow runs on a GitHub-hosted `ubuntu-latest` runner with Node 24 and
npm 11 (Trusted Publisher requires npm >= 11.5.1 and Node >= 22.14.0). Publishing
from a public repository through Trusted Publisher produces npm provenance
automatically. Official note: <https://docs.npmjs.com/trusted-publishers/>.

## Daily release

1. **Bump both versions.** `dsh.plugin.json` is synced from `package.json` by the
   `version` lifecycle script, so a single command keeps them equal (and stages the
   manifest):

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

   `tests/package.test.mjs` fails if the two manifests drift, and it also verifies
   every path in `files` exists.

2. **Check the engine floor against the host you actually ran.** Read
   `dsh --version` rather than inferring from another package:

   ```bash
   dsh --version
   ```

   `engines.dsh` in both manifests must match. (This was gotten wrong once by
   inferring from a bundle version.)

3. **Write the `CHANGELOG.md` section first.** The heading format is
   `## vX.Y.Z — YYYY-MM-DD`, and the release notes are taken verbatim from that
   section, so the tag describes what shipped rather than what was intended. A
   tag with no matching section — or with an empty one — is refused by
   `scripts/prepare-release.mjs`.

4. **Run the full gate:**

   ```bash
   npm test              # the whole node:test suite, no network, no real ports
   npm run check:syntax  # node --check over every host module plus scripts/
   npm pack --dry-run    # confirm the file list
   ```

   All three must pass. A failing test is a release blocker, never something to
   adjust the assertion around.

5. **Read the tarball list** from `npm pack --dry-run`. Anything you expect and do
   not see is a packaging bug; anything you did not expect is a leak. The list is
   31 files; `scripts/` and `.github/` are deliberately **not** in the package.

6. **Commit, then push the tag.** Publishing is triggered by the tag, so the tag
   must point at a commit that already contains the release workflow and the
   changelog entry:

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push --atomic origin main vX.Y.Z
   ```

Pushing the tag immediately publishes to npm and creates the GitHub Release. The
order inside `npm-publish.yml` is: **tag validation → syntax check and tests → pack
once → npm publish → GitHub Release with that same `.tgz` as its asset**.

The tag must be `vX.Y.Z` or `vX.Y.Z-prerelease` (`v0.1.0+build` and `v01.1.0` are
rejected) and must equal the version in both manifests. A wrong package name, a
wrong `repository.url` (provenance binds to it), a missing changelog section or an
empty one all stop the release before `npm publish`. Stable versions publish to npm
`latest` and get a normal Release; a prerelease such as `v0.2.0-beta.1` publishes to
`next`, is marked prerelease and does not move GitHub's Latest. Publish a new
version rather than re-publishing an older one as `latest`.

## After a release

```bash
npm view @misaka10091/dsh-remote-control version
npm view @misaka10091/dsh-remote-control dist-tags
npm view @misaka10091/dsh-remote-control@X.Y.Z dist.integrity
```

- `version` reports the new version, and `latest` (or `next` for a prerelease)
  points at it.
- The GitHub Release exists, is not marked Latest for a prerelease, and the
  integrity of its `.tgz` asset equals the `dist.integrity` above — the workflow
  uploads the very tarball it published.
- Add the `CHANGELOG.md` entry **before** tagging, not after: the tag should
  describe what shipped, and the release notes are read from that section.

## CI

`.github/workflows/ci.yml` runs the same three gates on every push to `main`, on
every pull request and on demand. It uses no secrets. A tag push is therefore never
the first time the suite runs.

## Failure and retry

- **Tests or syntax fail:** the workflow stops; nothing is published.
- **npm fails:** no GitHub Release is created.
- **npm succeeded but the Release failed:** re-run the failed workflow. `npm view
  <pkg>@<version> dist.integrity` is compared with the freshly packed tarball —
  identical means the upload is skipped and the Release is created; different means
  the run aborts and the version must be bumped, because npm never overwrites a
  published version. Any error other than `E404` from `npm view` is printed and
  fails the run rather than being swallowed.
- **The GitHub Release already exists:** the same tarball is re-uploaded with
  `gh release upload --clobber`.
- **Manual restart:** Actions → npm-publish → Run workflow, picking a branch that
  contains the workflow and typing an **existing** tag. `checkout` always reads the
  commit that tag points at, not the selected branch.

## What local verification can and cannot prove

| Layer | How | Proves | Local? |
|---|---|---|---|
| 1 | `node --test tests/release.test.mjs` | The validation rules accept a good release and stop each bad one | ✅ |
| 2 | `node scripts/prepare-release.mjs vX.Y.Z <dir>` | The script runs against this repository's real manifests and changelog, and emits `notes.md` + `metadata.json` | ✅ |
| 3 | Parsing both workflow files | The YAML parses, and the triggers/permissions are what they claim | ✅ |
| 4 | A real OIDC publish plus GitHub Release | That the publish path actually works end to end | ❌ only a real tag push |

Layer 4 has **not** been run for this repository. Nothing local calls
`npm publish`, creates a remote tag or creates a GitHub Release, and a green local
dry run is not evidence that the release path works. Layers 1–3 also cannot see
npm-side account state (2FA, scope permissions, a pending Trusted Publisher
validation) — that surfaces only on a real run.

## What a release must NOT claim

The README states plainly that the stage-6 real-device run has not happened.
That statement stays until someone actually completes the chain on a phone:
scan → open session → send message → receive stream → stop. Node-level tests over
real sockets are not a substitute, and the changelog should not imply otherwise.

The same applies to this pipeline: until a real tag push has published a version
and created its Release, the docs must not describe the automation as verified.

## Installing a local build

To try a checkout before releasing:

```bash
dsh plugin --profile web add "link:/absolute/path/to/dsh-remote-control"
```

The `desktop` profile is managed by the Electron app and rejects CLI plugin
commands; use a CLI profile (`web`) for install verification. The same applies to
the install line in every Release's notes.
