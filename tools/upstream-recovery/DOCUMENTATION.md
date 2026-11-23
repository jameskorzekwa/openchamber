# Upstream recovery

## Ownership

This module reconciles the newest stable upstream release with `j2k/current`.
It creates one neutral recovery branch per upstream/source identity, starts an
OpenCode worker on bee2, and monitors its PR checks. A systemd user timer on
bee2 runs `reconcile.mjs tick` directly once a day at 08:00 UTC, and each
admitted worker gets a one-shot deadline timer for its session. GitHub
Actions checks the public heartbeat daily at 10:00 UTC, independently of bee2.

`state.json` under the configured encrypted state directory owns worker IDs,
attempts and phases. GitHub refs and exact-head PR checks own integration and
validation facts. The worker session owns conflict resolution. The owner
authorizes integration. Release workflows publish only validated maintained
HEAD, after integration.

## Invariants

- Recovery branches begin `recovery/upstream-`. Validation runs on pushes
  matching `recovery/upstream-*`, independently of PR mergeability: GitHub
  does not run pull-request validation for conflicting PRs. These runs retain
  read-only permissions; release publication remains limited to `j2k/current`.
  Workers publish only their
  branch and a PR targeting `j2k/current`.
- Discovery considers only tags fetched from upstream into `refs/tags/upstream/`.
  The newest stable tag must be an ancestor of upstream `main`. Fork-only
  tags, prereleases and tags on unmerged branches cannot nominate a release.
  The worker receives exact upstream and previous-base commit IDs.
- Every integration requires explicit owner approval for the work. Own
  completion commits do not require another confirmation. Before merging,
  check for unrelated changes and passing checks, and pin the merge to the
  checked head. There is no stored blanket approval flag.
- The publication workflow cannot move `j2k/current` to a candidate. Both
  manual and automatic release paths require `j2k/current` and verify its SHA.
- A kernel `flock` serializes ticks, launches and deadline enforcement. Atomic state
  replacement precedes every session create/prompt attempt. Caller-assigned
  IDs and inbox/message reads recover a lost HTTP response without another
  worker. A transport failure preserves those IDs. Pending admission is
  reconciled before failed PR checks can schedule another repair attempt.
- Every attempt has a 2-hour deadline, fixed when its caller-assigned IDs are
  generated and persisted with them. Before the prompt is admitted, a tick
  writes, verifies (`systemd-analyze`) and enables a one-shot user timer
  `j2k-upstream-recovery-deadline-<sessionID>.timer` and reads it back as
  active and enabled. If any step fails, no prompt is sent and the failure
  counts toward the 3 admission failures. Retrying an ambiguous admission
  re-registers the identical deadline; it never extends it. An unconfirmed
  admission past its deadline is never sent late: the attempt counts as a
  stopped worker.
- At the deadline the timer runs `reconcile.mjs deadline` for that session
  only, with no reconciliation tick and no model call. If the exact session is
  still active, the job becomes an owner-visible blocker and the session
  receives OpenCode's `interrupt?resume=false`. The timer is released only
  after the session is inactive; otherwise the unit fails and systemd retries
  it every 5 minutes, at most 4 starts in 2 hours. Its `Persistent=true` stamp
  fires the timer at boot when the deadline passed while bee2 was down.
- Active sessions prevent a competing worker. Ticks also interrupt a worker
  active past 2 hours, as a backstop for failed enforcement. Later ticks
  verify activity again; an interrupt response alone never authorizes a
  competing worker. This time-budget check precedes GitHub reads, including
  closed or merged PR handling. Worktrees remain.
- Scheduling makes no model call. A tick admits a worker (the only model
  use, default `claude-agent`/`opus`) only for an unintegrated identity that
  is due an attempt. Integrated, validating, approval-pending and blocked
  states cost no model call.
- A stopped worker without a PR gets at most 3 attempts, at most one per
  tick, so they span 3 daily ticks. Failed CI enters the same bounded repair
  path. Missing CI expires after 2 hours, observed at the next tick. Successful required CI for the
  final head reaches `awaiting-owner-approval`; session idleness cannot do so.
  Before that transition, Git fetches the exact recovery branch and maintained
  branch again, verifies both recorded SHAs, and verifies that the pinned
  upstream commit is an ancestor of the checked PR head. A mismatch becomes
  an owner blocker even when CI is green.
- Changed upstream/source identities retain prior work and mark it superseded
  only after its session is inactive. Review-pending worktrees remain.
  If an older source identity returns, its retained job becomes an explicit
  owner blocker. It cannot remain silently superseded or reuse old approval.
- Failed reads retain prior state. A corrupt state file stops reconciliation.
  A missing or malformed heartbeat, or one older than 25 hours, fails the
  GitHub watchdog and opens or updates one attention issue.
- The watchdog also surfaces owner blockers, approval requests, and missing
  or failed release runs. A failed heartbeat write fails the tick; GitHub
  subsequently observes the stale heartbeat.
- Credentials come from bee2 Secret Service inside the HTTP consumer.
  Git operations use the existing GitHub CLI authentication. No secret is
  copied into argv, environment variables, files, or output by these tools.

Worker scope relies on task instructions and owner review. Workers retain
unrestricted tools and credentials available to the existing agent runtime;
the branch instruction is not a permission sandbox. The release workflow
separately rejects candidate publication and cannot promote a candidate into
`j2k/current`.

## Linux credential mechanism

The installed adapter loads keytar 7.9.0 from
`/srv/opencode-data/jkorzekwa/app-dependencies/keytar/node_modules/keytar`.
Its Linux native module links `libsecret-1.so.0`; its imported symbols include
`secret_password_lookup_sync` and `secret_service_search_sync`. Thus keytar
uses the Linux Secret Service through libsecret. It does not route this
consumer through macOS Keychain or a separate plaintext store.

The agent-config ADR 002 specifies GNOME Keyring's D-Bus Secret Service with
libsecret and native keytar 7.9.0 compatibility. Its consumer inventory lists
the same in-process credential mechanism for `bee2-goal`. Module version,
native linkage and imported symbols were inspected without retrieving a
credential. `readPassword` retrieves only when making an authenticated
request, keeps the value in-process and bounds lookup time.

## Deployment and verification

Source changes do not install or enable the timer. Deployment approval is
separate from merge approval. Installing enables daily recovery branch/PR
writes and model usage for actionable recovery; it grants no integration or
release-dispatch authority.

After the owner approves deployment, the installing session performs these
steps. These are maintainer instructions, not a request for the owner to
carry out a sequence.

1. Use a persistent, clean, reviewed checkout of the merged `j2k/current` on
   bee2 under the encrypted state root. The unit runs `reconcile.mjs` from
   that checkout, so keep it in place while the timer is enabled; reinstall
   after moving or updating it. Verify Node, Git, `gh`, `flock`,
   `systemd-analyze`, existing GitHub authentication, OpenCode on loopback
   4097 and the user manager (`systemctl --user list-timers`).
2. Write a non-secret configuration file in encrypted state storage:

   ```json
   {
     "stateDirectory": "/srv/opencode-data/jkorzekwa/opencode/state/upstream-recovery",
     "model": { "providerID": "claude-agent", "id": "opus" }
   }
   ```

   `model` defaults to that value. Confirm the installed OpenCode server lists
   it before enabling.
3. Run the isolated regressions:

   ```sh
   node --test tools/upstream-recovery/recovery.test.mjs
   ```

   They exercise real HTTP admission against a synthetic OpenCode contract,
   daily model-call counts, deadline registration before admission and
   enforcement without a tick, real `systemd-analyze` unit and calendar
   checks in a private directory, and refusal to replace foreign units. They do not spend provider
   tokens, write GitHub or touch the user manager.
4. Preview and verify the exact units without installing them:

   ```sh
   node tools/upstream-recovery/schedule.mjs preview /absolute/recovery-config.json
   node tools/upstream-recovery/schedule.mjs verify /absolute/recovery-config.json
   ```

   `verify` runs `systemd-analyze --user verify` on the rendered
   `j2k-upstream-recovery.service` and `.timer`, and on a sample deadline
   unit pair, in a private directory and fails on any diagnostic. It also prints the next two calendar elapses.
5. With activation authorized, install and read back:

   ```sh
   node tools/upstream-recovery/schedule.mjs install /absolute/recovery-config.json
   node tools/upstream-recovery/schedule.mjs status /absolute/recovery-config.json
   ```

   `install` refuses a checkout with uncommitted recovery sources and any
   existing unit file of the same name it did not generate. It writes the two
   units to `/home/jkorzekwa/.config/systemd/user`, reloads the user manager
   and enables the timer. It reports the source commit, changed files and
   timer state. Verify `UnitFileState=enabled`, `ActiveState=active`, and
   `NextElapseUSecRealtime` at 08:00 UTC.
   For a first check before 08:00, run the service once with
   `systemctl --user start j2k-upstream-recovery.service`; it holds the same
   lock as the timer. Inspect `journalctl --user -u j2k-upstream-recovery`,
   `state.json` and the heartbeat issue.
6. When a worker is admitted, `status` lists its deadline timer; confirm its
   `NextElapseUSecRealtime` with
   `systemctl --user show j2k-upstream-recovery-deadline-<sessionID>.timer`
   equals the job's `deadlineAt` in `state.json`. Inspect the recorded
   session and neutral branch PR. Verify that the next daily tick does not launch a second worker,
   required checks appear, and the monitor reaches `awaiting-owner-approval`
   without changing maintained refs.
7. Dispatch `J2K Recovery Watchdog` once and inspect its issue permissions.
   Historical recovery workflows had issue-permission failures; a failure
   to create an issue must remain a failed Actions run, never a green monitor.
   Verify owner notifications for failed workflow runs and the attention issue.

The units carry only paths: the existing service HOME/XDG roots from
`/etc/bee2/opencode.env` and user bus `unix:path=/run/user/1000/bus`. The
reconciler reads the OpenCode password from Secret Service in-process when it
admits or inspects a worker; `gh` uses its existing credential store.

Disable with `schedule.mjs disable /absolute/recovery-config.json`. This
prevents future ticks and preserves unit files, state, active workers and
their deadline timers, which still enforce the 2-hour budget.
Inspect the recorded session before stopping any worker. The watchdog then
reports the stale heartbeat until deployment is restored or the owner also
disables that workflow. Re-enabling with `install` resumes the same state.

The outer tick wrapper has a 10-minute child timeout, inside the unit's
15-minute start timeout. A timeout or spawn failure logs a sanitized OS error
code and signal and exits nonzero. It does not write shared state or a fresh
heartbeat outside the kernel lock. The independent watchdog observes the
stale heartbeat according to the detection bounds below.

For an exhausted retry, inspect the session/PR and resolve the blocker first.
With owner approval to retry, disable the timer, confirm no worker is active,
back up `state.json`, set that job's phase to `retry` and attempts to `0`,
then re-enable. This changes recovery eligibility only. It never authorizes
integration.

## Why a systemd timer runs the reconciler, not an OpenChamber scheduled task

A scheduled task starts an agent session for every occurrence, so each check
spent a model turn only to run one command. A user timer runs the same
command with no model, its own journal and `Persistent=true` catch-up after
downtime. State transitions, leases and dispatch identity stay in
deterministic code, so a conversational response cannot mark recovery
complete, and the model is spent only on the worker that does the repair.

## Why a per-attempt deadline timer and not more frequent ticks

A daily tick alone let a worker run until the next tick, about 24 hours,
because the worker prompt's 90 minutes is an instruction, not enforcement.
More frequent ticks would add routine checks for every idle day. A
one-shot timer per attempt costs one deterministic check per admitted worker
and acts on that exact session. It is a unit file rather than a transient
`systemd-run` timer, so it survives a reboot. Registration precedes admission
so no worker exists without its deadline.

## Why one attempt per tick and not timed backoff

Exponential backoff from 15 minutes suited a 15-minute cadence. With daily
ticks it only deferred each retry to the tick after next. The daily tick is
the backoff: a failure seen in a tick is retried in that tick, at most one
attempt per tick and 3 in total.

## Why the watchdog allows 25 hours

The tick runs at 08:00 UTC and the watchdog at 10:00 UTC. A heartbeat from
the previous day's tick is at most about 24 hours old when the next tick
succeeds; a missed tick is at least 26 hours old at the 10:00 check, so it
alerts the same day. Any threshold under 24 hours would alarm daily.

## Why recovery branches have a separate prefix

The old candidate path could validate `j2k/v*` and then force-update the
maintained branch in publication. Neutral branches plus the maintained-only
release contract let CI prepare evidence without integrating it.

## Approved integration

The recovery PR is the review record for a rebased patch series. Preserve the
upstream tag's ancestry when integrating it. A squash merge of the entire PR
onto the old series would lose that ancestry and strand the next sync.

After the owner explicitly approves this recovery, the interactive integration
session re-reads `j2k/current`, the recovery PR head, and its final checks.
If the maintained series moved, incorporate that work and rerun checks before
integration. Account for every local patch and inspect the final range diff.
For a linear rebased series, promote the checked neutral-branch commit with
an explicit `--force-with-lease=refs/heads/j2k/current:<observed-current-SHA>`
ref update. This is an owner-authorized integration operation, outside both
the worker and release workflows. It must not be triggered by a label, a
successful check, the scheduler, or an unattended boolean approval flag.

For an ordinary mergeable recovery that preserves the intended ancestry and
patch-series contract, use `gh pr merge --match-head-commit <checked-head>`.
The owner approving the work covers the agent's own completion commits; ask
again only for unrelated or other-author changes. Report the integrated head,
release run and any unperformed deployment checks. Once the release completes,
the integration session closes the corresponding recovery issues and PR as
appropriate and cleans its completed worktree.

## Limitations

The timer attempts a reconciliation once a day at 08:00 UTC. A successful
tick detects inactive workers, failed checks and pending owner decisions, so
those surface up to a day after they occur. A worker's own deadline timer
interrupts it at 2 hours. If enforcement exhausts its retries (for example,
OpenCode is down), its units remain listed by `status`, and the next tick
interrupts the still-active worker as a backstop. Catch-up after a reboot
relies on the stamp systemd writes when a persistent timer starts; no reboot
was exercised. Enforcement waits up to 12 minutes for the lock; a tick that
starts while enforcement holds it is skipped, as with any concurrent tick, and
the watchdog reports the older heartbeat if no later tick succeeds. The daily
GitHub watchdog treats a heartbeat older than 25 hours as stale. Detection
can take until the next successful watchdog run, and GitHub schedule delays
can extend that interval.

Provider or API outages can stop workers. A bee2 outage stops reconciliation;
a GitHub outage or disabled Actions can stop both heartbeat publication and
alerts. Simultaneous outages can prevent notifications entirely. Delivery to
the owner's devices also depends on GitHub notification settings. These
bounds describe scheduled attempts, not guaranteed completion or delivery.

Release failures after integration become visible owner work; this module
does not repair signing infrastructure or automatically republish artifacts.
It retains superseded branches and worktrees for review. Cleanup belongs to
the approved integration session.

OpenCode HTTP shapes were checked against bee2's installed 2.3.0 OpenAPI
document. Units were checked with bee2's systemd 259 `systemd-analyze`.
Installation and actual GitHub alert delivery require separate activation
evidence.

The live worker adapter also admitted a synthetic, tool-free probe on bee2
using `openai/gpt-6-astra`. Session
`ses_0743e316d3931477ad4d6f3a123b4bc3` completed with `RECOVERY_SMOKE_OK` and
an empty changed-file snapshot. This verifies authenticated session creation,
prompt admission and a provider completion through the actual adapter.
It does not verify autonomous conflict resolution, PR publication or scheduler
activation. The default worker model `claude-agent`/`opus` has not been
probed through this adapter; that belongs to deployment evidence.
