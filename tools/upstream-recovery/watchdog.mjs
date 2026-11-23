// bee2 ticks daily at 08:00 UTC and this watchdog runs daily at 10:00 UTC, so a
// missed tick is at least 26 hours old when checked.
export const STALE_AFTER_MS = 25 * 60 * 60_000;

export function attentionReason(body, now = Date.now()) {
  if (!body) return 'bee2 recovery heartbeat is missing.';
  try {
    const summary = JSON.parse(body.match(/```json\n([\s\S]*?)\n```/)?.[1] || 'null');
    if (summary?.schema !== 1 || !Number.isFinite(summary.checkedAt) || !Array.isArray(summary.jobs)) {
      return 'bee2 recovery heartbeat is malformed.';
    }
    if (now - summary.checkedAt > STALE_AFTER_MS || summary.checkedAt > now + 5 * 60_000) {
      return 'bee2 recovery heartbeat is stale or its clock is invalid.';
    }
    if (summary.error) return summary.error;
    return summary.jobs.filter((job) => ['owner-blocked', 'awaiting-owner-approval'].includes(job.phase))
      .map((job) => `${job.tag}: ${job.phase}. ${job.pr || ''} ${job.reason || ''}`).join('\n');
  } catch {
    return 'bee2 recovery heartbeat is malformed.';
  }
}

export async function watchdog(github, repo, now = Date.now()) {
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...repo, state: 'all', per_page: 100 });
  const monitor = issues.find((issue) => !issue.pull_request && issue.title === 'Upstream recovery monitor'
    && issue.user?.login === 'jameskorzekwa');
  const alert = issues.find((issue) => !issue.pull_request && issue.title === 'Upstream recovery needs attention'
    && ['jameskorzekwa', 'github-actions[bot]'].includes(issue.user?.login));
  const reason = attentionReason(monitor?.body, now);
  if (reason) {
    const body = `${reason}\n\nMonitor: ${monitor?.html_url || 'not published'}\n\n@jameskorzekwa Every integration requires explicit owner approval. Inspect the recovery PR or bee2 session before proceeding.`;
    if (!alert) await github.rest.issues.create({ ...repo, title: 'Upstream recovery needs attention', body });
    else if (alert.body !== body || alert.state === 'closed') {
      await github.rest.issues.update({ ...repo, issue_number: alert.number, body, state: 'open' });
    }
  } else if (alert?.state === 'open') {
    await github.rest.issues.update({ ...repo, issue_number: alert.number, state: 'closed', state_reason: 'completed' });
  }
  return reason;
}
