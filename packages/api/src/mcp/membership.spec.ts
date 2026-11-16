import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type { MCPGroup, MCPAuthorizationConfig } from 'librechat-data-provider';
import type { Response } from 'supertest';
import { createMCPMembershipRouter } from './membership';

const SECRET = 'test-only-callback-credential-00000000000000';
const GROUPS = '/api/internal/mcp/groups';
const CATALOG = '/api/internal/mcp/group-catalog';
let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let userId: string;
let groupId: string;
let updatedAt: string;

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
  updatedAt = group.updatedAt.toISOString();
});

function app(config?: Partial<MCPAuthorizationConfig>, secret: string | undefined = SECRET) {
  const logger = { error: jest.fn() };
  const lookup = jest.spyOn(methods, 'getMCPGroupMembership');
  const catalog = jest.spyOn(methods, 'getMCPGroupCatalog');
  const getAppConfig = jest.fn(async () => ({ config: { mcpAuthorization: config } }));
  const server = express();
  server.use(express.json());
  server.use(
    '/api/internal/mcp',
    createMCPMembershipRouter({
      getAppConfig,
      getMCPGroupMembership: methods.getMCPGroupMembership,
      getMCPGroupCatalog: methods.getMCPGroupCatalog,
      runWithContext: tenantStorage.run.bind(tenantStorage),
      env: { MCP_AUTHORIZATION_API_KEY: secret },
      logger,
    }),
  );
  return { server, lookup, catalog, getAppConfig, logger };
}

function call(server: express.Express, endpoint: string) {
  return endpoint === GROUPS
    ? request(server).post(endpoint).send({ userId })
    : request(server).get(endpoint);
}

describe.each([GROUPS, CATALOG])('internal MCP endpoint %s', (endpoint) => {
  it('is disabled by default and when explicitly disabled', async () => {
    for (const config of [undefined, { enabled: false }]) {
      const { server, lookup, catalog } = app(config);
      const result = await call(server, endpoint);
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: { code: 'mcp_authorization_disabled' } });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(lookup).not.toHaveBeenCalled();
      expect(catalog).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, 'Bearer wrong', 'Basic ignored', `Bearer ${SECRET}, Bearer other`])(
    'rejects credentials %p before reading group or user data',
    async (authorization) => {
      const { server, lookup, catalog } = app({ enabled: true });
      const pending = call(server, endpoint);
      if (authorization) pending.set('Authorization', authorization);
      const result = await pending;
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: { code: 'mcp_authorization_unauthorized' } });
      expect(lookup).not.toHaveBeenCalled();
      expect(catalog).not.toHaveBeenCalled();
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers['www-authenticate']).toBe('Bearer');
    },
  );

  it.each(['', 'too-short', ' leading-whitespace-00000000000000000000', 'x'.repeat(513)])(
    'refuses an unconfigured or unsafe secret',
    async (secret) => {
      const { server, lookup, catalog, logger } = app({ enabled: true }, secret);
      const result = await call(server, endpoint).set('Authorization', `Bearer ${SECRET}`);
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: { code: 'mcp_authorization_unavailable' } });
      expect(lookup).not.toHaveBeenCalled();
      expect(catalog).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the configured environment variable is absent', async () => {
    const { server, lookup, catalog } = app({ enabled: true, apiKeyEnv: 'MISSING_CALLBACK_KEY' });
    const result = await call(server, endpoint).set('Authorization', `Bearer ${SECRET}`);
    expect(result.status).toBe(503);
    expect(lookup).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
  });

  it('loads only the operator config', async () => {
    const { server, getAppConfig } = app({ enabled: true });
    expect((await call(server, endpoint).set('Authorization', `Bearer ${SECRET}`)).status).toBe(
      200,
    );
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it.each(['database', 'configuration'])(
    'redacts %s failures from responses and logs',
    async (failure) => {
      const { server, getAppConfig, logger } = app({ enabled: true });
      const error = new Error(`mongodb://secret:user@private-host Bearer ${SECRET}`);
      if (failure === 'database') {
        jest.spyOn(mongoose.models.Group, 'find').mockImplementationOnce(() => {
          throw error;
        });
      } else {
        getAppConfig.mockRejectedValueOnce(error);
      }
      const result = await call(server, endpoint).set('Authorization', `Bearer ${SECRET}`);
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: { code: 'mcp_authorization_unavailable' } });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(logger.error.mock.calls).toEqual([
        ['[MCP authorization] Lookup failed', { type: 'Error' }],
      ]);
      expect(JSON.stringify([result.body, logger.error.mock.calls])).not.toMatch(
        /secret|private-host|Bearer/,
      );
    },
  );
});

describe('MCP membership metadata', () => {
  it('returns matching IDs and names and immediately observes revocation', async () => {
    const { server } = app({ enabled: true });
    const read = () => call(server, GROUPS).set('Authorization', `Bearer ${SECRET}`);
    const result = await read();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      userId,
      tenantId: null,
      groupIds: [groupId],
      groups: [{ id: groupId, name: 'QM', updatedAt }],
    });
    expect(result.headers['cache-control']).toBe('no-store');
    await mongoose.models.Group.updateOne({ _id: groupId }, { $set: { memberIds: [] } });
    expect((await read()).body).toEqual({ userId, tenantId: null, groupIds: [], groups: [] });
  });

  it('resolves external identities for both local and external groups', async () => {
    await mongoose.models.User.updateOne({ _id: userId }, { idOnTheSource: 'entra-user' });
    await mongoose.models.Group.updateOne({ _id: groupId }, { memberIds: ['entra-user'] });
    const external = await mongoose.models.Group.create({
      name: 'Externe Gruppe',
      source: 'entra',
      idOnTheSource: 'entra-group',
      memberIds: ['entra-user'],
    });
    const { server } = app({ enabled: true });
    const result = await call(server, GROUPS).set('Authorization', `Bearer ${SECRET}`);
    expect(result.status).toBe(200);
    expect(result.body.groupIds).toEqual([groupId, external._id.toString()].sort());
    expect(result.body.groups).toEqual([
      { id: groupId, name: 'QM', updatedAt: expect.any(String) },
      {
        id: external._id.toString(),
        name: 'Externe Gruppe',
        updatedAt: external.updatedAt.toISOString(),
      },
    ]);
    expect(result.body.groups.map((group: MCPGroup) => group.id)).toEqual(result.body.groupIds);
  });

  it('does not allow a request to select its tenant or groups', async () => {
    const { server, lookup } = app({ enabled: true });
    const result = await request(server)
      .post(GROUPS)
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ userId, tenantId: 'other', groupIds: ['admin'] });
    expect(result.status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'deleting'])('refuses a %s account', async (state) => {
    const { server } = app({ enabled: true });
    if (state === 'deleted') await mongoose.models.User.deleteOne({ _id: userId });
    else
      await mongoose.models.User.updateOne(
        { _id: userId },
        { agentTriggerDeletionStartedAt: new Date() },
      );
    expect((await call(server, GROUPS).set('Authorization', `Bearer ${SECRET}`)).status).toBe(404);
  });
});

describe('MCP group catalog', () => {
  it('includes groups with no members, without personal or member data', async () => {
    await mongoose.models.Group.deleteMany({});
    const empty = await mongoose.models.Group.create({
      name: 'Ohne Mitglieder',
      memberIds: [],
      email: 'private@example.com',
      description: 'Private data',
    });
    const { server, lookup } = app({ enabled: true });
    const result = await call(server, CATALOG).set('Authorization', `Bearer ${SECRET}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      tenantId: null,
      nextCursor: null,
      groups: [
        {
          id: empty._id.toString(),
          name: 'Ohne Mitglieder',
          updatedAt: empty.updatedAt.toISOString(),
        },
      ],
    });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(lookup).not.toHaveBeenCalled();
    await mongoose.models.Group.deleteOne({ _id: empty._id });
    expect((await call(server, CATALOG).set('Authorization', `Bearer ${SECRET}`)).body).toEqual({
      tenantId: null,
      groups: [],
      nextCursor: null,
    });
  });

  it('uses the persisted source timestamp for renames in both endpoints', async () => {
    const { server } = app({ enabled: true });
    const later = new Date(Date.parse(updatedAt) + 1000);
    await mongoose.models.Group.updateOne(
      { _id: groupId },
      { $set: { name: 'Qualitätsmanagement', updatedAt: later } },
      { timestamps: false },
    );
    for (const endpoint of [GROUPS, CATALOG]) {
      const result = await call(server, endpoint).set('Authorization', `Bearer ${SECRET}`);
      expect(result.body.groups).toEqual([
        { id: groupId, name: 'Qualitätsmanagement', updatedAt: later.toISOString() },
      ]);
    }
    const again = await call(server, CATALOG).set('Authorization', `Bearer ${SECRET}`);
    expect(again.body.groups[0].updatedAt).toBe(later.toISOString());
  });

  it.each([1, 2, 3])('traverses every group exactly once with page size %i', async (limit) => {
    const ids = [groupId];
    for (let index = 5; index > 0; index--) {
      const group = await mongoose.models.Group.create({
        _id: index.toString(16).padStart(24, '0'),
        name: 'Gleicher Name',
        memberIds: [],
      });
      ids.push(group._id.toString());
    }
    const { server } = app({ enabled: true });
    const groups: MCPGroup[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < ids.length + 1; page++) {
      const result: Response = await request(server)
        .get(CATALOG)
        .query({ limit, ...(cursor ? { cursor } : {}) })
        .set('Authorization', `Bearer ${SECRET}`);
      expect(result.status).toBe(200);
      expect(result.body.groups.length).toBeLessThanOrEqual(limit);
      groups.push(...result.body.groups);
      cursor = result.body.nextCursor;
      if (cursor === null) break;
      expect(cursor).toBe(result.body.groups.at(-1).id);
    }
    expect(cursor).toBeNull();
    expect(groups.map((group) => group.id)).toEqual(ids.sort());
    expect(new Set(groups.map((group) => group.id)).size).toBe(ids.length);
  });

  it('continues after a cursor group is renamed and deleted', async () => {
    const first = await mongoose.models.Group.create({
      _id: '000000000000000000000001',
      name: 'First',
    });
    const { server } = app({ enabled: true });
    const firstPage = await request(server)
      .get(CATALOG)
      .query({ limit: 1 })
      .set('Authorization', `Bearer ${SECRET}`);
    expect(firstPage.body.nextCursor).toBe(first._id.toString());
    await mongoose.models.Group.updateOne({ _id: first._id }, { name: 'Renamed' });
    await mongoose.models.Group.deleteOne({ _id: first._id });
    const next = await request(server)
      .get(CATALOG)
      .query({ limit: 1, cursor: firstPage.body.nextCursor })
      .set('Authorization', `Bearer ${SECRET}`);
    expect(next.body.groups.map((group: MCPGroup) => group.id)).toEqual([groupId]);
    expect(next.body.nextCursor).toBeNull();
  });

  it('uses the operator page size as both default and request ceiling', async () => {
    await mongoose.models.Group.create({ name: 'Second' });
    const { server, catalog } = app({ enabled: true, groupCatalogPageSize: 1 });
    const result = await call(server, CATALOG).set('Authorization', `Bearer ${SECRET}`);
    expect(result.status).toBe(200);
    expect(result.body.groups).toHaveLength(1);
    expect(result.body.nextCursor).not.toBeNull();
    expect(catalog).toHaveBeenCalledWith({ limit: 1, cursor: undefined });
    const invalid = await request(server)
      .get(CATALOG)
      .query({ limit: 2 })
      .set('Authorization', `Bearer ${SECRET}`);
    expect(invalid.status).toBe(400);
    expect(catalog).toHaveBeenCalledTimes(1);
  });

  it.each([
    'limit=0',
    'limit=-1',
    'limit=1.5',
    'limit=01',
    'limit=1e2',
    'limit=501',
    'limit=9999999999999999',
    'limit=',
    'limit=1&limit=2',
    'limit[$gt]=1',
    'cursor=',
    'cursor=not-an-id',
    'cursor=507F1F77BCF86CD799439011',
    'cursor=000000000000000000000001&cursor=000000000000000000000002',
    'cursor[$gt]=0',
    'tenantId=other',
    'userId=507f1f77bcf86cd799439011',
    'offset=1',
  ])('rejects invalid pagination or scope parameters: %s', async (query) => {
    const { server, catalog } = app({ enabled: true });
    const result = await request(server)
      .get(`${CATALOG}?${query}`)
      .set('Authorization', `Bearer ${SECRET}`);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: { code: 'mcp_authorization_invalid_request' } });
    expect(catalog).not.toHaveBeenCalled();
  });
});

describe('MCP partition isolation', () => {
  it.each([undefined, 'a', 'b'])('pins both endpoints to operator tenant %p', async (tenantId) => {
    const partitions: { tenantId?: string; userId: string; groupId: string }[] = [
      { tenantId: undefined, userId, groupId },
    ];
    for (const tenant of ['a', 'b']) {
      partitions.push(
        await tenantStorage.run({ tenantId: tenant }, async () => {
          const user = await mongoose.models.User.create({
            email: 'same@example.com',
            idOnTheSource: 'same-source-id',
          });
          const group = await mongoose.models.Group.create({
            name: tenant,
            memberIds: ['same-source-id'],
          });
          return { tenantId: tenant, userId: user._id.toString(), groupId: group._id.toString() };
        }),
      );
    }
    const { server } = app({ enabled: true, tenantId });
    const own = partitions.find((partition) => partition.tenantId === tenantId)!;
    const catalog = await request(server)
      .get(CATALOG)
      .set('Authorization', `Bearer ${SECRET}`)
      .set('X-Tenant-Id', 'other')
      .set('X-LibreChat-Tenant-ID', 'other');
    expect(catalog.status).toBe(200);
    expect(catalog.body.tenantId).toBe(tenantId ?? null);
    expect(catalog.body.groups.map((group: MCPGroup) => group.id)).toEqual([own.groupId]);
    for (const partition of partitions) {
      const result = await request(server)
        .post(GROUPS)
        .set('Authorization', `Bearer ${SECRET}`)
        .set('X-Tenant-Id', 'other')
        .send({ userId: partition.userId });
      expect(result.status).toBe(partition === own ? 200 : 404);
      if (partition === own) {
        expect(result.body.tenantId).toBe(tenantId ?? null);
        expect(result.body.groupIds).toEqual([own.groupId]);
        expect(result.body.groups).toEqual(catalog.body.groups);
      }
    }
    const foreign = partitions.find((partition) => partition !== own)!;
    const cursor = await request(server)
      .get(CATALOG)
      .query({ cursor: foreign.groupId })
      .set('Authorization', `Bearer ${SECRET}`)
      .set('X-Tenant-Id', foreign.tenantId ?? '');
    expect(cursor.status).toBe(200);
    expect(cursor.body.groups.every((group: MCPGroup) => group.id === own.groupId)).toBe(true);
  });
});
