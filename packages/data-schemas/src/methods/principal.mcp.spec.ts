import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
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
