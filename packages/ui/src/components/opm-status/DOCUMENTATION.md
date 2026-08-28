# OPM status UI

## Purpose

This component renders OPM status in connected hosted web, Electron, and mobile shells. It probes the active runtime's explicit `/api/opm/status` route and renders nothing when that route is unsupported, so VS Code and older servers do not show the feature.

## Ownership

- `opm-status.ts` owns route transport (`GET /api/opm/status`, `POST /api/opm/command`), boundary parsing, derived counts (including the salient mobile count), and owner-guidance classification used for localization.
- `OpmStatusOverlay.tsx` owns the fixed pill, pill dragging and edge placement, dashboard dialog, visible-only polling, browser notifications, copy and one-tap Run actions, mobile row collapsing, and session navigation.
- `MainLayout.tsx` owns the hosted desktop and Electron mount. `MobileApp.tsx` mounts it inside the connected provider shell. Unavailable/disconnected mobile screens and `VSCodeLayout` do not mount it.

## Invariants

- Parse every response before rendering it.
- A `404` or `501` means unsupported and hides the feature. Other failures render OPM as unavailable, never as an empty list.
- Refresh on mount and when the document becomes visible. The 15-second timer performs no fetch while hidden.
- Open Session calls `useSessionUIStore.getState().setCurrentSession(sessionId, workspacePath)`. The store remains the authority for directory and project routing.
- Rendered text uses i18n keys. OPM, GitHub, commands, paths, and server-provided work-item content remain literal.
- Styling uses shared Dialog, Button, Icon, and semantic theme tokens.
- The pill is draggable along the viewport edges: a 5px pointer travel threshold separates click from drag, release snaps to the nearest edge with a 6px margin, and the position persists in `localStorage` (`opmStatus.pillPos`) as `{ edge, offset }`. Inline styles override the default CSS position only when a stored position exists, top-edge placement respects `env(safe-area-inset-top)`, and a drag release never opens the dashboard.
- On small screens the pill collapses to the status dot plus the salient count (`getSalientOpmCount`); the full text is desktop-only. Pill children never become pointer targets, so iOS drags always capture on the pill itself.
- Every row with a `command` renders a primary Run button beside Copy. Run posts `{project, ref, command}` to `/api/opm/command`, shows an in-button pending state, then either a disabled "Sent ✓" state that clears after ~10 seconds or the server's error inline under the actions row. The server re-validates against its own snapshot, so a stale command is a 400, never an execution.
- The dashboard dialog header is a sticky, opaque, z-raised bar containing its own close button; the body scrolls under it. The dialog respects `env(safe-area-inset-top/bottom)`.
- Below the `sm` breakpoint each row collapses to a two-line summary (ref + phase pill + age, then a truncated title) that expands on tap; needs-owner and dead-letter rows start expanded, and a collapsed tree root hides its child rows. Desktop always renders the full rows. Titles, reasons, and guidance wrap with `break-words`/`overflow-wrap:anywhere`; only monospace sha/command/tech spans use `break-all`.
