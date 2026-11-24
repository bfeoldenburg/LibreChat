import { z } from 'zod';

/** Operator-owned callback endpoint for an internal MCP service. */
export const mcpAuthorizationConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .default('MCP_AUTHORIZATION_API_KEY'),
    /** Default and maximum requested catalog page size; hard safety ceiling: 500. */
    groupCatalogPageSize: z.number().int().min(1).max(500).default(100),
    /** Legacy YAML is accepted during upgrades. MCP image results are stored by the host. */
    imageImportApiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
      .optional(),
    /** Pins the service credential to one LibreChat tenant; absent means tenantless users. */
    tenantId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((id) => id !== '__SYSTEM__')
      .optional(),
  })
  .strict();

export type MCPAuthorizationConfig = z.infer<typeof mcpAuthorizationConfigSchema>;

export const mcpGroupMembershipRequestSchema = z
  .object({ userId: z.string().regex(/^[0-9a-f]{24}$/) })
  .strict();

/** Group metadata from LibreChat, never a grant to a particular knowledge database. */
export interface MCPGroup {
  id: string;
  name: string;
  /** Persisted source modification time in UTC ISO 8601, not the response time. */
  updatedAt: string;
}

/** Only scalar query parameters are accepted; cursors are exclusive canonical group IDs. */
export const mcpGroupCatalogQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(500))
      .optional(),
    cursor: z
      .string()
      .regex(/^[0-9a-f]{24}$/)
      .optional(),
  })
  .strict();

/** Validated, bounded page request passed to storage. */
export interface MCPGroupCatalogPageRequest {
  limit: number;
  cursor?: string;
}

export interface MCPGroupCatalog {
  tenantId: string | null;
  groups: MCPGroup[];
  /** Pass as the next request's cursor; null marks the end. */
  nextCursor: string | null;
}

/** Current memberships; both lists have the same IDs in the same order. */
export interface MCPGroupMembership {
  userId: string;
  tenantId: string | null;
  groupIds: string[];
  groups: MCPGroup[];
}
