# OPM status module

## Purpose

This module exposes the loopback-only opencode-project-manager (OPM) activity in OpenChamber. The server polls OPM, classifies work and owner actions, then serves a cached snapshot at `GET /api/opm/status`.

## Ownership

- `routes.js` owns configuration, polling, classification, hierarchy construction, and the HTTP route.
- `feature-routes-runtime.js` owns the registration handle. It closes the previous handle before HMR re-registration and closes the active handle during server shutdown.
- `packages/ui/src/components/opm-status/` owns parsing and presentation. It must treat a failed request as unavailable, not as an empty work list.

## Configuration

Optional configuration lives at `~/.config/openchamber-opm-status.json`:

```json
{
  "controlUrl": "http://127.0.0.1:47651",
  "issueUrls": {
    "project-slug": "https://github.com/owner/repository/issues/{ref}"
  }
}
```

`OPM_CONTROL_URL` overrides `controlUrl`. The default control URL is `http://127.0.0.1:47651`.

## Invariants

- Poll every 10 seconds and time out each OPM fetch after 3 seconds.
- Polling failure replaces the cached response with `available: false`; stale success must not look current.
- Responses use `Cache-Control: no-store`.
- The interval is unreferenced and must be cleared through the returned `close()` handle.
- Register this explicit OpenChamber route before the generic OpenCode `/api/*` proxy.
- A waiting parent is not counted as active. Rich child rows win over inline child summaries, and owner-required children raise their family to the top of the tree.
