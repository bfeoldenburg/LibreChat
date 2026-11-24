import sharp from 'sharp';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@librechat/data-schemas';
import type { ImageStorageDependencies } from './images';
import { createMCPImageStorage } from './images';

const OWNER = 'a'.repeat(24);
function harness(preserveOriginal: boolean) {
  type File = NonNullable<Awaited<ReturnType<ImageStorageDependencies['findFileById']>>>;
  type Message = NonNullable<Awaited<ReturnType<ImageStorageDependencies['getMessage']>>>;
  const files = new Map<string, File>();
  const buffers = new Map<string, Buffer>();
  const message: Message = { conversationId: 'conversation', isCreatedByUser: false, files: [] };
  const state = { attach: true, saveDisplay: true, messageAvailable: true };
  const config = { fileConfig: { imageGeneration: { preserveOriginal } } } as AppConfig;
  const deps: ImageStorageDependencies = {
    getMessage: async ({ user, messageId }) =>
      state.messageAvailable && user === OWNER && messageId === 'result' ? message : null,
    findFileById: async (id) => files.get(id) ?? null,
    attachMCPImage: async (_target, image) => {
      if (!state.attach) return false;
      message.files?.push(image);
      return true;
    },
    savePreparedImage: async (image, options) => {
      const { file_id, association, req, context, filename } = options;
      if (filename === 'image-display' && !state.saveDisplay)
        throw new Error('test storage failure');
      const file: File = {
        ...association,
        context,
        file_id,
        user: req.user.id,
        tenantId: req.user.tenantId,
        filename,
        filepath: '/images/' + file_id,
        width: image.width,
        height: image.height,
        source: 'local',
        type: image.type ?? 'image/png',
        bytes: image.bytes,
      };
      files.set(file_id, file);
      buffers.set(file_id, image.buffer);
      return file;
    },
    readStoredImage: async (_req, file) => Readable.from([buffers.get(file.file_id)]),
    resizeImageBuffer: async (buffer) => {
      const { data, info } = await sharp(buffer)
        .rotate()
        .resize(8)
        .png()
        .toBuffer({ resolveWithObject: true });
      return {
        buffer: data,
        bytes: data.length,
        type: 'image/png',
        width: info.width,
        height: info.height,
      };
    },
  };
  const store = createMCPImageStorage(deps);
  const fileId = randomUUID();
  const save = (input: Buffer, mime = 'image/png', userId = OWNER) =>
    store({
      user: { id: userId },
      config,
      conversationId: 'conversation',
      messageId: 'result',
      fileId,
      dataUrl: `data:${mime};base64,${input.toString('base64')}`,
    });
  return { files, buffers, message, state, save, fileId, store, config };
}
const pixels = () =>
  sharp({ create: { width: 20, height: 12, channels: 3, background: { r: 80, g: 40, b: 20 } } });

it('preserves a web-capable original unchanged and stores only one native file', async () => {
  const h = harness(true);
  const input = await pixels().png().toBuffer();
  const display = await h.save(input);
  expect(display.file_id).toBe(h.fileId);
  expect(h.buffers.get(h.fileId)).toEqual(input);
  expect(h.files.size).toBe(1);
  expect(h.message.files).toEqual([display]);
  expect(display.metadata?.imageOriginalFileId).toBeUndefined();
  expect(await h.save(input)).toEqual(display);
  expect(h.files.size).toBe(1);
});

it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
  'does not resize or convert %s with preserveOriginal',
  async (mime) => {
    const format = mime.slice(6) as 'png' | 'jpeg' | 'webp' | 'gif';
    const h = harness(true);
    const input = await pixels().toFormat(format).toBuffer();
    const display = await h.save(input, mime);
    expect(display.type).toBe(mime);
    expect(h.buffers.get(display.file_id)).toEqual(input);
    expect(h.files.size).toBe(1);
  },
);

it('keeps an unmodified TIFF and a linked browser-capable PNG with preserveOriginal', async () => {
  const h = harness(true);
  const input = await pixels().tiff().toBuffer();
  const display = await h.save(input, 'image/tiff');
  expect(display.file_id).not.toBe(h.fileId);
  expect(h.buffers.get(h.fileId)).toEqual(input);
  expect((await sharp(h.buffers.get(display.file_id)).metadata()).format).toBe('png');
  expect(h.files.get(h.fileId)?.metadata?.imageDisplayFileId).toBe(display.file_id);
  expect(display.metadata?.imageOriginalFileId).toBe(h.fileId);
  expect(h.message.files).toEqual([display]);
  expect(h.files.size).toBe(2);
});

it('retains the original when configured display processing changes the bytes', async () => {
  const h = harness(false);
  const input = await pixels().withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const display = await h.save(input, 'image/jpeg');
  expect(h.buffers.get(h.fileId)).toEqual(input);
  expect(display.file_id).not.toBe(h.fileId);
  expect(display.type).toBe('image/png');
  expect(h.files.size).toBe(2);
});

it('rejects unavailable messages, foreign users and invalid raster data before storage', async () => {
  const h = harness(true);
  const input = await pixels().png().toBuffer();
  h.state.messageAvailable = false;
  await expect(h.save(input)).rejects.toThrow('image_target_unavailable');
  h.state.messageAvailable = true;
  await expect(h.save(input, 'image/png', 'b'.repeat(24))).rejects.toThrow(
    'image_target_unavailable',
  );
  await expect(h.save(input, 'image/jpeg')).rejects.toThrow('image_content_invalid');
  await expect(h.save(Buffer.from('not an image'))).rejects.toThrow('image_content_invalid');
  expect(h.files.size).toBe(0);
});

it('requires the native attachment update before confirming and reuses files on retry', async () => {
  const h = harness(true);
  const input = await pixels().png().toBuffer();
  h.state.attach = false;
  await expect(h.save(input)).rejects.toThrow('image_target_unavailable');
  expect(h.message.files).toHaveLength(0);
  h.state.attach = true;
  await h.save(input);
  expect(h.message.files).toHaveLength(1);
  expect(h.files.size).toBe(1);
});

it('derives a missing display from the stored original after a partial failure', async () => {
  const h = harness(false);
  const input = await pixels().jpeg().toBuffer();
  h.state.saveDisplay = false;
  await expect(h.save(input, 'image/jpeg')).rejects.toThrow('test storage failure');
  h.state.saveDisplay = true;
  const replacement = await pixels().negate().png().toBuffer();
  const display = await h.save(replacement);
  expect(h.buffers.get(display.file_id)).toEqual(
    await sharp(input).rotate().resize(8).png().toBuffer(),
  );
  expect(h.buffers.get(h.fileId)).toEqual(input);
});

it('coalesces simultaneous host saves and never recreates an already attached deleted image', async () => {
  const h = harness(true);
  const input = await pixels().tiff().toBuffer();
  const [first, second] = await Promise.all([
    h.save(input, 'image/tiff'),
    h.save(input, 'image/tiff'),
  ]);
  expect(first).toEqual(second);
  expect(h.files.size).toBe(2);
  expect(h.message.files).toHaveLength(1);
  h.files.delete(first.file_id);
  await expect(h.save(input, 'image/tiff')).rejects.toThrow('image_file_unavailable');
});
