# Upstream recovery

## Ownership

This module reconciles the newest stable upstream release with `j2k/current`.
It creates one neutral recovery branch per upstream/source identity, starts an
OpenCode worker on bee2, and monitors its PR checks. The existing OpenChamber
scheduled-task runtime invokes `reconcile.mjs tick` every 15 minutes.
GitHub Actions checks the public heartbeat independently of bee2.

`state.json` under the configured encrypted state directory owns worker IDs,
attempts and phases. GitHub refs and exact-head PR checks own integration and
validation facts. The worker session owns conflict resolution. The owner
authorizes integration. Release workflows publish only validated maintained
HEAD, after integration.

## Invariants

- Recovery branches begin `recovery/upstream-`. Workers publish only their
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
- A kernel `flock` serializes ticks, including launches. Atomic state
  replacement precedes every session create/prompt attempt. Caller-assigned
  IDs and inbox/message reads recover a lost HTTP response without another
  worker. A transport failure preserves those IDs. Pending admission is
  reconciled before failed PR checks can schedule another repair attempt.
- Active sessions prevent a competing worker. A worker still active after
  2 hours becomes an owner-visible blocker and receives OpenCode's
  `interrupt?resume=false`. Later ticks verify activity again; an interrupt
  response alone never authorizes a competing worker. This time-budget check
  precedes GitHub reads, including closed or merged PR handling. Worktrees remain.
- A stopped worker without a PR gets at most 3 attempts with exponential
  backoff starting at 15 minutes. Failed CI enters the same bounded repair
  path. Missing CI expires after 2 hours. Successful required CI for the
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
  A missing or malformed heartbeat, or one older than 90 minutes, fails the
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

Source changes do not install or enable the task. Deployment approval is
separate from merge approval. Installing enables recovery branch/PR writes
and model usage; it grants no integration or release-dispatch authority.

After the owner approves deployment, the installing session performs these
steps. These are maintainer instructions, not a request for the owner to
carry out a sequence.

1. Use a persistent reviewed checkout on bee2. Keep it available while the
   task is enabled. Verify Node, Git, `gh`, `flock`, existing GitHub
   authentication, OpenCode on loopback 4097 and OpenChamber on 3002. The
   process must use the existing service HOME/XDG roots and user bus
   `unix:path=/run/user/1000/bus`. No new systemd unit is required.
2. Write a non-secret configuration file in encrypted state storage:

   ```json
   {
     "stateDirectory": "/srv/opencode-data/jkorzekwa/opencode/state/upstream-recovery",
     "model": { "providerID": "openai", "id": "gpt-6-astra" }
   }
   ```

   Resolve an available worker model from the installed server before
   activating. The values above illustrate the required shape.
3. Identify the existing OpenChamber project ID through its project list.
   Preview the exact scheduler request:

   ```sh
   node tools/upstream-recovery/schedule.mjs preview PROJECT_ID /absolute/recovery-config.json
   ```

4. Run the isolated regressions:

   ```sh
   node --test tools/upstream-recovery/recovery.test.mjs
   ```

   They exercise real HTTP admission against a synthetic OpenCode contract,
   including a lost prompt response, durable restart and deduplication.
   They do not spend provider tokens or write GitHub.
5. With activation authorized, enable and read back the task:

   ```sh
   node tools/upstream-recovery/schedule.mjs enable PROJECT_ID /absolute/recovery-config.json
   node tools/upstream-recovery/schedule.mjs status PROJECT_ID /absolute/recovery-config.json
   ```

   The installer reads the UI password in-process, logs in without a cookie
   file, uses the existing scheduled-task PUT endpoint, and reads it back.
   Verify `enabled`, `state.nextRunAt`, then `state.lastSessionId` and the
   heartbeat after the first scheduled occurrence.
6. Inspect the recorded worker session and neutral branch PR. Verify that a
   second tick reuses that worker, required checks appear, and the monitor
   reaches `awaiting-owner-approval` without changing maintained refs.
7. Dispatch `J2K Recovery Watchdog` once and inspect its issue permissions.
   Historical recovery workflows had issue-permission failures; a failure
   to create an issue must remain a failed Actions run, never a green monitor.
   Verify owner notifications for failed workflow runs and the attention issue.

Disable with `schedule.mjs disable PROJECT_ID /absolute/recovery-config.json`.
This prevents future ticks and preserves state and active workers. Inspect
the recorded session before stopping any worker. The watchdog then reports
the stale heartbeat until deployment is restored or the owner also disables
that workflow. Re-enabling resumes the same state.

The outer tick wrapper has a 10-minute child timeout. A timeout or spawn
failure logs a sanitized OS error code and signal and exits nonzero. It does
not write shared state or a fresh heartbeat outside the kernel lock. If
subsequent ticks also fail, the independent watchdog observes the stale
heartbeat according to the detection bounds below.

For an exhausted retry, inspect the session/PR and resolve the blocker first.
With owner approval to retry, disable the task, confirm no worker is active,
back up `state.json`, set that job's phase to `retry`, attempts to `0`, and
nextAttemptAt to `0`, then re-enable. This changes recovery eligibility only.
It never authorizes integration.

## Why the scheduler invokes a deterministic reconciler

OpenChamber already persists and claims recurring occurrences and displays
their sessions. The small scheduled agent runs one bounded command. State
transitions, leases, backoff and dispatch identity live in deterministic code
so a conversational response cannot mark recovery complete.

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

While OpenChamber is running, the scheduled task attempts a reconciliation
every 15 minutes. A successful tick detects inactive workers, failed checks
and pending owner decisions. The hourly GitHub watchdog treats a heartbeat
older than 90 minutes as stale. Detection can take until the next successful
watchdog run, and GitHub schedule delays can extend that interval.

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
document. The scheduler PUT/GET contract was checked against installed
OpenChamber 2.7.0-j2k.3 code. Installation and actual GitHub alert delivery
require separate activation evidence.

The live worker adapter also admitted a synthetic, tool-free probe on bee2
using `openai/gpt-6-astra`. Session
`ses_0743e316d3931477ad4d6f3a123b4bc3` completed with `RECOVERY_SMOKE_OK` and
an empty changed-file snapshot. This verifies authenticated session creation,
prompt admission and a provider completion through the actual adapter.
It does not verify autonomous conflict resolution, PR publication or scheduler
activation.
