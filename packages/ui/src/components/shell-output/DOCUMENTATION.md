# Shell output

## Ownership

The pane renders read-only background-command output in the terminal viewport.
`shellOutputSubscription` owns its byte cursor, output chunks, status snapshot
and subscriptions. The background-shell index owns running and ended identity;
OpenCode's output endpoint owns the bytes.

## Invariants

- A reader belongs to one shell and directory. Creating it during render starts
  no work. Its first subscriber starts reading and its last subscriber cancels
  further reads and retires in-flight results.
- Subscribers share one sequential read loop. Unrelated index changes do not
  publish snapshots or restart reads.
- The first truncated page drops its partial line and labels the omitted output.
  Chunks retain stable IDs and terminal CRLF conversion.
- An ended command keeps its terminal status while remaining output drains.
  An empty final page ends polling; a not-found response retains collected output.
- The visible label is the command captured by the row that opened the pane.
  The pane keeps the existing retained-panel subscription lifetime.

## Decisions

### Why output uses a subscription-owned reader

OpenCode serves background output by byte cursor without an output event.
Polling starts at one second and quiet reads back off to four seconds. This is
network pacing, so the timing helper owns the cancellable delay. The reader
combines pages and index events before publishing a stable snapshot to React;
component effects no longer reset chunks or race terminal status.
