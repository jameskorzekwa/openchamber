# OPM status UI

## Purpose

This component renders OPM status in connected hosted web, Electron, and mobile shells. It probes the active runtime's explicit `/api/opm/status` route and renders nothing when that route is unsupported, so VS Code and older servers do not show the feature.

## Ownership

- `opm-status.ts` owns route transport (`GET /api/opm/status`, `POST /api/opm/command`), boundary parsing, derived counts (including the complete hierarchy count), and owner-guidance classification used for localization.
- `OpmStatusOverlay.tsx` owns the fixed pill, pill dragging and edge placement, dashboard dialog, visible-only polling, browser notifications, copy and one-tap Run actions, mobile row collapsing, session navigation, and supervisor-attention navigation into task details.
- `MainLayout.tsx` owns the hosted desktop and Electron mount. `MobileApp.tsx` mounts it inside the connected provider shell. Unavailable/disconnected mobile screens and `VSCodeLayout` do not mount it.

## Invariants

- Parse every response before rendering it.
- A `404` or `501` means unsupported and hides the feature. Other failures render OPM as unavailable, never as an empty list.
- Refresh on mount and when the document becomes visible. The 15-second timer performs no fetch while hidden.
- Open Session calls `useSessionUIStore.getState().setCurrentSession(sessionId, workspacePath)`. The store remains the authority for directory and project routing.
- Rendered text uses i18n keys. OPM, GitHub, commands, paths, and server-provided work-item content remain literal.
- Styling uses shared Dialog, Button, Icon, and semantic theme tokens.
- The pill is draggable along the viewport edges: a 5px pointer travel threshold separates click from drag, release snaps to the nearest edge with a 6px margin, and the position persists in `localStorage` (`opmStatus.pillPos`) as `{ edge, offset }`. Inline styles override the default CSS position only when a stored position exists, top-edge placement respects `env(safe-area-inset-top)`, and a drag release never opens the dashboard.
- The pill always includes the complete registered in-flight hierarchy count (`getTotalOpmCount`). On small screens it collapses to the status dot and that total; the full state text is desktop-only. Pill children never become pointer targets, so iOS drags always capture on the pill itself.
- Every row with a `command` renders a primary Run button beside Copy. Run posts `{project, ref, command}` to `/api/opm/command`, shows an in-button pending state, then either a disabled "Sent ✓" state that clears after ~10 seconds or the server's error inline under the actions row. The server re-validates against its own snapshot, so a stale command is a 400, never an execution.
- On narrow or short landscape screens the dashboard fills `100dvh` and `100vw`, removes rounded dialog chrome, and clips horizontal overflow. Its sticky, opaque, z-raised header owns the title and close button and respects every safe-area edge. Bottom padding respects `env(safe-area-inset-bottom)`. While this OPM dialog is open, existing Sonner notices stay alive below the dialog layer, so they reappear after close without covering required dialog controls; other dialogs keep their normal toast behavior.
- The dashboard starts with every needs-owner item pinned in an attention section with its guidance open, followed by a compact authoritative five-state strip. Active hierarchy branches sort ahead of idle and queued branches. Supervisor diagnostics are collapsed below the work list.
- Every task has a compact summary: a bold, non-truncating `<project>#<number>` reference begins the primary line, followed by the task description and separate badges containing only the durable lifecycle state and current action. On narrow screens the task description truncates first while the reference and badges remain fully readable. The secondary line contains age plus applicable Parent/Child metadata but not the reference. The legacy phase remains transport input for grouping only. Details stay collapsed until tapped. Epic disclosures independently collapse or expand their complete descendant trees and default to expanded. Needs-owner rows remain in their original hierarchy as well as the pinned section so collapsing an epic cannot hide required owner action. Overview totals and hierarchy rendering recurse through the complete accepted tree. Reasons and guidance wrap with `break-words`/`overflow-wrap:anywhere`; only monospace sha/command/tech spans use `break-all`.
- The sticky dashboard close control is a top-layer, pointer-enabled, non-draggable touch target. Its pointer-down event cannot leak into content or shell drag handling.
- Supervisor project health uses the configured project name, then its slug, and exposes the UUID only as a final compatibility fallback. Attention entries retain project identity and issue URLs. Selecting one expands its task and collapsed ancestors, scrolls the task into view, and focuses its summary; an attention item absent from the current task tree opens its issue URL when available.

## Grouped dashboard (2026-09-03)

The dialog renders one section per OPM project (`snapshot.byProject`), each
with four lanes in owner order: **Waiting on you** (owner decisions and
questions, with the exact reply commands), **Running** (a live session on a
working action), **Waiting** (external waits, with the reason), **Backlog**
(admitted, not picked up). Empty projects collapse to their header. Rows keep
the title and the value-only state/action badges on one line; the second line
is `{alias}#{ref}` (linked), an active-time readout, and the reason. The
readout shows `active …` while `activeSince` is set (ticking each second from
`activeMs` at fetch) and `worked …` once the supervisor stops counting it.
The header carries a pause switch (`POST /api/opm/pause`, proxied to OPM's
loopback `/pause` and `/resume`, which require `allowControlMutation`). A
collapsed **Completed** section lists the last seven days with each item's
banked active time and the all-time total. Servers without `byProject`,
`completed`, or `activeMs` render the previous flat hierarchy unchanged.
