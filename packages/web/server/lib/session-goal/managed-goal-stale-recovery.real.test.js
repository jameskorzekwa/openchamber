import { expect, test } from 'vitest';
import { createManagedGoalStaleRecovery } from './managed-goal-stale-recovery.js';

// The former fixture launched v1.18.29 and PATCHed task parts. That protocol
// cannot validate the pinned v2 worker. In particular, OPENCODE_REAL_TEST must
// not opt back into that mutation path or launch an old server here.
test('legacy restart recovery is unavailable on pinned OpenCode v2', async () => {
  const worker = createManagedGoalStaleRecovery({
    openCodeFetch: () => { throw new Error('legacy recovery must not contact OpenCode'); },
  });
  expect(worker.supported).toBe(false);
  worker.start();
  await worker.discoverNow();
  await worker.scanNow();
  worker.stop();
});
