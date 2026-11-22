# Self-update

## Ownership

This module owns OpenChamber's update checks, release notes, installation and
restart HTTP routes, plus the models metadata and Zen model routes registered
beside them. `../openchamber-update` owns validated channel discovery, archive
verification, durable release selection, restart journals and rollback.
`../changelog` owns release notes; `../package-manager` supplies upstream
non-web update checks and published OpenCode requirements.

## Invariants

- Web update checks use the validated fork channel. The response carries its
  installation state, and no matching validated release is distinct from being
  current or a failed check. Non-web app checks retain upstream behavior.
- An embedding host can set `selfUpdate: false`. The check reports managed
  ownership, and installation is rejected before starting an update.
- Desktop-managed web hosts delegate to Electron's updater. The native
  host-local restriction remains authoritative; a rejected native restart is
  retained as `DESKTOP_UPDATE_RESTART_FAILED` for completion polls, while
  ordinary availability checks remain usable.
- A target's published `engines.opencode` can block installation with
  `OPENCODE_TOO_OLD`, ahead of restart-manager checks. Missing requirement or
  unreadable running-version evidence retains upstream's non-blocking behavior.
- Web installation requires a supported restart handoff: a foreground systemd
  user service or an explicitly configured supervisor restart-on-exit contract
  (`OPENCHAMBER_UPDATE_RESTART_ON_EXIT`). Windows remains unsupported.
- The installer validates the release before selecting it. Restart preparation
  persists a journal and arms recovery before migrating the systemd service.
  Activation and handoff happen after preparation; failure invokes cancellation
  and rollback through the transaction owner. HTTP 202 means accepted, not
  installed.
- Startup schedules a fallback for a surviving journal. Helpers bind cleanup
  and ownership to the transaction ID, so an old helper cannot consume a new
  transaction. Local attestation and termination routes are owned by
  `../server-frame/core-routes.ts`.
- Detached source helpers explicitly preload the source resolver; installed
  helpers execute emitted JavaScript. `restartHelperArguments` owns that
  distinction, including fallback and systemd launches.

## Routes

- `GET /api/openchamber/enterprise-policy`
- `GET /api/openchamber/update-check`
- `GET /api/openchamber/release-notes?version=&since=`
- `POST /api/openchamber/update-install`
- `GET /api/openchamber/models-metadata`
- `GET /api/zen/models`

Release notes retain upstream website/GitHub fallback behavior. An empty list
means no notes, while unavailable sources return an error. Models metadata
retains its cache and timeout; Zen models retain their owning template runtime.

## Decisions

### Why accepted installation is not successful installation

The current server cannot prove that its replacement started correctly.
Persisted status and authenticated health attestation establish the replacement
version, build revision, process identity and readiness before installation is
reported complete. The shared UI retains polling/reconnect state across that
handoff.

### Why the stable launcher remains outside the selected package

The user-owned launcher resolves the selected release on each start, so systemd
does not keep executing an old version after selection changes. Upstream's
legacy `bin/cli.js` forwards into emitted `build/bin` code; packaged runtime
discovery follows the manifest rather than assuming source-tree depth.
