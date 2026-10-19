# Releasing

This package is published to npm as `@misaka10091/dsh-remote-control`.

## Before tagging

1. **Bump both versions.** `package.json` and `dsh.plugin.json` must carry the
   same `version`; a test (`tests/package.test.mjs`) fails if they drift, and it
   also verifies every path in `files` exists.

2. **Check the engine floor against the host you actually ran.** Read
   `dsh --version` rather than inferring from another package:

   ```bash
   dsh --version
   ```

   `engines.dsh` in both manifests must match. (This was gotten wrong once by
   inferring from a bundle version.)

3. **Run the full gate:**

   ```bash
   npm test              # 479 tests, no network, no real ports
   npm run check:syntax  # node --check over every host module
   npm pack --dry-run    # confirm the file list
   ```

   All three must pass. A failing test is a release blocker, never something to
   adjust the assertion around.

4. **Read the tarball list** from `npm pack --dry-run`. Anything you expect and
   do not see is a packaging bug; anything you did not expect is a leak.

## Tagging and publishing

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Then publish from the tag:

```bash
npm publish --access public
```

## After publishing

- Verify `npm view @misaka10091/dsh-remote-control version` reports the new
  version and that `latest` points at it.
- Add the `CHANGELOG.md` entry **before** tagging, not after — the tag should
  describe what shipped.

## Installing a local build

To try a checkout before releasing:

```bash
dsh plugin --profile web add "link:/absolute/path/to/dsh-remote-control"
```

The `desktop` profile is managed by the Electron app and rejects CLI plugin
commands; use a CLI profile (`web`) for install verification.

## What a release must NOT claim

The README states plainly that the stage-6 real-device run has not happened.
That statement stays until someone actually completes the chain on a phone:
scan → open session → send message → receive stream → stop. Node-level tests over
real sockets are not a substitute, and the changelog should not imply otherwise.
