# Fork repository workflow

This policy applies to `jameskorzekwa/openchamber`. The default branch is
`j2k/current`. Use the actual remote default branch when preparing work rather
than assuming upstream's `main` is the fork's release branch.

## Worktree and review ownership

There is no automated controller or workspace wrapper. The interactive
session implements, reviews, and prepares the merge itself. The primary
checkout is read-only for implementation; every writing session needs its own
branch and worktree from a freshly fetched remote default branch.

Create an owned worktree, verify the change, commit, push and open a PR. Keep
the clean worktree when review is pending and the owner requests retention.
Record the review in the PR before asking for a merge; do not merge just to
complete the handoff. Follow the task's explicit scope.

## Owner-authorized merge

The owner approves every merge. Before asking, state the exact repository, PR
URL/number, base and source branches, full head SHA, tests/checks run and
their results, and every documented gate or review step not yet satisfied.
Include missing evidence and automatic on-merge effects.

Execute only after explicit informed approval for that exact repo/PR/head and
unsatisfied gates. Re-read the PR head, mergeability and check results
immediately before merging, and bind the operation to the approved head
(`gh pr merge --match-head-commit`). A changed head requires fresh approval.
Record the approval, merged head, test evidence and unsatisfied gates in the PR.

Approval covers one merge. It grants no automatic bypass or blanket future
authority, and changes no branch protection, review expectation, deployment or
verification gate. Implementation, push or PR approval alone is not merge
approval. Do not turn skipped checks into passing results or claim deployment
from a merge. Other delivery actions and issue closure retain their own
authorization and evidence requirements.

## Host-specific verification

Repository commands execute on bee2 unless a supported procedure explicitly
names another host. Mac laptop, Electron signing and iOS build instructions
remain platform-specific. A Linux server does not inherit the laptop's
credentials or display.
