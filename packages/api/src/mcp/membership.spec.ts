import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type { MCPAuthorizationConfig } from 'librechat-data-provider';
import { createMCPMembershipRouter } from './membership';

const SECRET = 'test-only-callback-credential-00000000000000';
let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let userId: string;
let groupId: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await runAsSystem(async () => {
    await Promise.all(['User', 'Group'].map((name) => mongoose.models[name].deleteMany({})));
  });
  const user = await mongoose.models.User.create({ email: 'reader@example.com' });
  userId = user._id.toString();
  const group = await mongoose.models.Group.create({ name: 'QM', memberIds: [userId] });
  groupId = group._id.toString();
});

function app(config?: Partial<MCPAuthorizationConfig>, secret: string | undefined = SECRET) {
  const logger = { error: jest.fn() };
  const lookup = jest.spyOn(methods, 'getMCPGroupMembership');
  const server = express();
  server.use(express.json());
  server.use(
    '/api/internal/mcp',
    createMCPMembershipRouter({
      getAppConfig: async () => ({ config: { mcpAuthorization: config } }),
      getMCPGroupMembership: methods.getMCPGroupMembership,
      runWithContext: tenantStorage.run.bind(tenantStorage),
      env: { MCP_AUTHORIZATION_API_KEY: secret },
      logger,
    }),
  );
  return { server, lookup, logger };
}

describe('internal MCP membership endpoint', () => {
  it('is disabled by default', async () => {
    const { server, lookup } = app();
    const result = await request(server).post('/api/internal/mcp/groups').send({ userId });
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('mcp_authorization_disabled');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer wrong', 'Basic ignored', `Bearer ${SECRET}, Bearer other`])(
    'rejects credentials %p before reading user data',
    async (authorization) => {
      const { server, lookup } = app({ enabled: true });
      const call = request(server).post('/api/internal/mcp/groups').send({ userId });
      if (authorization) call.set('Authorization', authorization);
      const result = await call;
      expect(result.status).toBe(401);
      expect(lookup).not.toHaveBeenCalled();
      expect(result.headers['cache-control']).toBe('no-store');
    },
  );

  it.each(['', 'too-short', ' leading-whitespace-00000000000000000000'])(
    'refuses an unconfigured or unsafe secret',
    async (secret) => {
      const { server, lookup } = app({ enabled: true }, secret);
      const result = await request(server)
        .post('/api/internal/mcp/groups')
        .set('Authorization', `Bearer ${SECRET}`)
        .send({ userId });
      expect(result.status).toBe(503);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it('returns only current stable group IDs with no cacheable response', async () => {
    const { server } = app({ enabled: true });
    const call = () =>
      request(server)
        .post('/api/internal/mcp/groups')
        .set('Authorization', `Bearer ${SECRET}`)
        .send({ userId });
    const result = await call();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ userId, tenantId: null, groupIds: [groupId] });
    expect(result.headers['cache-control']).toBe('no-store');
    await mongoose.models.Group.updateOne({ _id: groupId }, { $set: { memberIds: [] } });
    expect((await call()).body.groupIds).toEqual([]);
  });

  it('fails closed when the configured environment variable is absent', async () => {
    const { server, lookup } = app({ enabled: true, apiKeyEnv: 'MISSING_CALLBACK_KEY' });
    const result = await request(server)
      .post('/api/internal/mcp/groups')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ userId });
    expect(result.status).toBe(503);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not allow a request to select its tenant or groups', async () => {
    const { server, lookup } = app({ enabled: true });
    const result = await request(server)
      .post('/api/internal/mcp/groups')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ userId, tenantId: 'other', groupIds: ['admin'] });
    expect(result.status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('uses only the tenant pinned by the operator, ignoring incoming tenant headers', async () => {
    const { server } = app({ enabled: true, tenantId: 'pinned' });
    const result = await request(server)
      .post('/api/internal/mcp/groups')
      .set('Authorization', `Bearer ${SECRET}`)
      .set('X-Tenant-Id', 'other')
      .send({ userId });
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('mcp_authorization_user_not_found');
  });

  it('refuses a deleted account', async () => {
    const { server } = app({ enabled: true });
    await mongoose.models.User.deleteOne({ _id: userId });
    const result = await request(server)
      .post('/api/internal/mcp/groups')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ userId });
    expect(result.status).toBe(404);
  });

  it('fails closed and redacts database failures from the response and diagnostics', async () => {
    const { server, lookup, logger } = app({ enabled: true });
    lookup.mockRejectedValueOnce(
      new Error('mongodb://secret:user@private-host with Bearer credential'),
    );
    const result = await request(server)
      .post('/api/internal/mcp/groups')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ userId });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: { code: 'mcp_authorization_unavailable' } });
    expect(logger.error).toHaveBeenCalledWith('[MCP membership] Lookup failed', { type: 'Error' });
  });
});
