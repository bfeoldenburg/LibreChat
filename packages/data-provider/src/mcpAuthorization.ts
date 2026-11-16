import { z } from 'zod';

/** Operator-owned callback endpoint for an internal MCP service. */
export const mcpAuthorizationConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .default('MCP_AUTHORIZATION_API_KEY'),
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

/** Current group IDs, never a grant to a particular knowledge database. */
export interface MCPGroupMembership {
  userId: string;
  tenantId: string | null;
  groupIds: string[];
}
