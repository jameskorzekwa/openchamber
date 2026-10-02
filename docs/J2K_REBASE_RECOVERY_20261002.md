# J2K v2.1.0 rebase recovery

The rebase completed all 114 steps. It replayed 113 commits and skipped one
with explicit parent authorization. Compatibility changes follow the replay.

- Worktree: `/srv/opencode-data/jkorzekwa/opencode/state/openchamber-2.1.0-recovery-20261002`
- Branch: `fix/j2k-2.1.0-recovery-20261002`
- Upstream base: `90726f9949da3408b2baf0f997e24bd71455946e`
- Original fork tip: `ebda4920bbe4848d1bdd168b832c3c7e10f7d18f`
- Completed replay tip: `ca86b558977154c0ed7ccdcdd9c475a9b72139d7`

No push, PR, merge, release, OPM operation, remote branch mutation, credential
migration, or live-service change was performed.

## Dropped commit

Only `443cf06dd5e4c0c4a3bb34eece5aedbf84dc6c60`, Support XDG OpenCode auth data
directories, was skipped. The parent explicitly chose upstream credential
authority.

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
| `073a51519` | `oc-review.yml`: upstream separate tests job retained with incoming legacy recovery fixture steps. Workflow cleanup remains a parent follow-up. |
| `43d38f348` | Turkish dictionary: both upstream dictionaries and J2K PTY/OPM/update strings retained. |
| `9b86b770f` | Server `index.js`, bootstrap runtime, update routes/tests: embedding-host update ownership combined with upstream spaces body-parsing and existing install-blocked behavior. |

The final lockfile difference from upstream is the fork's existing web
`proper-lockfile: 4.1.2` dependency. Upstream OpenCode 2.0.21, effect, node-pty,
and other dependency pins were not downgraded.

## Explicit OpenCode v2 compatibility gap

Parent research established that pinned `@opencode/client@2.0.21` has no
assistant tool-part PATCH. Interrupt acts asynchronously on the current fiber;
an idle false result is not task settlement. The v2 tool is `subagent`, using
`metadata.sessionID`, instead of the v1 task binding.

Evidence supplied by the parent:
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
- No separate release-workflow defect was fixed. Old 1.18.29 recovery-fixture
  provisioning remains in replayed workflows for the parent's follow-up.

## Validation

Located Bun 1.4.2 at `/srv/opencode-data/jkorzekwa/runtime/bun/bin/bun`.
The suggested encrypted HOME `.bun/bin` location was absent.

Passed:

- 19 tests across disabled recovery, its compatibility entry point, managed
  lifecycle gate, primary-worktree guard, PTY integration placement, and OPM
  overlay mounting. Command used Bun against these six test files directly.
- Two Node SemVer tests.
- In-memory Bun syntax compilation of 126 changed JS/MJS/TS/TSX files.
- Node syntax checks of resolved server/Electron files.
- `git diff --check` before every completed manual continuation and after the
  compatibility changes.

Dependency-bound checks could not run in this worktree. Goal runtime, PTY value
and OPM value tests fail at import because `zod` is missing. Electron updater
contract and packaged-smoke tests fail at import because `yaml` is missing.
No dependencies were installed. An attempted `NODE_PATH` lookup did not resolve
the missing package and did not change the result.

Package type-check, lint, dead-code analysis, full suites, builds, native/runtime
checks, live recovery, and release validation remain for the parent. Syntax
compilation and the focused tests do not establish those results.
