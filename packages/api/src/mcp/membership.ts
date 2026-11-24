import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  mcpAuthorizationConfigSchema,
  mcpGroupCatalogQuerySchema,
  mcpGroupMembershipRequestSchema,
} from 'librechat-data-provider';
import type {
  MCPGroupCatalog,
  MCPGroupMembership,
  MCPAuthorizationConfig,
  MCPGroupCatalogPageRequest,
} from 'librechat-data-provider';
import type { AppConfig, TenantContext } from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import type { ImageImportDependencies } from './images';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createMCPImageImport } from './images';

interface MembershipDependencies {
  getAppConfig: (options: { baseOnly: true }) => Promise<Pick<AppConfig, 'config'>>;
  getMCPGroupMembership: (userId: string) => Promise<MCPGroupMembership | null>;
  getMCPGroupCatalog: (page: MCPGroupCatalogPageRequest) => Promise<MCPGroupCatalog>;
  runWithContext: <T>(context: TenantContext, action: () => Promise<T>) => Promise<T>;
  imageImport?: ImageImportDependencies;
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
 * Server-to-server group reads. The caller must authenticate LibreChat's MCP requests
 * separately before forwarding a user identity to the membership lookup.
 */
export function createMCPMembershipRouter(deps: MembershipDependencies): Router {
  const router = Router();
  function authorized(
    action: (req: Request, res: Response, config: MCPAuthorizationConfig) => Promise<void>,
    imageImport = false,
  ): RequestHandler {
    return async (req, res): Promise<void> => {
      res.set('Cache-Control', 'no-store');
      try {
        const appConfig = await deps.getAppConfig({ baseOnly: true });
        if (appConfig.config.mcpAuthorization?.enabled !== true) {
          res.status(404).json({ error: { code: 'mcp_authorization_disabled' } });
          return;
        }
        const config = mcpAuthorizationConfigSchema.parse(appConfig.config.mcpAuthorization);
        // Membership credentials grant reads only. The import is disabled without its own key.
        const imageKeyEnv =
          'imageImportApiKeyEnv' in config ? config.imageImportApiKeyEnv : undefined;
        const imageKey = typeof imageKeyEnv === 'string' ? deps.env[imageKeyEnv] : undefined;
        const activeKey = deps.env[config.apiKeyEnv];
        if (imageImport && (!imageKey || imageKey === activeKey)) {
          res.status(404).json({ error: { code: 'image_import_disabled' } });
          return;
        }
        const secret = imageImport ? imageKey : activeKey;
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
        await action(req, res, config);
      } catch (error) {
        deps.logger.error('[MCP authorization] Lookup failed', getSafeErrorMetadata(error));
        res.status(503).json({ error: { code: 'mcp_authorization_unavailable' } });
      }
    };
  }
  router.post(
    '/groups',
    authorized(async (req, res, config) => {
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
    }),
  );
  router.get(
    '/group-catalog',
    authorized(async (req, res, config) => {
      const parsed = mcpGroupCatalogQuerySchema.safeParse(req.query);
      if (!parsed.success || (parsed.data.limit ?? 0) > config.groupCatalogPageSize) {
        res.status(400).json({ error: { code: 'mcp_authorization_invalid_request' } });
        return;
      }
      const catalog = await deps.runWithContext({ tenantId: config.tenantId }, async () =>
        deps.getMCPGroupCatalog({
          limit: parsed.data.limit ?? config.groupCatalogPageSize,
          cursor: parsed.data.cursor,
        }),
      );
      res.status(200).json(catalog);
    }),
  );
  if (deps.imageImport) {
    router.post(
      '/images',
      authorized(createMCPImageImport(deps.imageImport, deps.runWithContext), true),
    );
  }
  return router;
}
