import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mcpGroupMembershipRequestSchema } from 'librechat-data-provider';
import type { MCPGroupMembership, MCPAuthorizationConfig } from 'librechat-data-provider';
import type { AppConfig, TenantContext } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { getSafeErrorMetadata } from '~/utils/errors';

interface MembershipDependencies {
  getAppConfig: (options: { baseOnly: true }) => Promise<Pick<AppConfig, 'config'>>;
  getMCPGroupMembership: (userId: string) => Promise<MCPGroupMembership | null>;
  runWithContext: <T>(context: TenantContext, action: () => Promise<T>) => Promise<T>;
  env: NodeJS.ProcessEnv;
  logger: Pick<Console, 'error'>;
}

function validServiceCredential(req: Request, secret: string): boolean {
  const authorization = req.get('authorization');
  if (!authorization || authorization.length > 1024 || !/^Bearer /i.test(authorization)) {
    return false;
  }
  const supplied = authorization.slice(7);
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(secret));
}

/**
 * Server-to-server membership lookup. The caller is trusted to identify its user; it must
 * authenticate LibreChat's MCP requests separately before forwarding that identity here.
 */
export function createMCPMembershipRouter(deps: MembershipDependencies): Router {
  const router = Router();
  router.post('/groups', async (req: Request, res: Response): Promise<void> => {
    res.set('Cache-Control', 'no-store');
    try {
      const appConfig = await deps.getAppConfig({ baseOnly: true });
      const config: Partial<MCPAuthorizationConfig> | undefined = appConfig.config.mcpAuthorization;
      if (config?.enabled !== true) {
        res.status(404).json({ error: { code: 'mcp_authorization_disabled' } });
        return;
      }
      const secret = deps.env[config.apiKeyEnv ?? 'MCP_AUTHORIZATION_API_KEY'];
      // Secrets are environment-only so neither config APIs nor logs expose them.
      if (!secret || secret.trim() !== secret || secret.length < 32 || secret.length > 512) {
        res.status(503).json({ error: { code: 'mcp_authorization_unavailable' } });
        return;
      }
      if (!validServiceCredential(req, secret)) {
        res.set('WWW-Authenticate', 'Bearer');
        res.status(401).json({ error: { code: 'mcp_authorization_unauthorized' } });
        return;
      }
      const parsed = mcpGroupMembershipRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: { code: 'mcp_authorization_invalid_request' } });
        return;
      }
      const { userId } = parsed.data;
      // The operator pins the tenant; request headers and body cannot select another one.
      const membership = await deps.runWithContext(
        { tenantId: config.tenantId, userId },
        async () => deps.getMCPGroupMembership(userId),
      );
      if (!membership) {
        res.status(404).json({ error: { code: 'mcp_authorization_user_not_found' } });
        return;
      }
      res.status(200).json(membership);
    } catch (error) {
      deps.logger.error('[MCP membership] Lookup failed', getSafeErrorMetadata(error));
      res.status(503).json({ error: { code: 'mcp_authorization_unavailable' } });
    }
  });
  return router;
}
