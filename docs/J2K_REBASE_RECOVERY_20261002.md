# J2K v2.1.0 rebase recovery

The rebase completed all 114 steps. It replayed 113 commits and skipped the
obsolete local credential-file patch. Compatibility changes follow the replay.

- Worktree: `/srv/opencode-data/jkorzekwa/opencode/state/openchamber-2.1.0-recovery-20261002`
- Branch: `fix/j2k-2.1.0-recovery-20261002`
- Upstream base: `90726f9949da3408b2baf0f997e24bd71455946e`
- Original fork tip: `ebda4920bbe4848d1bdd168b832c3c7e10f7d18f`
- Completed replay tip: `ca86b558977154c0ed7ccdcdd9c475a9b72139d7`

This is a manually prepared recovery, not an OPM execution. Publication of the
repair branch does not authorize promotion to `j2k/current` or prove a release.
No credential migration or live-service upgrade is part of this recovery.

## Dropped commit

Only `443cf06dd5e4c0c4a3bb34eece5aedbf84dc6c60`, Support XDG OpenCode auth data
directories, was skipped in favor of upstream credential authority.

OpenChamber now asks the running OpenCode for credentials. It no longer selects
or writes provider `auth.json` using `OPENCODE_DATA_DIR`, `XDG_DATA_HOME/opencode`,
the nested migrated `~/.local/share/opencode/xdg/opencode`, or the legacy default
directory. No live credentials were read or migrated.

## Conflict resolutions

The identifiers below name original commits. All unlisted commits applied
without manual conflict resolution.

| Commit | Conflicted files and resolution |
| --- | --- |
| `0c995fca4` | `packages/web/server/lib/opencode/agents.js`: primary-worktree guards applied to upstream v2 markdown and JSON mutations; v2 section conversion retained. |
| `55e6eba5b` | `packages/ui/src/sync/session-event-router.ts` and `sync/__tests__/sync-context-session-events.test.ts`: directory reconciliation follows authoritative `session.patched` application and stale checks; upstream metadata-broadcast tests retained. |
| `73ae31654` | `packages/web/server/lib/session-goal/runtime.js` and `runtime.test.js`: managed lifecycle gate, progress and identity enforcement combined with upstream audit and metadata persistence. Subsequent compatibility changes replace unsupported recovery and convert integration fixtures to v2. |
| `d359e68dc` | `ChatContainer.tsx` and `sidebar/sessions/SessionNodeItem.tsx`: PTY banner and idle waiting marker retained alongside upstream turn activity, background-work indicators, permission/form docks and metadata comparison. |
| `482378445` | `openchamberEvents.test.ts` and scheduled-task documentation: build-revision reload coverage combined with upstream relay, file-open and notification behavior. |
| `c66c79363` | `MainLayout.tsx`, 11 locale dictionaries, server `index.js`, shutdown runtime and tests: OPM overlay/translations retained without replacing upstream multirun/spaces UI; feature-route cleanup joins failure-isolated shutdown. |
| `5ee600ee0` | `MobileApp.tsx`, event tests, server `index.js`, event-stream/OpenCode docs, agent writer, shutdown tests and goal runtime/tests: mobile overlay combined with spaces UI, prompt-target guards added to the v2 writer, build-revision and metadata seams retained. |
| `5c70ad953` | `release.yml`, `AboutSettings.tsx`, `useUpdateStore.ts`, update routes/tests: fork's intentional validated-release workflow replacement retained. Upstream native-server update distinction, enterprise-policy route, desktop updater ownership and install-blocked UI retained. J2K managed artifact installation stays authoritative. |
| `f69745ab8` | Electron `scripts/bundle-main.mjs`: J2K build flag retained with upstream entry/main/early-startup bundles. |
| `7a4a550cc` | OpenChamber routes: canonical managed install-root import combined with enterprise-policy import. |
| `e039e6233` | `bun.lock`: temporary legacy plugin dependencies isolated from upstream v2 SDK/effect/native pins. |
| `adddb3271` | `bun.lock`: replayed the original plugin revert and preserved upstream dependencies that the old revert would otherwise remove. The plugin package does not remain in the final tree. |
| `628165aae` | Electron `main.mjs`: packaged updater smoke retained without duplicating upstream early-startup initialization. |
| `073a51519` | `oc-review.yml`: upstream separate tests job retained. Subsequent workflow repairs remove obsolete v1 recovery provisioning. |
| `43d38f348` | Turkish dictionary: both upstream dictionaries and J2K PTY/OPM/update strings retained. |
| `9b86b770f` | Server `index.js`, bootstrap runtime, update routes/tests: embedding-host update ownership combined with upstream spaces body-parsing and existing install-blocked behavior. |

The final lockfile difference from upstream is the fork's existing web
`proper-lockfile: 4.1.2` dependency. Upstream OpenCode 2.0.21, effect, node-pty,
and other dependency pins were not downgraded.

## Explicit OpenCode v2 compatibility gap

Inspection of pinned `@opencode/client@2.0.21` established that it has no
assistant tool-part PATCH. Interrupt acts asynchronously on the current fiber;
an idle false result is not task settlement. The v2 tool is `subagent`, using
`metadata.sessionID`, instead of the v1 task binding.

Pinned protocol evidence:
<https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/protocol/src/groups/session.ts>
and the session-message schema at the same commit.

The entire legacy stale-recovery worker is therefore inert. Its public factory
reports `supported: false`; startup, observation, discovery and explicit scans
do no work. There is no persisted aborting/delivery replay, API request, journal
write/delete, hold clearing, counter increment, or continuation dispatch.
The old implementation remains retrievable from Git history, rather than being
reachable through a hidden switch. OpenCode owns restart recovery.

Ordinary goals remain functional. Their mutation and continuation paths respect
existing, malformed and unreadable recovery journals, and `stale-recovery:`
holds. Recent nonterminal v2 subagent tools prevent ordinary continuation even
when the parent reports idle. The tail is checked again before turn accounting.
Managed lifecycle gates, objectives, progress, identity protection and held
worktree movement remain available through upstream metadata seams.

Incoming v1 recovery tests were replaced by unsupported-worker and journal
preservation coverage. The former real-v1-restart test now verifies the disabled
contract and starts no server. It is not proof of v2 restart behavior.

## Other compatibility choices

- PTY helper/component/test imports use the current UI domain `Session`, not the
  removed v1 SDK. The moved-session fixture now includes the directory patch.
- The fork's validated installer does not fall back to upstream npm/batch
  installation for daemon/Windows web servers. Desktop host-owned updating is
  retained. Unsupported web installation remains an explicit refusal.
- Connected-server updates preserve their explicit web target when the client
  is native mobile or Electron. Electron-owned server updates retain restart
  monitoring and exact target-version verification.
- Dutch translations cover the fork's PTY, OPM, and update-status controls.

## Workflow repairs

- An existing candidate without the required upstream ancestry fails sync with
  an explicit error. It no longer reports a successful no-op indefinitely.
- Recovery reporting fetches full history before describing the previous base.
- Removed v1.18.29 fixture provisioning for the now-inert legacy worker. The
  root suites still exercise the unsupported-worker and journal-preservation
  contracts; this is not evidence of native v2 restart recovery.
- The four upstream PR check jobs use GitHub-hosted Ubuntu runners in this fork,
  not the upstream organization's private Blacksmith runner labels.
- Release tests exercise the fork's actual assembly and publication conditions,
  including failed, cancelled, and skipped prerequisites and untrusted refs.

## Validation

Local verification uses Node 22.23.3, Bun 1.4.2, and npm 11.6.2 on bee2 Linux
x64. The toolchain is isolated from the running OpenCode service.

Passed:

- 19 tests across disabled recovery, its compatibility entry point, managed
  lifecycle gate, primary-worktree guard, PTY integration placement, and OPM
  overlay mounting. Command used Bun against these six test files directly.
- Two Node SemVer tests.
- In-memory Bun syntax compilation of 126 changed JS/MJS/TS/TSX files.
- Node syntax checks of resolved server/Electron files.
- `git diff --check` before every completed manual continuation and after the
  compatibility changes.

Subsequent complete verification:

- `bun install --frozen-lockfile`: passed without changing the lockfile.
- `bun run type-check`, `bun run lint`, and `bun run build`: passed.
- `bun run test`: passed. Root scripts: 9 files; release tooling: 68 tests;
  SDK: 17 files; UI: 664 files; VS Code: 54 files; Electron: 34 files;
  web: 4,878 tests passed, 128 skipped across 301 passed and 9 skipped files.
- After the runner correction, release tooling passed 69 tests.
- `bun run dead-code`: completed with non-blocking repository findings, including
  `oxlint.config.ts` and unused exports. No broad dead-code cleanup was attempted.
- Focused updater tests: 21 passed. Dutch dictionary parity: 4 passed.

Known limits:

- `bun run changelog:check` fails because the old fork added three lines to
  generated root `CHANGELOG.md`. The existing PR gate remains intact. Changelog
  files were not edited or regenerated without the maintainer's request.
- Native signed macOS packaging, artifact-install smoke, GitHub release
  publication, and live OpenCode v2 integration remain release-stage checks.
- No live service or credential store was changed. This release targets
  OpenCode v2; the existing bee2 OpenCode v1 service was not upgraded.
