import { isString } from '../shared/object-guards.js';
import type { Application, Request } from '../shared/http-contracts.js';
import type { ServerStatusDependencies } from './core-routes.js';

type UpdateAttestationDependencies = Pick<ServerStatusDependencies,
  'process' | 'openchamberVersion' | 'serverStartedAt' | 'getHealthSnapshot' | 'tunnelAuthController'
> & {
  openchamberBuildRevision: string;
  updateTransactionPath: string | null;
  runtimePackageRoot: string | null;
  injectedCreateRestartAttestation: ServerStatusDependencies['createRestartAttestation'];
  injectedConsumeSupervisorTermination: ServerStatusDependencies['consumeSupervisorTermination'];
};

export const registerUpdateAttestationRoutes = (app: Application, {
  process,
  openchamberVersion,
  openchamberBuildRevision,
  serverStartedAt,
  getHealthSnapshot,
  updateTransactionPath,
  runtimePackageRoot,
  injectedCreateRestartAttestation,
  injectedConsumeSupervisorTermination,
  tunnelAuthController,
}: UpdateAttestationDependencies) => {
  const isLoopbackRequest = (req: Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress || '')
    && !req.headers['x-openchamber-relay-connection']
    && !(tunnelAuthController?.classifyRequestScope && tunnelAuthController.classifyRequestScope(req) !== 'local');

  app.get('/health/update-attestation', async (req, res) => {
    if (!isLoopbackRequest(req)) return res.status(403).json({ error: 'Loopback request required' });
    const transactionId = req.headers['x-openchamber-transaction-id'];
    const challenge = req.headers['x-openchamber-attestation-challenge'];
    if (!isString(transactionId) || !isString(challenge) || !updateTransactionPath) return res.status(403).json({ error: 'Attestation request rejected' });
    try {
      const createRestartAttestation = injectedCreateRestartAttestation
        || (await import('../openchamber-update/restart-transaction.js')).createRestartAttestation;
      const health = getHealthSnapshot();
      const healthy = health.isOpenCodeReady === true
        && health.openCodeRunning === true
        && !health.lastOpenCodeError;
      const attestation = await createRestartAttestation({
        transactionPath: updateTransactionPath,
        transactionId,
        challenge,
        currentVersion: openchamberVersion,
        currentRevision: openchamberBuildRevision,
        runtimePath: runtimePackageRoot,
        pid: process.pid,
        startedAt: serverStartedAt,
        healthy,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(attestation);
    } catch {
      return res.status(403).json({ error: 'Attestation request rejected' });
    }
  });

  app.post('/health/restart-for-update', async (req, res) => {
    if (!isLoopbackRequest(req)) return res.status(403).json({ error: 'Loopback request required' });
    const transactionId = req.headers['x-openchamber-transaction-id'];
    const pidValue = req.headers['x-openchamber-process-pid'];
    const startedAt = req.headers['x-openchamber-process-started-at'];
    const nonce = req.headers['x-openchamber-termination-nonce'];
    const authorization = req.headers['x-openchamber-termination-authorization'];
    if (!isString(transactionId) || !isString(pidValue) || !isString(startedAt) || !isString(nonce) || !isString(authorization)) return res.status(403).json({ error: 'Restart authorization required' });
    const pid = Number(pidValue);
    try {
      const consumeSupervisorTermination = injectedConsumeSupervisorTermination
        || (await import('../openchamber-update/restart-transaction.js')).consumeSupervisorTermination;
      if (!updateTransactionPath) return res.status(409).json({ error: 'Managed install root is unavailable' });
      const allowed = await consumeSupervisorTermination({
        transactionPath: updateTransactionPath,
        transactionId,
        pid,
        startedAt,
        nonce,
        authorization,
        currentVersion: openchamberVersion,
        currentRevision: openchamberBuildRevision,
        actualPid: process.pid,
        actualStartedAt: serverStartedAt,
      });
      if (!allowed) return res.status(403).json({ error: 'Restart transaction rejected' });
      res.status(202).json({ accepted: true });
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100).unref?.();
    } catch {
      return res.status(403).json({ error: 'Restart transaction rejected' });
    }
  });

};
