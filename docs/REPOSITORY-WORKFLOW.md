# Fork repository workflow

This policy applies to `jameskorzekwa/openchamber`. The default branch is
`j2k/current`. Use the actual remote default branch when preparing work rather
than assuming upstream's `main` is the fork's release branch.

## Worktree and review ownership

The default path is OPM's configured implementation, independent review and
merge pipeline. Use its workspace handoff when available. The primary checkout
is read-only for implementation; every writing session needs its own branch
and worktree from a freshly fetched remote default branch.

If OPM or its wrapper is unavailable and the owner authorizes manual preparation,
create an owned worktree, verify the change, commit, push and open a PR. Keep
the clean worktree when review is pending and the owner requests retention.
Do not enable projects, create OPM tracking issues, or merge just to complete
the handoff. Follow the task's explicit scope.

## Owner-authorized direct merge

An agent may ask the owner to approve a particular direct merge outside OPM
for any reason. This is not limited to emergencies or pipeline outages.
Before asking, state the exact repository, PR URL/number, base and source
branches, full head SHA, tests/checks run and their results, and every OPM gate
the direct path would skip or has not satisfied. Include missing evidence and
automatic on-merge effects.

Execute only after explicit informed approval for that exact repo/PR/head and
skipped gates. Re-read the PR head, mergeability and check results immediately
before merging, and bind the operation to the approved head. A changed head
requires fresh approval. Record the approval, merged head, test evidence and
skipped gates in the PR.

Approval covers one merge. It grants no automatic bypass or blanket future
authority, and changes no pipeline code, branch protection, independent-review,
deployment or verification gate. Implementation, push or PR approval alone is
not merge approval. Coordinate any active OPM writer/controller; do not alter
its enabled or paused state without authorization. Do not turn skipped checks
into passing results or claim deployment from a merge. Other delivery actions
and issue closure retain their own authorization and evidence requirements.

## Host-specific verification

Repository commands execute on bee2 unless a supported procedure explicitly
names another host. Mac laptop, Electron signing and iOS build instructions
remain platform-specific. A Linux server does not inherit the laptop's
credentials or display. Read the
[OPM notifier boundary](../packages/web/server/lib/opm-status/DOCUMENTATION.md#host-and-credential-boundary)
before claiming that a working dashboard proves Pushover delivery.
