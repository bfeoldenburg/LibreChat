import { mcpAuthorizationConfigSchema, mcpGroupMembershipRequestSchema } from './mcpAuthorization';
import { configSchema, BASE_ONLY_CONFIG_SECTIONS } from './config';

describe('internal MCP authorization configuration', () => {
  it('requires operator opt-in and keeps the credential in an environment variable', () => {
    expect(configSchema.parse({ version: '1.3.18' }).mcpAuthorization).toBeUndefined();
    expect(
      configSchema.parse({ version: '1.3.18', mcpAuthorization: {} }).mcpAuthorization,
    ).toEqual({
      enabled: false,
      apiKeyEnv: 'MCP_AUTHORIZATION_API_KEY',
    });
    expect(BASE_ONLY_CONFIG_SECTIONS).toContain('mcpAuthorization');
  });

  it.each([
    { enabled: 'true' },
    { apiKeyEnv: '' },
    { apiKeyEnv: '${SECRET}' },
    { apiKey: 'plaintext-secret' },
    { tenantId: '' },
    { tenantId: '   ' },
    { tenantId: '__SYSTEM__' },
    { enabled: true, allowAll: true },
  ])('rejects an unsafe configuration: %p', (config) => {
    expect(mcpAuthorizationConfigSchema.safeParse(config).success).toBe(false);
  });

  it('accepts a pinned tenant and a dedicated secret variable', () => {
    expect(
      mcpAuthorizationConfigSchema.parse({
        enabled: true,
        apiKeyEnv: 'KB_CALLBACK_KEY',
        tenantId: 'bfe',
      }),
    ).toEqual({ enabled: true, apiKeyEnv: 'KB_CALLBACK_KEY', tenantId: 'bfe' });
  });

  it.each([
    { userId: { $ne: null } },
    { userId: '507F1F77BCF86CD799439011' },
    { userId: '507f1f77bcf86cd799439011', tenantId: 'another-tenant' },
    { userId: '507f1f77bcf86cd799439011', groupIds: ['admin'] },
    {},
  ])('refuses caller-provided permissions or invalid identities: %p', (body) => {
    expect(mcpGroupMembershipRequestSchema.safeParse(body).success).toBe(false);
  });
});
