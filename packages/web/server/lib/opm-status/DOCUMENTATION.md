# OPM status module

## Purpose

This module exposes the loopback-only opencode-project-manager (OPM) activity in OpenChamber. The server polls OPM, classifies work and owner actions, then serves a cached snapshot at `GET /api/opm/status`. `POST /api/opm/command` executes a snapshot-derived owner command (`{project, ref, command}`) as a GitHub issue comment through the `gh` CLI.

## Ownership

- `routes.js` owns configuration, polling, classification, hierarchy construction, and the HTTP route.
- `pushover-notifier.js` owns Pushover pushes for new needs-owner demands and stalled attention entries. Credentials come from the macOS login keychain (`Uptime Kuma Pushover User Key` / `Uptime Kuma Pushover API Token`); dedupe keys persist in `~/.local/state/openchamber-opm-status-notified.json` (last 100).
- `feature-routes-runtime.js` owns the registration handle. It closes the previous handle before HMR re-registration and closes the active handle during server shutdown.
- `packages/ui/src/components/opm-status/` owns parsing and presentation. It must treat a failed request as unavailable, not as an empty work list.

## Configuration

Optional configuration lives at `~/.config/openchamber-opm-status.json`:

```json
{
  "controlUrl": "http://127.0.0.1:47651",
  "issueUrls": {
    "project-slug": "https://github.com/owner/repository/issues/{ref}"
  },
  "repos": {
    "project-slug": "owner/repository"
  }
}
```

`OPM_CONTROL_URL` overrides `controlUrl`. The default control URL is `http://127.0.0.1:47651`. Command execution resolves the target repository from `repos` first and falls back to the `owner/repository` embedded in the project's `issueUrls` template.

## Invariants

- Poll every 10 seconds and time out each OPM fetch after 3 seconds.
- Polling failure replaces the cached response with `available: false`; stale success must not look current.
- Responses use `Cache-Control: no-store`.
- The interval is unreferenced and must be cleared through the returned `close()` handle.
- Register this explicit OpenChamber route before the generic OpenCode `/api/*` proxy.
- A waiting parent is not counted as active. Rich child rows win over inline child summaries, and owner-required children raise their family to the top of the tree.
- The notifier runs on every successful snapshot and must never break polling: missing credentials disable pushing with one warning, only successful sends record their dedupe key (failures retry next poll), and notifier errors never turn a good snapshot unavailable.
- `POST /api/opm/command` never executes arbitrary input. The submitted command must re-derive from `poller.current()`: it must exactly equal the (project, ref) row's own `command`, or be the literal `/agent resume` for a non-terminal row (not completed/cancelled/verified) or a stalled supervisor attention entry on that ref. Any mismatch is a 400 that never reaches `gh`; a `gh issue comment` failure (15s timeout) is a 502 `{ ok: false, error }`; 500 is reserved for unexpected faults. A successful post triggers an immediate `poller.poll()`.
