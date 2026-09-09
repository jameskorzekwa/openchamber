# Validated fork channel CI

The fork keeps two permanent branches with different jobs:

- `main` is an exact, fast-forward-only mirror of `openchamber/openchamber:main`.
- `j2k/current` is the latest validated customization series.

Set the fork's default branch to `j2k/current`. GitHub runs scheduled workflows only
from the default branch, so this setting lets the custom sync workflow run
without adding fork-only commits to `main`.

Bootstrap this once after committing Phase 2: create remote `j2k/current` at the
committed Phase 2 tip that contains these workflow, tooling, and documentation
files. Then change the fork's default branch to `j2k/current`. Never point the bootstrap
branch at the earlier Phase 1 tip, because GitHub accepts scheduled and manual
workflow events only for files already on the default branch.

## Workflows

### J2K Sync Upstream

`.github/workflows/sync-upstream.yml` runs at minute 17 every hour and by
manual dispatch. Upstream cannot signal a fork, so polling is the only way the
mirror and the patch series advance. Ref writes and recovery issues use the
owner's `UPSTREAM_SYNC_TOKEN`; validation dispatch uses the default
`GITHUB_TOKEN` with `actions: write`.

The workflow:

1. Fetches upstream `main` and release tags.
2. Pushes upstream `main` to fork `main` only when the update is a fast-forward.
3. Rebases the current series onto the newest stable upstream release tag.
4. Pushes a new `j2k/vX.Y.Z` branch without replacing an existing branch.
5. Dispatches `J2K Validate` for a clean rebase.

If `main` has diverged, the workflow opens a mirror-divergence issue and stops.
It never force-pushes `main`. Divergence has exactly one cause: something was
merged into `main` directly. Every pull request in this fork targets
`j2k/current`; a change merged to `main` is not released, breaks the sync, and
must be ported. OPM is configured with `defaultBranch: j2k/current` for this
repository and refuses to merge a change whose base is any other branch. If the series conflicts, it pushes a recovery
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

`.github/workflows/validate.yml` runs for pushes to `j2k/current` and `j2k/**`, pull
requests targeting `j2k/current`, and manual dispatches. It has `contents: read` only
and cancels superseded validation for the same ref.

The Ubuntu x86_64 job pins Bun 1.3.14 and Node 22.22.0, requires Node modules
ABI 127, then runs:

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

Validation and release packaging have native gates for both supported web
targets. The Ubuntu x86_64 gate builds the Linux x64 ABI 127 archive on Ubuntu,
checks native `.node` files and helper executables as x86-64 ELF, spawns a
bounded shell through extracted `node-pty`, and resolves the Linux x64
`sherpa-onnx-node` binding without loading a model. The Darwin arm64 gate builds
the Darwin arm64 ABI 127 archive on macOS and requires native `.node` and
`.dylib` files to be arm64 Mach-O. It also runs the bounded `node-pty` and
`sherpa-onnx-node` smoke. Each job starts its extracted archive with the same
pinned Node runtime used to package that target.

This isolated smoke sets `OPENCODE_HOST` to its local stub and
`OPENCODE_SKIP_START=true`. It proves that the packaged server boots in external
OpenCode mode without spawning OpenCode. It also compares the packaged CLI,
agent-tool runtime, OPM status routes, and session-goal runtime byte-for-byte
with the reviewed source. The stub does not emulate the OpenCode API or plugin
protocol. These gates therefore do not claim compatibility with a separately
deployed OpenCode process, live plugin registration or execution, OPM
supervision, or automatic goal/effect processing. Those remain host-activation
checks and are not part of artifact publication.

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
dispatched validation of either `j2k/current` or `j2k/vX.Y.Z`. A pull request
merged to `j2k/current` therefore releases on its own: validation runs for the
merge commit, and its success starts a `vX.Y.Z-j2k.N` release whose base is the
newest stable upstream tag in that commit's ancestry. It can also be dispatched
manually with either branch name. Pull-request validation cannot start a
release, and release-created ref updates use `GITHUB_TOKEN`, so they do not
recursively start another workflow.

Manual dispatch fails closed unless GitHub reports both `github.ref` as
`refs/heads/j2k/current` and `github.workflow_ref` as this repository's
`.github/workflows/release.yml@refs/heads/j2k/current`. The write-permission job repeats
that immutable-context check directly in its job-level condition. A workflow
definition run from a candidate branch therefore cannot reach `contents: write`
by changing an output from an earlier unprivileged job.

A validated ordinary patch commit on long-lived `j2k/current` uses the newest stable
upstream tag in its ancestry and creates the next `vX.Y.Z-j2k.N` revision. A
validated `j2k/vX.Y.Z` branch retains the automatic upstream-version flow and
advances `j2k/current` only during publication. In both cases, metadata verifies that
the validated SHA is still the exact remote branch tip before packaging or
publishing.

The release pipeline resolves the branch tip to one 40-character source commit,
checks that `vX.Y.Z` is its ancestor, and confirms that the package version is
`X.Y.Z`. It calculates the next unused `j2k.N` revision. Native Ubuntu x86_64
and macOS arm64 jobs build and smoke their own frozen dependency closures for
the staged version. Both fail closed unless Node 22.22.0 reports modules ABI
127 and the expected platform and architecture. A package built on one target
is never relabeled for another target.

Only the downstream publish job receives `contents: write`. It does not check
out candidate source or execute candidate tooling. It checks out the verifier
at `github.workflow_sha` into a separate trusted directory with persisted
credentials disabled. Before `GH_TOKEN` reaches publication, that verifier
checks the schema 1 stable output, both native archives, the assembled schema 2
companion, checksums, archive limits and paths, dependency closures, package
identities, version, tags, and source commit.

Before publishing, the workflow verifies that the source branch and prior
`j2k/current` head have not moved. It replaces rebased `j2k/current` history only with an exact
prior-head `--force-with-lease`. An absent branch uses the explicit creation
lease `--force-with-lease=refs/heads/j2k/current:`. The branch update and new annotated
tag are one atomic Git push.

The same atomic push includes a no-op update of `SOURCE_REF` back to the exact
validated `SOURCE_COMMIT`, protected by an exact source-ref lease. Movement or
deletion of the source branch makes the whole atomic transaction fail instead
of recreating or rewinding it. The workflow repeats this leased no-op
immediately before changing a draft release to published, so source movement
during asset upload leaves the release draft and unpublished.

If a tag already points to the same source commit, a retry resumes that exact
identity instead of allocating `N+1`. Publication creates drafts, uploads only
absent assets, byte-compares every existing asset, and publishes only after
each exact inventory is complete. A different tag target, release source,
unexpected asset, missing asset on a published release, or same-named asset
with different bytes stops the run. Published releases are verified and left
unchanged. Tags and assets are never replaced.

The trusted publisher preserves this order:

1. Publish and re-read the target-qualified `web-vX.Y.Z-j2k.N` companion
   prerelease.
2. Publish and re-read the separate signed Desktop prerelease, then advance the
   separately leased desktop channel.
3. Publish the canonical, non-prerelease `vX.Y.Z-j2k.N` release and mark it
   latest only after the companion and Desktop deliveries are complete.

The canonical stable release is the final visibility point. GitHub's latest
release API cannot expose it before the matching companion exists. Desktop
signed delivery remains a separate prerelease, signing flow, artifact set,
channel, and updater even though its successful publication gates the stable
release.

The canonical stable release remains schema 1 with exactly these three assets:

- `openchamber-web-X.Y.Z-j2k.N.tgz`
- `SHA256SUMS`
- `channel.json`

Its archive remains Darwin arm64 ABI 127. The schema 2 companion prerelease has
exactly these four assets:

- `openchamber-web-X.Y.Z-j2k.N-darwin-arm64-abi127.tgz`
- `openchamber-web-X.Y.Z-j2k.N-linux-x64-abi127.tgz`
- `SHA256SUMS`
- `channel.json`

The web channel does not publish to npm and does not use npm, Apple, VS Code,
or other repository secrets. CI pins Bun 1.3.14, Node 22.22.0, and npm 11.6.2.
Web companion assets never enter the Desktop release.

## Manifest contract

The canonical `vVERSION` `channel.json` continues to use schema 1. The release
tool rejects missing or extra keys. It binds the base version, channel revision,
full version, release tag, upstream tag, source commit, tarball, checksum,
complete asset list, and minimum Node major. `seriesHead` and `sourceCommit`
must be the same 40-character commit. Its target remains `platform: "darwin"`,
`arch: "arm64"`, and `nodeAbi: "127"`.

The `web-vVERSION` companion `channel.json` uses schema 2. Its ordered
`artifacts` array contains exactly one Darwin arm64 ABI 127 entry and one Linux
x64 ABI 127 entry. Each has exactly `platform`, `arch`, `nodeAbi`, `tarball`,
and `sha256`; archive names contain the target identity. The top-level `assets`
array contains both target-qualified tarballs in deterministic order followed
by `SHA256SUMS` and `channel.json`. `SHA256SUMS` has exactly one ordered line per
tarball.

New consumers first resolve and validate GitHub's canonical latest stable
`vVERSION`, including its upstream ancestry and exact three-asset inventory.
They then resolve exact tag `web-vVERSION`, require its common identity to equal
the stable release, and select exactly one artifact matching the running
platform, architecture, and Node ABI. If the companion is absent, a consumer
may use schema 1 only for an exact Darwin arm64 ABI 127 runtime. Missing,
duplicate, ambiguous, malformed, or wrong-target companion entries fail closed
before checksum or archive download. Linux never falls back to Darwin.

The staged `package/package.json` contains an `openchamberArtifact` object with
exactly the same `platform`, `arch`, and `nodeAbi` strings. The trusted verifier
rejects missing or extra target keys, manifest/package disagreement, a smoke
runtime with another target, and bundled dependencies whose `os` or `cpu`
metadata excludes the selected native target.

Base versions use canonical `X.Y.Z` decimal components with no leading zero
unless the component is exactly zero. Channel revisions are normalized positive
safe integers with no leading zero. The generated version must equal
`baseVersion + "-j2k." + channelRevision` exactly.

The release workflow recalculates every checksum before updating refs and
verifies each final GitHub Release's exact asset names and byte sizes.

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
