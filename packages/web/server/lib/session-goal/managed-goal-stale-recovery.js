// OpenCode 2.0.21 has no assistant tool-part PATCH. Interrupting the current
// execution does not prove that a persisted orphaned task was settled.
// Keep the worker inert, including explicit scans and persisted delivery replay.
// OpenCode owns restart recovery; existing journals and holds are left intact.
const inactive = () => {};
const inactiveAsync = async () => {};

export const createManagedGoalStaleRecovery = () => ({
  supported: false,
  reason: 'OpenCode v2 does not support legacy task-part recovery',
  discoverNow: inactiveAsync,
  observe: inactive,
  scanNow: inactiveAsync,
  start: inactive,
  stop: inactive,
});
