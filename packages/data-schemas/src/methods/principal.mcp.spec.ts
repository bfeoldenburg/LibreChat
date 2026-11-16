import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createPrincipalMethods } from './principal';
import { createModels } from '~/models';

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createPrincipalMethods>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createPrincipalMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await runAsSystem(async () => {
    await Promise.all(['User', 'Group'].map((name) => mongoose.models[name].deleteMany({})));
  });
});

async function seed(idOnTheSource?: string) {
  const user = await mongoose.models.User.create({ email: 'reader@example.com', idOnTheSource });
  const userId = user._id.toString();
  const group = await mongoose.models.Group.create({
    name: 'Wissen lesen',
    memberIds: [idOnTheSource || userId],
  });
  return { userId, groupId: group._id.toString() };
}

describe('getMCPGroupMembership', () => {
  it.each([undefined, 'entra-object-id'])(
    'uses the actual membership key for %p',
    async (source) => {
      const { userId, groupId } = await seed(source);
      expect(await methods.getMCPGroupMembership(userId)).toEqual({
        userId,
        tenantId: null,
        groupIds: [groupId],
        groups: [{ id: groupId, name: 'Wissen lesen', updatedAt: expect.any(String) }],
      });
    },
  );

  it('observes committed revocations and deletions without a cached grant', async () => {
    const { userId, groupId } = await seed();
    expect((await methods.getMCPGroupMembership(userId))?.groupIds).toEqual([groupId]);
    await mongoose.models.Group.updateOne({ _id: groupId }, { $set: { memberIds: [] } });
    expect((await methods.getMCPGroupMembership(userId))?.groupIds).toEqual([]);
    await mongoose.models.User.deleteOne({ _id: userId });
    expect(await methods.getMCPGroupMembership(userId)).toBeNull();
  });

  it('does not turn ADMIN into a database grant', async () => {
    const { userId, groupId } = await seed();
    await mongoose.models.User.updateOne({ _id: userId }, { role: 'ADMIN' });
    await mongoose.models.Group.deleteOne({ _id: groupId });
    expect(await methods.getMCPGroupMembership(userId)).toEqual({
      userId,
      tenantId: null,
      groupIds: [],
      groups: [],
    });
  });

  it('rejects an account being deleted', async () => {
    const { userId } = await seed();
    await mongoose.models.User.updateOne(
      { _id: userId },
      { agentTriggerDeletionStartedAt: new Date() },
    );
    expect(await methods.getMCPGroupMembership(userId)).toBeNull();
  });

  it('never crosses tenant partitions, including an unscoped request', async () => {
    const tenantA = await tenantStorage.run({ tenantId: 'a' }, async () =>
      seed('same-external-id'),
    );
    const tenantB = await tenantStorage.run({ tenantId: 'b' }, async () =>
      seed('same-external-id'),
    );
    expect(await methods.getMCPGroupMembership(tenantA.userId)).toBeNull();
    await tenantStorage.run({ tenantId: 'a' }, async () => {
      expect(await methods.getMCPGroupMembership(tenantA.userId)).toEqual({
        userId: tenantA.userId,
        tenantId: 'a',
        groupIds: [tenantA.groupId],
        groups: [{ id: tenantA.groupId, name: 'Wissen lesen', updatedAt: expect.any(String) }],
      });
      expect(await methods.getMCPGroupMembership(tenantB.userId)).toBeNull();
    });
  });

  it.each(['invalid', '507F1F77BCF86CD799439011', '507f1f77bcf86cd799439011'])(
    'returns absence for %s',
    async (id) => {
      expect(await methods.getMCPGroupMembership(id)).toBeNull();
    },
  );
});

describe('MCP group metadata and catalog storage', () => {
  it('uses stable fallbacks for legacy groups without modification timestamps', async () => {
    const { userId, groupId } = await seed();
    const createdAt = new Date('2020-01-02T03:04:05.000Z');
    await mongoose.models.Group.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(groupId) },
      { $unset: { updatedAt: '' }, $set: { createdAt } },
    );
    let catalog = await methods.getMCPGroupCatalog({ limit: 10 });
    expect(catalog.groups[0].updatedAt).toBe(createdAt.toISOString());
    expect((await methods.getMCPGroupMembership(userId))?.groups).toEqual(catalog.groups);
    await mongoose.models.Group.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(groupId) },
      { $unset: { createdAt: '' } },
    );
    catalog = await methods.getMCPGroupCatalog({ limit: 10 });
    expect(catalog.groups[0].updatedAt).toBe(
      new mongoose.Types.ObjectId(groupId).getTimestamp().toISOString(),
    );
    expect((await methods.getMCPGroupMembership(userId))?.groups).toEqual(catalog.groups);
    const renamed = await mongoose.models.Group.findOneAndUpdate(
      { _id: groupId },
      { name: 'Neuer Name' },
      { new: true },
    );
    expect((await methods.getMCPGroupCatalog({ limit: 10 })).groups[0]).toEqual({
      id: groupId,
      name: 'Neuer Name',
      updatedAt: renamed.updatedAt.toISOString(),
    });
  });

  it('fails closed for invalid persisted group metadata', async () => {
    const { userId, groupId } = await seed();
    await mongoose.models.Group.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(groupId) },
      { $unset: { name: '' } },
    );
    await expect(methods.getMCPGroupMembership(userId)).rejects.toThrow(TypeError);
    await expect(methods.getMCPGroupCatalog({ limit: 10 })).rejects.toThrow(TypeError);
  });

  it.each([
    { limit: 0 },
    { limit: 501 },
    { limit: NaN },
    { limit: 1.5 },
    { limit: 1, cursor: 'invalid' },
    { limit: 1, cursor: '507F1F77BCF86CD799439011' },
  ])('rejects unbounded or invalid storage pagination: %p', async (page) => {
    const find = jest.spyOn(mongoose.models.Group, 'find');
    await expect(methods.getMCPGroupCatalog(page)).rejects.toThrow(TypeError);
    expect(find).not.toHaveBeenCalled();
  });

  it('refuses unscoped primary reads in strict tenant mode', async () => {
    const { userId } = await seed();
    const strict = process.env.TENANT_ISOLATION_STRICT;
    process.env.TENANT_ISOLATION_STRICT = 'true';
    _resetStrictCache();
    try {
      await expect(methods.getMCPGroupMembership(userId)).rejects.toThrow();
      await expect(methods.getMCPGroupCatalog({ limit: 10 })).rejects.toThrow();
      await tenantStorage.run({ tenantId: 'a' }, async () => {
        const own = await seed('tenant-user');
        const catalog = await methods.getMCPGroupCatalog({ limit: 10 });
        expect(catalog.tenantId).toBe('a');
        expect(catalog.groups.map((group) => group.id)).toEqual([own.groupId]);
        expect((await methods.getMCPGroupMembership(own.userId))?.groups).toEqual(catalog.groups);
      });
    } finally {
      if (strict === undefined) delete process.env.TENANT_ISOLATION_STRICT;
      else process.env.TENANT_ISOLATION_STRICT = strict;
      _resetStrictCache();
    }
  });
});
