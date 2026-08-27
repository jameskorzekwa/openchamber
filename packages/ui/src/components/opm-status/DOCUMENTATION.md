# OPM status UI

## Purpose

This component renders OPM status in connected hosted web, Electron, and mobile shells. It probes the active runtime's explicit `/api/opm/status` route and renders nothing when that route is unsupported, so VS Code and older servers do not show the feature.

## Ownership

- `opm-status.ts` owns route transport, boundary parsing, derived counts, and owner-guidance classification used for localization.
- `OpmStatusOverlay.tsx` owns the fixed pill, dashboard dialog, visible-only polling, browser notifications, copy actions, and session navigation.
- `MainLayout.tsx` owns the hosted desktop and Electron mount. `MobileApp.tsx` mounts it inside the connected provider shell. Unavailable/disconnected mobile screens and `VSCodeLayout` do not mount it.

## Invariants

- Parse every response before rendering it.
- A `404` or `501` means unsupported and hides the feature. Other failures render OPM as unavailable, never as an empty list.
- Refresh on mount and when the document becomes visible. The 15-second timer performs no fetch while hidden.
- Open Session calls `useSessionUIStore.getState().setCurrentSession(sessionId, workspacePath)`. The store remains the authority for directory and project routing.
- Rendered text uses i18n keys. OPM, GitHub, commands, paths, and server-provided work-item content remain literal.
- Styling uses shared Dialog, Button, Icon, and semantic theme tokens.
