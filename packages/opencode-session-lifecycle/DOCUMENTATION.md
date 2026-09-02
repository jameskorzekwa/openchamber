# OpenCode session lifecycle plugins

## Ownership

This package owns the OpenCode plugins and their lifecycle implementation. `SessionWorktreeLifecycle` owns per-session worktree creation, movement, recovery, waiting, submission, finish, cleanup, and turn barriers. `PtyWaitingStatus` owns publication and cleanup of session-scoped PTY waiting metadata.

OpenCode Project Manager owns supervision after a managed submission. `agent-config` owns host installation and loading only. Changes to supervision or host overlays belong in those repositories rather than this package.

## Session-goal state contract

The lifecycle writes controller state under `~/.local/state/opencode/session-worktrees` by default. `HEIRLOOM_AGENT_LIFECYCLE_STATE_DIR` redirects the directory for tests.

- `<sessionId>.json` is version 1 controller state. The server session-goal runtime reads `managedGoalID`, `managedGoal`, `managedGoalObjective`, `phase`, and `devDeployment`.
- `<sessionId>.goal.json` is the latest accepted goal progress and must retain the same goal ID.
- `<sessionId>.submit.json` is the submission intent journal used to make retries idempotent.
- State and companion records use temporary files plus atomic rename. Malformed, unsupported, missing, and goal-mismatched state fails closed.
- Completion requires the phase and deployment evidence accepted by `packages/web/server/lib/session-goal/worktree-goal-gate.js`.

The server session-goal runtime is the reader of this contract. Any state version, field, phase, path, or deployment-evidence change must be updated and tested in both packages.

## UI background-job contract

The PTY plugin writes `metadata.openchamber.backgroundJobs` on the owning OpenCode session. Version 1 contains `updatedAt`, optional `resumeGoalID`, and `jobs`. Each job has a non-empty `id`, `kind: "pty"`, positive `createdAt`, optional `description`, and optional positive integer `timeoutSeconds`.

The UI parser in `packages/ui/src/lib/ptyWaitingState.ts` treats only valid PTY job records as waiting. Malformed metadata fails closed. The plugin preserves unrelated session metadata, serializes writes per session, removes completed jobs, and clears stale records during startup recovery. It reactivates a blocked goal only when `resumeGoalID` still identifies the same goal.

## Compatibility invariant

The package version must exactly match the OpenChamber fork base version. A `j2k` release revision does not change that version pairing. For example, every `v1.21.0-j2k.*` tag pairs with plugin package version `1.21.0`. The `@opencode-ai/plugin` dependency stays pinned to the OpenCode API version used by the fork.

Source plugins and libraries retain their upstream `agent-config` behavior. Port changes require evidence in the package tests before altering those files.

## Tests

- `session-worktree-lifecycle.test.mjs` covers worktree lifecycle, submission, recovery, deployment gates, and turn barriers.
- `session-worktree-lifecycle-recovery.test.mjs` covers persisted recovery, safe restoration, external waits, and abandonment.
- `pty-waiting-state.test.mjs` covers PTY envelope parsing, metadata preservation, completion, goal resume guards, and stale-state cleanup.

The package `test` script runs these files with the Node 22 test runner and Bun. `package-contract.test.mjs` imports the built entrypoint, checks both plugin exports, and rejects a package version that differs from the fork base version. `type-check` performs Node strip-types syntax checks for TypeScript entrypoints and `node --check` for the JavaScript libraries. `lint` runs oxlint over the TypeScript files.
