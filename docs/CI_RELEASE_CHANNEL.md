# Validated fork channel CI

The fork keeps two permanent branches with different jobs:

- `main` is an exact, fast-forward-only mirror of `openchamber/openchamber:main`.
- `j2k` is the latest validated customization series.

Set the fork's default branch to `j2k`. GitHub runs scheduled workflows only
from the default branch, so this setting lets the custom sync workflow run
without adding fork-only commits to `main`.

Bootstrap this once after committing Phase 2: create remote `j2k` at the
committed Phase 2 tip that contains these workflow, tooling, and documentation
files. Then change the fork's default branch to `j2k`. Never point the bootstrap
branch at the earlier Phase 1 tip, because GitHub accepts scheduled and manual
workflow events only for files already on the default branch.

## Workflows

### J2K Sync Upstream

`.github/workflows/sync-upstream.yml` runs at minute 17 every six hours and by
manual dispatch. It uses the default `GITHUB_TOKEN` with `actions: write`,
`contents: write`, and `issues: write`.

The workflow:

1. Fetches upstream `main` and release tags.
2. Pushes upstream `main` to fork `main` only when the update is a fast-forward.
3. Rebases the current series onto the newest stable upstream release tag.
4. Pushes a new `j2k/vX.Y.Z` branch without replacing an existing branch.
5. Dispatches `J2K Validate` for a clean rebase.

If `main` has diverged, the workflow opens a mirror-divergence issue and stops.
It never force-pushes `main`. If the series conflicts, it pushes a recovery
branch at the pre-rebase series head, opens `Rebase conflict: patch series vs
vX.Y.Z`, and stops without publishing.

Resolve a conflict branch locally by rebasing it onto the issue's upstream tag,
then push the resolved branch. Do not rewrite `main`. A push to `j2k/vX.Y.Z`
runs validation.

If a release branch already exists at a commit based on the expected upstream
tag, sync inspects validation runs for that exact SHA. It does not duplicate an
active run or a successful run. A missing, failed, or cancelled run is
redispatched. Branches that are not descendants of the named upstream tag are
left for manual conflict resolution.

### J2K Validate

`.github/workflows/validate.yml` runs for pushes to `j2k` and `j2k/**`, pull
requests targeting `j2k`, and manual dispatches. It has `contents: read` only
and cancels superseded validation for the same ref.

The Ubuntu job pins Bun 1.3.14 and Node 22, then runs:

```bash
bun install --frozen-lockfile
bun run type-check
bun run lint
bun run test
bun run build
```

It stages `packages/web` plus the complete recursive production dependency
closure resolved from the frozen Bun installation. Every dependency is copied
as real files and directories under `package/node_modules`; `.bin` symlinks are
omitted. The deterministic gzip-compressed tar contains one `package/` root and
uses only regular files, directories, and bounded path-only PAX metadata.

The boot smoke test validates and extracts the tarball without npm installation,
changes its working directory to the extracted package, and starts the CLI with
registry access disabled. A local stub supplies the only OpenCode connection.
The test requires healthy `/health` and `/api/version` identities, the exact
source commit in `dist/build-revision.json`, a served `index.html`, and HTTP 200
for every referenced built asset.

The Darwin arm64 release smoke also checks selected `.node` and `.dylib` files
with both `file` and `lipo`, requiring exactly arm64 Mach-O output. It spawns a
bounded `/bin/sh` command through extracted `node-pty` and loads
`sherpa-onnx-node` far enough to resolve its Darwin arm64 binding and linked
libraries without loading a model.

Finally, the release smoke proves the configured update channel. It first
requires an unauthenticated `/api/openchamber/update-check` request to return
401, logs in through `/auth/session` using a local-only smoke password, and
calls the real strict `jameskorzekwa/openchamber` channel. GitHub access is
bounded to 75 seconds and fails closed. The response must be exactly one of the
runtime's no-release, older-base no-release, current, or available shapes, with
the expected channel repository and consistent persisted installation state.

The job uploads the `.tgz` as `validated-web-<commit>` for seven days. This is a
CI diagnostic artifact, not a release asset. Failed validation on an automatic
`j2k/vX.Y.Z` branch creates or updates one `Validation failed: j2k/vX.Y.Z`
issue. A later successful run closes it. Repeated failures update the same issue
with the exact failed SHA and run URL.

### J2K Release

`.github/workflows/release.yml` starts after successful push or manually
dispatched validation of either `j2k` or `j2k/vX.Y.Z`. It can also be dispatched
manually with either branch name. Pull-request validation cannot start a
release, and release-created ref updates use `GITHUB_TOKEN`, so they do not
recursively start another workflow.

Manual dispatch fails closed unless GitHub reports both `github.ref` as
`refs/heads/j2k` and `github.workflow_ref` as this repository's
`.github/workflows/release.yml@refs/heads/j2k`. The write-permission job repeats
that immutable-context check directly in its job-level condition. A workflow
definition run from a candidate branch therefore cannot reach `contents: write`
by changing an output from an earlier unprivileged job.

A validated ordinary patch commit on long-lived `j2k` uses the newest stable
upstream tag in its ancestry and creates the next `vX.Y.Z-j2k.N` revision. A
validated `j2k/vX.Y.Z` branch retains the automatic upstream-version flow and
advances `j2k` only during publication. In both cases, metadata verifies that
the validated SHA is still the exact remote branch tip before packaging or
publishing.

The release pipeline resolves the branch tip to one 40-character source commit,
checks that `vX.Y.Z` is its ancestor, and confirms that the package version is
`X.Y.Z`. It calculates the next unused `j2k.N` revision. The validation job then
reruns typechecks, lint, tests, build, packaging, identity validation, and the
installed-package smoke test for the staged `X.Y.Z-j2k.N` version.

Release packaging runs on a GitHub-hosted arm64 macOS runner so the frozen
optional native dependency closure matches the arm64 Mac mini runtime. The
runner fails closed unless the exact pinned production Node reports platform
`darwin` and architecture `arm64`. It records that Node runtime's
`process.versions.modules` value as the target ABI and uses the same Node
executable for extracted-package startup.

Only the downstream publish job receives `contents: write`. It does not check
out candidate source or execute candidate tooling. It checks out the verifier
at `github.workflow_sha` into a separate trusted directory with persisted
credentials disabled. That verifier rechecks the manifest, checksum, compressed
and expanded sizes, entry and file limits, archive types and paths, dependency
closure, package identity, version, tag, and source commit before `GH_TOKEN` is
made available to the publication step.

Before publishing, the workflow verifies that the source branch and prior
`j2k` head have not moved. It replaces rebased `j2k` history only with an exact
prior-head `--force-with-lease`. An absent branch uses the explicit creation
lease `--force-with-lease=refs/heads/j2k:`. The branch update and new annotated
tag are one atomic Git push.

The same atomic push includes a no-op update of `SOURCE_REF` back to the exact
validated `SOURCE_COMMIT`, protected by an exact source-ref lease. Movement or
deletion of the source branch makes the whole atomic transaction fail instead
of recreating or rewinding it. The workflow repeats this leased no-op
immediately before changing a draft release to published, so source movement
during asset upload leaves the release draft and unpublished.

If the tag already points to the same source commit, a retry resumes that exact
`vX.Y.Z-j2k.N` identity instead of allocating `N+1`. Publication creates a draft
release, uploads only absent assets, byte-compares every existing asset, and
publishes only after the exact three-file inventory is complete. A different
tag target, release source, unexpected asset, or same-named asset with different
bytes stops the run. A completed published release is verified and left
unchanged.

The workflow refuses to replace an existing tag or release. It creates one
non-draft, non-prerelease GitHub Release with exactly these immutable assets:

- `openchamber-web-X.Y.Z-j2k.N.tgz`
- `SHA256SUMS`
- `channel.json`

It does not publish to npm and does not use npm, Apple, VS Code, or other
repository secrets. CI pins Bun 1.3.14, Node 22.22.0, and npm 11.6.2.

## Manifest contract

`channel.json` uses schema 1. The release tool rejects missing or extra keys.
It binds the base version, channel revision, full version, release tag, upstream
tag, exact source commit, tarball name, checksum, checksum asset name, manifest
asset name, complete asset list, and minimum Node major version. `seriesHead`
and `sourceCommit` must be the same 40-character commit. The exact additional
target fields are string values `platform: "darwin"`, `arch: "arm64"`, and
`nodeAbi: "127"`, obtained from `process.versions.modules` under the pinned
Node 22.22.0 production runtime.

The staged `package/package.json` contains an `openchamberArtifact` object with
exactly the same `platform`, `arch`, and `nodeAbi` strings. The trusted verifier
rejects missing or extra target keys, manifest/package disagreement, a smoke
runtime with another target, and bundled dependencies whose `os` or `cpu`
metadata excludes Darwin arm64.

Base versions use canonical `X.Y.Z` decimal components with no leading zero
unless the component is exactly zero. Channel revisions are normalized positive
safe integers with no leading zero. The generated version must equal
`baseVersion + "-j2k." + channelRevision` exactly.

`SHA256SUMS` contains exactly one line for the tarball. The release workflow
recalculates it before updating refs and verifies the final GitHub Release asset
names and exact byte sizes.

The tarball contract is capped at 256 MiB compressed, 512 MiB expanded, 50,000
tar entries, and 128 MiB per regular file. PAX and GNU path metadata is capped
at 64 KiB; PAX accepts only one `path` record. Traversal, duplicate paths,
symlinks, hardlinks, devices, FIFOs, base-256 numbers, malformed headers, and
nonzero trailing data are rejected. Required content is `package/package.json`,
`package/bin/cli.js`, `package/server/index.js`, `package/dist/index.html`,
`package/dist/build-revision.json`, and `package/node_modules/`.
File and directory paths share one canonical identity, so entries such as
`package/x` and `package/x/` are duplicates and fail validation.

## Local release-tool checks

The deterministic identity and archive checks require Node:

```bash
node --test tools/channel-release/channel-release.test.mjs
node --test tools/channel-release/artifact.test.mjs
node --test tools/channel-release/smoke-contract.test.mjs
node --test tools/channel-release/workflow-contract.test.mjs
node --check tools/channel-release/artifact.mjs
node --check tools/channel-release/channel-release.mjs
node --check tools/channel-release/smoke-installed-package.mjs
```

The full extracted-package smoke test requires a built `packages/web` tree and
a prior frozen-lockfile install. It performs no package installation or registry
access after the tarball is created.
