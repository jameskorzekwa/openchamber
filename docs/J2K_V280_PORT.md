# J2K v2.8.0 port

## Source and history

The port starts at upstream `v2.8.0`,
`30c70496a5ca0105e04e60a783964576973edc8f`, and applies the complete fork delta
from `v2.7.0` through `7dad9febda60a752930ef7fc65cc163d1541b574`.
That source includes PRs #111 and #112, unlike the failed #109 candidate.

The intended history is a new fork patch commit directly above v2.8.0, following
the v2.7.0 consolidated-port precedent. It does not merge the old fork history
back into the new base. Upstream v2.8.0 is therefore an ancestor and the newest
upstream release base; the next upgrade replays only the new patch series.
The remote `j2k/v2.8.0` candidate has not been changed.

## Fork inventory

| Fork behavior | v2.8.0 owner / disposition |
| --- | --- |
| Validated web release selection, archive verification, rollback and restart attestation | Retained in typed `server/lib/openchamber-update` and `server/lib/self-update`; source/emitted helper launch paths have dedicated tests |
| Managed Linux/macOS launcher and strict systemd migration | Retained in typed `bin/lib/cli-startup.ts` |
| Managed CLI updates use the running server's validated channel | Retained in typed `bin/lib/commands-update.ts` |
| UI install state, no-validated-release status and reconnect revision checking | Retained update store/dialog/status helpers; combined with upstream About update banners |
| macOS J2K updater feed, prerelease policy, artifact contract and smoke tooling | Retained; non-J2K builds retain upstream Stable/Canary mirror fallback |
| Build revision asset and health/SSE identity | Retained; runtime hooks moved from `server/index.js` into `server/runtime.ts`; revision lookup uses manifest-owned package paths |
| Primary-worktree project-config write protection | Retained as typed `primary-worktree-write-guard.ts`, including agent error status/code responses |
| Background subtasks and background command output panel | Retained; composer integration moved into `composer/input/useComposerRows.tsx` |
| Distinct composer row keys / ghost-row regression | Retained in extracted composer row owner; real ChatInput regression passes |
| Background-row highlighting and shared-clock blinking (#107) | Retained alongside upstream foreground shell stop state |
| Rounded background indicator (#111) | Retained in extracted `composer/input/renderComposerForm.tsx` |
| Per-project folded archived sessions (#112) | Retained in sidebar grouping/row model; upstream search ownership retained |
| Session directory relocation | Retained alongside upstream deferred-update scheduling |
| Fork version ordering | Retained in typed `server/lib/version-order.ts` |
| Node 24 ABI 137 release validation, ripgrep packaging, Electron version verification | Retained; archive staging/verification and fork-parity smoke checks now use emitted `build/server` and `build/bin`, with the legacy `bin/cli.js` launcher preserved |
| macOS runner selection, trust-change skip, packaged smoke skip (#103/#104/#106) | Fork desktop workflow retained |
| CI test retry option and browser-test exclusions | Retained; test runner also keeps upstream `openchamber-source` condition |
| Git ownership test isolation | Replaced by upstream's more complete environment restoration and ambient config isolation |
| Fork documentation/release workflows and docs publishing | Retained; durable recovery-workflow changes belong to the separate coordinator worktree |
| Old large composer, UI store and server entrypoint | Replaced by upstream extraction; fork behavior transplanted into the new owners |

## Validation so far

Dependencies installed with pinned Bun 1.4.5 and `bun install --frozen-lockfile`
under Node 24.22.3, including project postinstall scripts.

- Background shells, background subtasks and sidebar row model: 89 passing tests.
- Real ChatInput background-row regression: 1 passing test.
- Electron updater feeds, updater contract and SemVer: 32 passing tests.
- Managed startup/update CLI, build revision and primary-worktree guard:
  34 passing tests.
- Electron main syntax check passed.
- Emitted-runtime archive, channel bundle and smoke contracts: 20 passing tests,
  including rejection of a missing emitted runtime despite legacy source entries.
- Update dialog: 5 passing tests; session-event relocation/deferred-update
  integration: 14 passing tests.
- Agent prompt/config mutation guards, managed CLI and package-manager checks:
  94 passing tests.
- Ghost-row/source-owner checks, live subtask selection, shell output, update
  status/lifecycle and revision events: 54 passing tests in isolated processes.
- Focused ordinary lint passes for the ported CLI and guard/revision modules.
  The anti-slop pass found unchanged upstream timer code in `useComposerRows`
  and the existing artifact manifest `typeof` check; those remain for the
  combined changed-code gate attribution recorded below.

The UI tests emit existing fixture warnings (React `act`, relative fetches, and
missing session-warming fixture fields). They reported zero failing tests.

This is an in-progress port, not release evidence. Combined type-check passes.
The updater review's missing-launcher finding is fixed: packages with emitted
entries but no stable launcher are rejected before release selection or restart.
Installer and Node source-entry tests pass (76 tests). Lint, build, broader
suites and runtime smoke checks passed before the cleanup phase. The cleanup
requires final combined-tree verification and rereview; browser/native-platform
runtime validation remains pending.
No release or deployment has been performed.

## Combined validation commands

### Combined recovery integration evidence

The reviewed recovery patch was applied by hunks after checking SHA256
`49be18521c4c8804c3f634b097db5f4902122554bb0385809f2af0c9937783b8`.
All 13 files applied without conflicts. The package test command adds the
recovery suite; the v2.8 package version, dependencies and other scripts remain.
Publication accepts only owner-integrated `j2k/current` and cannot promote a
candidate branch.

Validation completed before the recovery patch:

- Full type-check and ordinary lint pass.
- Root, SDK, UI, VS Code and Electron suites pass.
- Web suite passes with 701 files, 13,047 tests and 149 skipped tests.
  The test process requires installed npm/gh on PATH and `umask 022`.
- Full build passes.
- Built server, built CLI and source CLI smoke checks return HTTP 200 for
  health and diagnostics, then stop and remove isolated data.
- Installer and Node source-entry tests pass, 76 tests.

On the combined tree, recovery, channel-release and desktop-release suites
pass all 92 tests, including the 22 reviewed recovery tests.

At the initial inspection the gate was unresolved. Both the prior-fork and upstream comparisons
failed dead code, rule-count growth and file size. Independent Knip 5.80.0
execution on the prior fork reproduces both current findings:
`writeSettingsRegistrySnapshots` and the duplicate updater-feed exports.
The upstream snapshot passes Knip.

Per-file/rule scans use the current lint configuration on the combined tree
and source snapshots of both bases. The current selection includes the union
of paths changed against either base. No current per-file/rule count exceeds
both the prior-fork count and upstream count, with same-path JavaScript
predecessors included for TypeScript conversions. This establishes count
attribution only; it does not turn the required single-base gate green.

Detailed evidence is retained on bee2 under
`/srv/opencode-data/jkorzekwa/opencode/tmp/opencode/v280-gate-evidence/`:
`counts.tsv` contains file/rule/current/fork/JavaScript-predecessor/upstream
counts; the three JSON lint reports preserve locations; `fork-knip.log` and
`upstream-knip.log` preserve base reproductions; `size-attribution.tsv`
records the 13 size findings relative to upstream.

### Rereview after initial independent reviews

Post-review behavior and regression edits:

- `packages/web/server/lib/openchamber-update/validated-release-installer.ts`
  and its test require the compatibility launcher alongside emitted files.
- `packages/web/bin/lib/cli-startup.test.js` and
  `packages/web/scripts/build-server.test.mjs` verify the managed launcher
  and package fallback.
- `packages/web/server/lib/server-frame/bootstrap-runtime.test.js` supplies
  the authentication registration return contract.
- `packages/web/server/lib/server-frame/core-routes.ts` and
  `packages/web/server/lib/version-order.ts` remove comments rejected by lint.
- Module documentation and this inventory record those changes.
- The 13-file recovery patch adds its independently reviewed automation,
  release boundary changes and contract tests.

The other three initially failing web files were not edited:
`settings-helpers.test.js`, `ssh-credential-storage.test.js`, and
`provider-routes.github.test.js`. They pass with the corrected test environment.
No commit, push, release or deployment has occurred.

### Final combined-tree gate and owner decision

The final combined-tree command was
`bun run check:changed -- --base 7dad9febda60a752930ef7fc65cc163d1541b574`.
Type-check and ordinary lint pass. The command exits 1 for dead code,
rule-count growth and file size. Full output is retained at
`/srv/opencode-data/jkorzekwa/opencode/xdg/opencode/shell/06f88d2e15b9b1bce366fc02807376c060d35d87/sh_205689cb400169RE6qcyHpUOx9.out`.

Moved-file size attribution includes:

| Current path | Current lines | Prior fork path | Prior lines | Upstream lines |
| --- | ---: | --- | ---: | ---: |
| `server/lib/server-frame/core-routes.ts` | 1349 | `server/lib/opencode/core-routes.js` | 1370 | 1263 |
| `server/lib/server-frame/feature-routes-runtime.ts` | 1046 | `server/lib/opencode/feature-routes-runtime.js` | 1012 | 1044 |
| `server/runtime.ts` | 3178 | `server/index.js` | 3307 | 3167 |
| `bin/lib/cli-startup.ts` | 938 | `bin/lib/cli-startup.js` | 914 | 721 |
| `server/lib/openchamber-update/validated-release-installer.ts` | 1360 | `server/lib/openchamber-update/validated-release-installer.js` | 1280 | absent |

All paths in this table are relative to `packages/web`. Restart attestation
and termination routes already exist in the prior fork's `core-routes.js`;
the build-revision wiring already exists in its `server/index.js`.
Combining that behavior with upstream's extracted typed modules increases
some files relative to either single base. The unchanged gate does not
represent this two-source preservation operation.

The owner authorized bounded cleanup/refactoring until the required gate
passes, with no exception or suppression. The branch is rooted directly at
upstream v2.8.0 (`30c70496a5ca0105e04e60a783964576973edc8f`), which is the
precommit base for the reapplied fork patch. The earlier prior-fork comparison
measured the whole upstream upgrade and remains historical evidence.
Local `origin/main` is stale at `43d243c6a6`; use the explicit upstream commit.
Command-local `diff.renameLimit=10000` completes Git rename detection without
changing repository configuration or gate rules. Prior-fork JS predecessors
explain preserved behavior but do not exempt new files relative to upstream.
Counts alone do not prove finding-location equivalence; targeted rereview
remains required. Browser/native-platform runtime validation is also pending.

### Coordinator cleanup

- `registry-snapshot.ts` keeps its writer private; 28 registry tests pass.
- `updater-feed.mjs` exposes one production-feed name; its existing platform,
  channel, mirror and E2E behavior passes all 10 focused tests.
- `packages/ui/src/lib/browser/annotationOverlay.ts` is 790 lines after
  extracting dictation generation to `annotationVoiceScript.ts` (201 lines)
  and configuration/message types to `annotationOverlayTypes.ts` (42 lines)
  in the same directory. Its 10 tests pass before and
  after. A separate comparison confirms byte-identical emitted JavaScript
  with voice disabled and enabled.
- `self-update/openchamber-routes.test.js` uses the real package-manager
  implementation and substitutes registry HTTP responses. All 29 tests pass;
  the module-mocking finding is removed.

The seven updater-feed comments were removed, with their rationale recorded
in `packages/electron/DOCUMENTATION.md`. Focused anti-slop lint passes all
seven coordinator-owned source/test files, including both new annotation
modules.
All cleanup owners have returned. The coordinator completed the sequential
combined checks described in the final validation section below.

### Coordinator server and CLI extraction

The additional coordinator-owned size group is ready for independent rereview.
The gate base is upstream v2.8.0.

| Existing file | Before extraction | After | Upstream |
| --- | ---: | ---: | ---: |
| `packages/web/bin/lib/cli-startup.ts` | 938 | 674 | 721 |
| `packages/web/server/lib/openchamber-update/validated-release-installer.ts` | 1360 | 709 | absent |
| `packages/web/server/lib/package-manager.ts` | 930 | 907 | 925 |
| `packages/web/server/lib/server-frame/core-routes.ts` | 1349 | 1260 | 1263 |
| `packages/web/server/lib/server-frame/feature-routes-runtime.ts` | 1046 | 957 | 1044 |
| `packages/web/server/runtime.ts` | 3178 | 3166 | 3167 |

New implementation files:

- `packages/web/bin/lib/cli-managed-launcher.ts`, 269 lines.
- `packages/web/server/lib/openchamber-update/release-artifact.ts`, 626 lines.
- `packages/web/server/lib/openchamber-update/release-contract.ts`, 38 lines.
- `packages/web/server/lib/server-frame/request-authorization.ts`, 46 lines.
- `packages/web/server/lib/server-frame/update-attestation-routes.ts`, 94 lines.
- `packages/web/server/lib/server-frame/feature-route-contracts.ts`, 116 lines.

Command discovery moved into the existing `package-manager-probe.ts`.
Runtime package-version reading moved into the existing
`opencode/build-revision.ts`; its focused test covers trimmed versions and the
unchanged unknown fallback for missing/malformed metadata.

Proof on this extraction:

- Installer tests: 52 pass before and after.
- CLI startup: 40 pass before; CLI startup plus update routes: 69 pass after.
- Core/bootstrap/package-manager: 129 pass before. Those files plus build
  revision: 133 pass after.
- Node source entries and Windows package-manager: 29 pass, 4 Windows-only
  cases skipped on Linux.
- Ordinary and anti-slop lint pass all 14 owned implementation files.
- All 903 verify-zone source references resolve. None references a removed
  coordinator-owned path.
- Server/CLI source discovery includes all six new helper modules, with no
  paired declarations. The existing `server/**/*.ts` and `bin/**/*.ts` build
  inputs include them; emitted-build verification remains a combined-tree step.
- One-off extraction comparison preserves all 46 installer function
  declarations and all 57 CLI function declarations verbatim apart from
  export modifiers.

The parent reports independent approval of the server/CLI/installer extraction.
Combined type-check, build and all three runtime smoke modes now pass.

Run from the recovery worktree, sequentially, with:

```sh
export PATH=/srv/opencode-data/jkorzekwa/runtime/node-24.22.3/bin:/srv/opencode-data/jkorzekwa/runtime/bun-1.4.5/bin:/srv/opencode-data/jkorzekwa/runtime/node-22.23.4/bin:/srv/opencode-data/jkorzekwa/runtime/gh-2.105.0/bin:$PATH
export TMPDIR=/srv/opencode-data/jkorzekwa/opencode/tmp/opencode
```

The frozen dependency installation passed. The coordinator repeated the
combined checks serially after cleanup; the historical failures above are
superseded by the final validation below. Test commands use a process-local
`umask 022`.

```sh
bun run type-check
bun run lint
OPENCHAMBER_SKIP_BROWSER_TESTS=1 OPENCHAMBER_TEST_RETRY=2 bun run test
NODE_OPTIONS=--max-old-space-size=4096 bun run build
bun run --cwd packages/web smoke:server-build
node packages/web/scripts/smoke-server-build.mjs --built-cli
node packages/web/scripts/smoke-server-build.mjs --source-cli
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.renameLimit GIT_CONFIG_VALUE_0=10000 bun run check:changed -- --base 30c70496a5ca0105e04e60a783964576973edc8f
```

The explicit gate base is upstream v2.8.0, the branch's actual root.
It compares the reapplied fork patch with its upstream parent. The
browser exclusions and retries above match the fork's validation workflow;
they do not establish visual or native-platform runtime proof.

The initial inspection reproduced both dead-code findings on the prior fork.
The authorized cleanup now makes `writeSettingsRegistrySnapshots` private
and exports the default feed only as `PRODUCTION_UPDATER_FEED`. The combined
dead-code check passes.

### Post-cleanup combined validation

`check:changed` passes against upstream
`30c70496a5ca0105e04e60a783964576973edc8f`, with command-local
`diff.renameLimit=10000`: type-check, ordinary lint, dead code, rule-count
ratchet and file size all pass. Existing lint warnings and Knip configuration
hints remain; no rules, thresholds or suppressions were changed.

The root test command passed sequentially:

| Suite | Result |
| --- | --- |
| Root scripts | 44/44 files |
| Channel release, desktop release and recovery | 96 tests passed |
| SDK | 38/38 files |
| UI | 1507/1507 files |
| VS Code | 79/79 files |
| Electron | 83/83 files |
| Web | 701 files / 13048 tests passed; 9 files / 149 tests skipped |

Tests used `OPENCHAMBER_SKIP_BROWSER_TESTS=1 OPENCHAMBER_TEST_RETRY=2`.
The complete root build passed. Built server, built CLI and source CLI smoke
checks returned HTTP 200 for health and both diagnostic endpoints. Built
server and built CLI also served the UI HTML with HTTP 200. Each smoke process
stopped and removed its disposable data.

Integration corrections after worker handoff restored the `GuestWaitParam`
type import, declared Bun's `jest.getTimerCount`, adjusted two test assertions
to the local Bun declarations and removed unused exports. Behavioral tests
also exposed the desktop verifier's removed CLI import and old payload path.
It now calls upstream `verifyOpenCodeServer` for the packaged server; signature
and skip-execution behavior have executable tests instead of source-text
assertions. The subsequent workflow audit found removed CLI package scripts,
four obsolete `opencodeCli.version` reads and missing Node setup in the signing
job. Three contract regressions reproduced those failures before the fixes.
The workflows now invoke the server package scripts, obtain all four version
values through `readPinnedOpenCodeServerVersion`, and install pinned Node
24.22.3 in the signing job before verification.

After these final workflow changes, all 99 release/recovery regressions pass,
including workflow shell syntax validation, and the complete upstream-baseline
gate passes again. Logs are `final-release-regressions.log` and `final-gate.log`
in the evidence directory. The earlier full suites, build and runtime smokes
precede only these workflow/test changes and documentation updates.
The parent confirms all independent reviews approved, including lifecycle
corrections, the desktop verifier and final workflow audit. The desktop audit
verified the authoritative server-version helper returns 2.3.2.
The deliberate `J2K_MACOS_RUNS_ON` native-smoke policy was not changed.

Logs and launch helpers are outside the repository in
`/srv/opencode-data/jkorzekwa/opencode/tmp/opencode/v280-final-evidence/`.
The passing gate log is shell `sh_205925770001Zq7gOfaVFj2lcy`; complete tests
and build logs are `all-tests.log` and `build.log`. Runtime smoke evidence is
shell `sh_2059e9d24001kx6wb0Hhp5L1Rh`.

The parent exercised the final built isolated web server on bee2 port 43181,
forwarded to laptop Chrome. The main shell, Settings and About opened; About
rendered version 2.8.0 and release notes, displayed “No validated release is
available for this Mac.”, and offered no install/update action. Screenshot:
`/srv/opencode-data/jkorzekwa/opencode/tmp/opencode/v280-final-evidence/v280-isolated-about.png`.

This establishes only the tested shell/settings and unavailable-update state,
not a full UI pass. The first backend target (port 9) failed to fetch. A second
isolated OpenCode 2.3.0 backend on port 43182 became healthy but returned HTTP
401 from its API without configured authentication. Connected-backend and
session behavior were not validated.

The parent closed only its owned browser tab 1, preserving the original blank
tab 0. Both harnesses and the SSH forwarding were stopped, isolated data was
removed, and process-exit notifications confirmed shutdown.

Native desktop runtime validation remains unperformed: no native app was
started. Normal Electron launch can register protocols or change login items
even with disposable profile data. These results do not establish native
release readiness. The separate desktop release workflow audit in
parent-managed session `ses_dfa715605ffeil2bYBuM2MDxtA` identified the blockers
fixed above; the parent owns final review and the remaining native-validation
decision.

### Draft publication authorization

James explicitly authorized “Publish draft PR” with the missing native
runtime evidence disclosed. This exception authorizes draft publication only,
not merge, release or deployment. The parent owns push, draft PR creation and
monitoring. The consolidated commit is directly above upstream v2.8.0
`30c70496a5ca0105e04e60a783964576973edc8f`; no old-fork history is merged.
All independent reviews are approved, and the final 99 release/recovery tests
and unchanged mandatory gate pass. Connected-backend/session behavior and
native desktop runtime/update behavior remain unvalidated as detailed above.
