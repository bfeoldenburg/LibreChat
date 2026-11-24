import sharp from 'sharp';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@librechat/data-schemas';
import type { ImageImportDependencies } from './images';
import { createMCPMembershipRouter } from './membership';

const OWNER = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const CONVO = 'conversation';
const MESSAGE = 'result';
const READ_KEY = 'membership-only-test-key-12345678901234';
const WRITE_KEY = 'storage-only-test-key-1234567890123456';

function harness(preserveOriginal: boolean) {
  type File = NonNullable<Awaited<ReturnType<ImageImportDependencies['findFileById']>>>;
  type Message = NonNullable<Awaited<ReturnType<ImageImportDependencies['getMessage']>>>;
  const files = new Map<string, File>();
  const buffers = new Map<string, Buffer>();
  const message: Message = { conversationId: CONVO, isCreatedByUser: false, files: [] };
  const savePreparedImage: ImageImportDependencies['savePreparedImage'] = async (
    image,
    options,
  ) => {
    const { file_id, association, req, context, filename } = options;
    if (filename === 'image-display' && !state.saveDisplay) {
      throw new Error('test storage failure');
    }
    const file: File = {
      ...association,
      context,
      file_id,
      user: req.user.id,
      tenantId: req.user.tenantId,
      filename,
      filepath: '/images/' + req.user.id + '/' + file_id,
      width: image.width,
      height: image.height,
      source: 'local',
      type: image.type ?? 'image/png',
      bytes: image.bytes,
    };
    files.set(file_id, file);
    buffers.set(file_id, image.buffer);
    return file;
  };
  const attachMCPImage: ImageImportDependencies['attachMCPImage'] = async (target, image) => {
    expect(target).toEqual({ userId: OWNER, conversationId: CONVO, messageId: MESSAGE });
    if (!state.attach) return false;
    message.files?.push(image);
    return true;
  };
  const config = { enabled: true, imageImportApiKeyEnv: 'TEST_IMAGE_KEY' };
  const state = {
    attach: true,
    saveDisplay: true,
    files,
    buffers,
    message,
    fileId: randomUUID(),
    config,
  };
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use(
    '/api/internal/mcp',
    createMCPMembershipRouter({
      getAppConfig: async () => ({
        config: {
          mcpAuthorization: {
            ...config,
            apiKeyEnv: 'MCP_AUTHORIZATION_API_KEY',
            groupCatalogPageSize: 100,
          },
        },
      }),
      getMCPGroupMembership: async () => null,
      getMCPGroupCatalog: async () => ({ tenantId: null, groups: [], nextCursor: null }),
      runWithContext: (_context, action) => action(),
      env: { MCP_AUTHORIZATION_API_KEY: READ_KEY, TEST_IMAGE_KEY: WRITE_KEY },
      logger: { error: jest.fn() },
      imageImport: {
        findPrincipalUser: async (id) => ({ id }),
        getMessage: async ({ user, messageId }) =>
          user === OWNER && messageId === MESSAGE ? message : null,
        getStorageConfig: async () =>
          ({ fileConfig: { imageGeneration: { preserveOriginal } } }) as AppConfig,
        findFileById: async (id) => files.get(id) ?? null,
        attachMCPImage,
        savePreparedImage,
        readStoredImage: async (_req, file) => Readable.from([buffers.get(file.file_id)]),
        resizeImageBuffer: async (buffer) => {
          const output = await sharp(buffer)
            .rotate()
            .resize(8)
            .png()
            .toBuffer({ resolveWithObject: true });
          return {
            buffer: output.data,
            bytes: output.data.length,
            type: 'image/png',
            width: output.info.width,
            height: output.info.height,
          };
        },
        logger: { error: jest.fn() },
      },
    }),
  );
  return {
    ...state,
    setSaveDisplay: (value: boolean) => {
      state.saveDisplay = value;
    },
    setAttach: (value: boolean) => {
      state.attach = value;
    },
    post: (input: Buffer, mime: string, key = WRITE_KEY, user = OWNER, conversation = CONVO) =>
      request(app)
        .post('/api/internal/mcp/images')
        .set('Authorization', 'Bearer ' + key)
        .set('Content-Type', 'application/octet-stream')
        .set('X-LibreChat-User-ID', user)
        .set('X-LibreChat-Conversation-ID', conversation)
        .set('X-LibreChat-Message-ID', MESSAGE)
        .set('X-LibreChat-File-ID', state.fileId)
        .set('X-Image-Mime-Type', mime)
        .send(input),
  };
}

function pixels() {
  return sharp({ create: { width: 20, height: 12, channels: 3, background: 'red' } });
}

it('saves the original bytes once and associates the native image with the real result', async () => {
  const h = harness(true);
  const input = await pixels().png().toBuffer();
  const result = await h.post(input, 'image/png').expect(200);
  expect(result.body).toEqual({
    delivery_status: 'stored',
    file_id: h.fileId,
    display_file_id: h.fileId,
  });
  expect(h.buffers.get(h.fileId)).toEqual(input);
  expect(h.files.get(h.fileId)).toMatchObject({
    user: OWNER,
    conversationId: CONVO,
    messageId: MESSAGE,
    bytes: input.length,
  });
  await h.post(input, 'image/png').expect(200);
  expect(h.files.size).toBe(1);
  expect(h.message.files).toEqual([expect.objectContaining({ file_id: h.fileId })]);
});

it.each([false, true])('keeps a distinct linked display (TIFF fallback %s)', async (tiff) => {
  const h = harness(tiff);
  const input = await (
    tiff ? pixels().tiff() : pixels().withMetadata({ orientation: 6 }).jpeg()
  ).toBuffer();
  const response = await h.post(input, tiff ? 'image/tiff' : 'image/jpeg').expect(200);
  const id: string = response.body.display_file_id;
  expect(id).not.toBe(h.fileId);
  expect(h.buffers.get(h.fileId)).toEqual(input);
  expect(h.buffers.get(id)).not.toEqual(input);
  expect(h.files.get(h.fileId)?.metadata?.imageDisplayFileId).toBe(id);
  expect(h.files.get(id)).toMatchObject({
    user: OWNER,
    conversationId: CONVO,
    messageId: MESSAGE,
    type: 'image/png',
    metadata: { imageOriginalFileId: h.fileId },
  });
  expect(h.message.files).toEqual([expect.objectContaining({ file_id: id })]);
});

it('rejects read credentials, a foreign owner, a different chat and an invalid image', async () => {
  const h = harness(true);
  const input = await pixels().png().toBuffer();
  await h.post(input, 'image/png', READ_KEY).expect(401);
  await h.post(input, 'image/png', WRITE_KEY, OTHER).expect(404);
  await h.post(input, 'image/png', WRITE_KEY, OWNER, 'other-chat').expect(404);
  await h.post(input, 'image/jpeg').expect(422);
  expect(h.files.size).toBe(0);
});

it('acknowledges only after attachment and reuses saved files on retry', async () => {
  const h = harness(false);
  const input = await pixels().png().toBuffer();
  h.setAttach(false);
  await h.post(input, 'image/png').expect(409);
  expect(h.message.files).toHaveLength(0);
  h.setAttach(true);
  await h.post(input, 'image/png').expect(200);
  expect(h.files.size).toBe(2);
  expect(h.message.files).toHaveLength(1);
  h.files.delete(h.fileId);
  await h.post(input, 'image/png').expect(409);
  expect(h.files.has(h.fileId)).toBe(false);
});

it('builds a missing display from the previously stored original when the source changed', async () => {
  const h = harness(false);
  const input = await pixels().png().toBuffer();
  h.setSaveDisplay(false);
  await h.post(input, 'image/png').expect(503);
  h.setSaveDisplay(true);
  const replacement = await pixels().negate().png().toBuffer();
  const result = await h.post(replacement, 'image/png').expect(200);
  const display = h.buffers.get(result.body.display_file_id);
  expect(display).toEqual(await sharp(input).rotate().resize(8).png().toBuffer());
  expect(h.buffers.get(h.fileId)).toEqual(input);
});
