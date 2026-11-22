# J2K port to upstream v2.7.0

The fork's patch series moved from upstream `v1.24.2` to `v2.7.0` in one step.
The automated sync had stopped at upstream `v2.0.0` (2026-09-23): replaying
the series hit a conflict on its first patch at every release since, so the
fork shipped nothing newer than `1.24.2-j2k.*`.

## Method

- Source of the series: PR #92 (`fix/j2k-2.1.0-recovery-20261002`, tip
  `52f7bc0e4`), which had already replayed 116 fork commits onto `v2.1.0` and
  ported them to OpenCode v2. Its record of per-commit decisions is in Git
  history at `docs/J2K_REBASE_RECOVERY_20261002.md`.
- Added on top: #94 (OPM retirement docs), #96 (OPM removal, redone on the
  v2.1.0 tree), #97 (background-work banner). The XDG auth-data patch stays
  dropped; upstream asks the running OpenCode for credentials.
- The whole fork delta against `v2.1.0` was applied to `v2.7.0` as a single
  series commit and its 56 conflicting files were resolved once. Replaying
  116 commits would have resolved the same regions repeatedly. Per-commit
  history stays reachable through the `v1.24.2-j2k.*` tags and PR #92.

## Removed

- OPM: status dashboard, settings, `/api/opm/*`, Pushover notifier, i18n,
  screenshots, and the shutdown hook that only stopped OPM polling.
- The managed-worktree session-goal lifecycle (`worktree-goal-gate.js`) and
  the legacy stale-recovery holds (`managed-goal-*`,
  `legacy-recovery-compatibility.js`). Their only writer was OPM's
  session-worktree-lifecycle plugin, removed from bee2 on 2026-10-06, and the
  recovery worker was already inert on OpenCode v2. The session-goal runtime,
  tests and documentation are upstream's.
- Upstream's `.github/workflows/canary.yml`: a nightly multi-platform build
  and publish that has no purpose on the fork.

## Resolution decisions

| Area | Decision |
|---|---|
| Update routes (`openchamber-routes.js`) | Fork's validated-channel check, status and install routes replace upstream's npm/launchd/Windows install path. Upstream's `desktop-host` refusal was added to the desktop install path. Other routes are upstream's. |
| Version ordering | The `-j2k.N` suffix rule moved into upstream's `version-order.js`, which now serves the server and Electron. A fork build is not a pre-release of its upstream version. |
| Electron updater | Upstream's Stable/Canary channel is kept for non-J2K builds. A J2K macOS build always reads the private desktop channel. |
| About settings | Upstream layout. J2K builds do not offer the Stable/Canary choice; the no-validated-release notice is kept. |
| Update restart endpoints (`/health/update-attestation`, `/health/restart-for-update`) | Loopback alone no longer counts as local: requests carrying the relay header or classified as tunnel are rejected, matching upstream's diagnostics routes. |
| `ChatContainer`, `SessionNodeItem` | Upstream files with the fork's PTY-waiting marker and badge and `BackgroundWorkBanner` re-applied. Infinite `animate-pulse` dots removed to satisfy upstream's animation rule. |
| `BackgroundWorkBanner` | Kept: upstream shows background shells and images above the composer and running subagents in the work-status panel, but nothing in the transcript and no hosted PTY jobs. Opens children through upstream's `useOpenChildSession`. |
| CLI (`cli-http`, `cli-startup`, `commands-update`) | Upstream request filtering; fork's managed launcher and validated-install path kept beside upstream's startup-service restart. |
| Tests both sides added | Upstream file kept; fork tests moved to `cli-startup.managed.test.js`, `config-entity-routes.guards.test.js`, `useUpdateStore.lifecycle.test.ts`. |
| Translations | Fork strings added for the new `ar` and `he` locales; stale Dutch keys of the removed PTY banner dropped. |
| PR #100 (live PTY panel, docked card) | Ported to OpenCode 2 rather than carried: OpenCode 2 has no `opencode-pty`, so its inspector relay (`/api/pty-inspector`, port 4098) and the PTY-waiting metadata (`backgroundJobs`, sidebar waiting badge) are dropped. Each row of upstream's background-commands strip opens the command's read-only output in a `pty` "Process" tab that reads OpenCode 2's `shell` output by cursor; running subtasks sit in a composer row right after it. Upstream already counts a session with a background command as active. |

## Node 24

Upstream requires Node >= 24.14.0 since v2.3.0. The J2K validate and
release pipelines, channel tooling and installer target moved from Node
22.22.0 / modules ABI 127 to Node 24.22.3 / ABI 137. Installs still running
Node 22 find no matching validated artifact and stay where they are.

## Not verified here

No real OpenCode v2 service, packaged Electron update, signed macOS build, or
bee2 deployment was exercised.

OpenChamber 2.7.0 refuses OpenCode older than 2.2.4
(`server/lib/opencode/compatibility.js`). bee2 ran OpenCode 1.19.5 when this
port was prepared (2026-11-11), so deploying it there requires upgrading
OpenCode to v2 first, including its data migration. Publishing a release does
not make an older running OpenCode compatible. The OpenChamber runtime itself
must also move to Node >= 24.14 (bee2's launcher used Node 22.23.4).
