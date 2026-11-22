# Timing

## Ownership

This folder owns deliberate delays and their browser timer resources. Callers
own the operation and its lifecycle.

## Invariants

- `pollSubscription` waits for each read to finish before scheduling another.
  A null next delay finishes the loop.
- Disposing a polling subscription cancels the pending timer and aborts its
  signal. Readers check that signal before publishing asynchronous results.
- Polling callbacks handle their domain failures and choose whether to retry.
- `waitForDelay` resolves false on cancellation and removes its timer and abort
  listener. `requestDeadline` forwards parent cancellation to a request and
  clears its deadline timer immediately; disposal removes the parent listener.

## Decisions

### Why polling delays follow completed reads

Shell output has a cursor endpoint without push events, and update status must
recover across a server restart. Both need bounded request pacing. Scheduling
from completion prevents overlapping requests when a response is slow; moving
the delay into React rendering or an interval would make that guarantee depend
on component timing.
