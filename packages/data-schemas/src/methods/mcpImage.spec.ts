import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileContext, FileSources } from 'librechat-data-provider';
import { tenantStorage } from '~/config/tenantContext';
import { createMessageMethods } from './message';
import { createFileMethods } from './file';
import { createModels } from '../models';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

it('keeps both links and attaches only the display to the verified LibreChat message', async () => {
  const messages = createMessageMethods(mongoose);
  const files = createFileMethods(mongoose);
  const user = new mongoose.Types.ObjectId();
  const owner = String(user);
  const scope = { userId: owner, tenantId: 'image-test-tenant' };
  const message = { user: owner, conversationId: 'image-thread', messageId: 'image-result' };
  await tenantStorage.run(scope, async () => {
    await mongoose.models.Message.create({
      ...message,
      isCreatedByUser: false,
      text: 'Existing answer',
    });
    const association = { conversationId: message.conversationId, messageId: message.messageId };
    const target = { userId: owner, ...association };
    const shared = {
      ...association,
      user,
      source: FileSources.local,
      context: FileContext.image_generation,
      filename: 'image.png',
      bytes: 64,
      type: 'image/png',
      width: 20,
      height: 12,
    };
    const original = await files.createFile(
      {
        ...shared,
        file_id: 'original',
        filepath: '/images/original.png',
        metadata: { imageDisplayFileId: 'display' },
      },
      true,
    );
    const display = await files.createFile(
      {
        ...shared,
        file_id: 'display',
        filepath: '/images/display.png',
        metadata: { imageOriginalFileId: 'original' },
      },
      true,
    );
    expect(original?.metadata?.imageDisplayFileId).toBe('display');
    expect(display?.metadata?.imageOriginalFileId).toBe('original');
    const attachment = {
      ...shared,
      user: owner,
      object: 'file' as const,
      usage: 0,
      embedded: false,
      file_id: 'display',
      filepath: '/images/display.png',
      metadata: { imageOriginalFileId: 'original' },
    };
    expect(
      await messages.attachMCPImage({ ...target, conversationId: 'other' }, attachment, 'original'),
    ).toBe(false);
    expect(await messages.attachMCPImage(target, attachment, 'original')).toBe(true);
    expect(await messages.attachMCPImage(target, attachment, 'original')).toBe(false);
    const stored = await messages.getMessage({ user: owner, messageId: message.messageId });
    expect(stored?.files).toEqual([attachment]);
    expect(stored?.text).toBe('Existing answer');
    expect(await files.findFileById('original')).toMatchObject({ user, ...association });
  });
});
