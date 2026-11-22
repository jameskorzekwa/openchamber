import { isString } from '../shared/object-guards.js';
import type { Request, Response } from '../shared/http-contracts.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type { createTunnelAuth } from '../tunnels/tunnel-auth.js';
import type { RouteInput } from './core-routes.js';

type UiAuthController = ReturnType<typeof createUiAuth>;
type TunnelAuthController = ReturnType<typeof createTunnelAuth>;

interface RequestAuthorizationDependencies {
  tunnelAuthController: TunnelAuthController | null;
  uiAuthController: UiAuthController | null;
}

export const parseLoopbackUrl = (rawUrl: RouteInput['url']) => {
  if (!isString(rawUrl)) {
    return null;
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const host = url.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '0.0.0.0') {
    return null;
  }

  return url;
};

export const isRequestAuthorized = async (req: Request, res: Response, { tunnelAuthController, uiAuthController }: RequestAuthorizationDependencies) => {
  const scope = tunnelAuthController?.classifyRequestScope?.(req);
  if (scope === 'tunnel' || scope === 'unknown-public') {
    return Boolean(tunnelAuthController?.getTunnelSessionFromRequest(req));
  }
  if (!uiAuthController) return false;
  return Boolean(await uiAuthController.resolveAuthContext(req, res, { allowUrlToken: false }));
};
