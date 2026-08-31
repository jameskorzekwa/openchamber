import { describe, expect, it, vi } from 'vitest';
import { createBootstrapRuntime } from './bootstrap-runtime.js';

describe('bootstrap runtime OpenChamber version wiring', () => {
  it('passes the exact version to status and update routes', () => {
    const registerServerStatusRoutes = vi.fn();
    const registerOpenChamberRoutes = vi.fn();
    const registerCommonRequestMiddleware = vi.fn();
    const registerAuthAndAccessRoutes = vi.fn();
    const registerTtsRoutes = vi.fn();
    const registerNotificationRoutes = vi.fn();
    const runtime = createBootstrapRuntime({
      createUiAuth: () => ({ enabled: false }),
      registerServerStatusRoutes,
      registerCommonRequestMiddleware,
      registerAuthAndAccessRoutes,
      registerTtsRoutes,
      registerNotificationRoutes,
      registerOpenChamberRoutes,
      express: {},
    });
    const sessionRuntime = new Proxy({}, { get: () => vi.fn() });
    runtime.setupBaseRoutes({}, {
      process: {},
      openchamberVersion: '1.21.0-j2k.7',
      sessionRuntime,
      fs: {},
      os: {},
      path: {},
      server: {},
    });

    expect(registerServerStatusRoutes).toHaveBeenCalledWith({}, expect.objectContaining({ openchamberVersion: '1.21.0-j2k.7' }));
    expect(registerOpenChamberRoutes).toHaveBeenCalledWith({}, expect.objectContaining({ openchamberVersion: '1.21.0-j2k.7' }));
  });
});
