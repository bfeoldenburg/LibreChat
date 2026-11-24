const sharp = require('sharp');
const { resolveImageMimeType } = require('@librechat/api');

jest.mock('~/models', () => ({ createFile: jest.fn(async (doc) => doc) }));
jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: jest.fn(() => 'local'),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: jest.fn(async ({ fileName }) => `/images/user-1/${fileName}`),
  })),
}));
jest.mock('./retention', () => ({
  getRetentionExpiry: jest.fn(async () => ({})),
  getAgentFileRetentionExpiry: jest.fn(async () => ({})),
}));
jest.mock('./Audio/STTService', () => ({ STTService: class {} }));
jest.mock('~/server/controllers/assistants/v2', () => ({
  addResourceFileId: jest.fn(),
  deleteResourceFileId: jest.fn(),
}));
jest.mock('~/server/controllers/assistants/helpers', () => ({ getOpenAIClient: jest.fn() }));
jest.mock('~/server/services/Tools/credentials', () => ({ loadAuthValues: jest.fn() }));
jest.mock('~/server/services/Config', () => ({ checkCapability: jest.fn() }));
jest.mock('~/server/utils/queue', () => ({ LB_QueueAsyncCall: jest.fn() }));

const db = require('~/models');
const { saveBase64Image, savePreparedImage } = require('./process');

const req = {
  user: { id: 'user-1', tenantId: null },
  config: { fileConfig: { imageGeneration: 'high' }, paths: {} },
};

const dataUrl = (mimeType, buffer) => `data:${mimeType};base64,${buffer.toString('base64')}`;

const save = (url, request = req) =>
  saveBase64Image(url, {
    req: request,
    file_id: 'file-1',
    filename: 'tool_img_abc',
    endpoint: 'openAI',
    context: 'image_generation',
  });

describe('saveBase64Image records the media type of the bytes it saves', () => {
  it('records PNG for an SVG that sharp rasterizes', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">' +
        '<rect width="80" height="40" fill="red"/></svg>',
    );

    const file = await save(dataUrl('image/svg+xml', svg));

    expect(file.type).toBe('image/png');
    expect(file.filename).toBe('file-1-tool_img_abc.png');
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/png' }),
      true,
    );
  });

  it('leaves a genuine PNG labeled as PNG', async () => {
    const png = await sharp({
      create: { width: 40, height: 20, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const file = await save(dataUrl('image/png', png));

    expect(file.type).toBe('image/png');
    expect(file.filename).toBe('file-1-tool_img_abc.png');
  });

  it('corrects a WebP mislabeled by the producer as PNG', async () => {
    const webp = await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .webp()
      .toBuffer();

    const file = await save(dataUrl('image/png', webp));

    expect(file.type).toBe('image/webp');
    expect(file.filename).toBe('file-1-tool_img_abc.webp');
  });

  it('records a type that matches the bytes actually written to storage', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">' +
        '<rect width="80" height="40" fill="blue"/></svg>',
    );

    const file = await save(dataUrl('image/svg+xml', svg));

    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const { saveBuffer } = getStrategyFunctions.mock.results.at(-1).value;
    const savedBuffer = saveBuffer.mock.calls.at(-1)[0].buffer;

    expect(file.type).toBe(resolveImageMimeType(await sharp(savedBuffer).metadata()));
  });
});

describe('saveBase64Image original raster storage', () => {
  const originalRequest = {
    ...req,
    config: { ...req.config, fileConfig: { imageGeneration: { preserveOriginal: true } } },
  };

  it('writes exact original bytes with detected MIME, owner, dimensions and EXIF', async () => {
    const input = await sharp({
      create: { width: 1024, height: 512, channels: 3, background: { r: 11, g: 22, b: 33 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const file = await save(dataUrl('image/png', input), originalRequest);
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const { saveBuffer } = getStrategyFunctions.mock.results.at(-1).value;
    const saved = saveBuffer.mock.calls.at(-1)[0];
    expect(saved.buffer).toEqual(input);
    expect(saved.userId).toBe(req.user.id);
    expect(saved.tenantId).toBe(req.user.tenantId);
    expect(file).toMatchObject({
      user: req.user.id,
      type: 'image/jpeg',
      width: 1024,
      height: 512,
      bytes: input.length,
      filename: 'file-1-tool_img_abc.jpeg',
    });
    expect((await sharp(saved.buffer).metadata()).orientation).toBe(6);
  });

  it('keeps the default high-resolution resize when preservation is omitted', async () => {
    const input = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const file = await save(dataUrl('image/png', input));
    expect(file.width).toBe(768);
    expect(file.height).toBe(768);
  });

  it('preserves TIFF without claiming to create a browser-compatible preview', async () => {
    const input = await sharp({
      create: { width: 16, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .tiff()
      .toBuffer();
    const file = await save(dataUrl('image/tiff', input), originalRequest);
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const { saveBuffer } = getStrategyFunctions.mock.results.at(-1).value;
    expect(saveBuffer.mock.calls.at(-1)[0].buffer).toEqual(input);
    expect(file.type).toBe('image/tiff');
    expect(file.width).toBe(16);
    expect(file.height).toBe(8);
  });

  it('does not store unsupported SVG as an original', async () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const before = getStrategyFunctions.mock.calls.length;
    const writes = db.createFile.mock.calls.length;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
    await expect(save(dataUrl('image/svg+xml', svg), originalRequest)).rejects.toThrow(
      'Generated image cannot be preserved: invalid or unsupported raster image',
    );
    expect(getStrategyFunctions.mock.calls).toHaveLength(before);
    expect(db.createFile.mock.calls).toHaveLength(writes);
  });
});

it('saves an already prepared original through the native strategy with the result association', async () => {
  const input = await sharp({
    create: { width: 12, height: 8, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  const request = { ...req, user: { id: 'real-owner', tenantId: 'real-tenant' } };
  const association = {
    conversationId: 'actual-conversation',
    messageId: 'actual-result',
    metadata: { imageDisplayFileId: 'preview-id' },
  };
  const file = await savePreparedImage(
    { buffer: input, type: 'image/png', bytes: input.length, width: 12, height: 8 },
    {
      req: request,
      file_id: 'file-id',
      filename: 'image-original',
      context: 'image_generation',
      association,
    },
  );
  const { getStrategyFunctions } = require('~/server/services/Files/strategies');
  const { saveBuffer } = getStrategyFunctions.mock.results.at(-1).value;
  expect(saveBuffer).toHaveBeenCalledWith({
    userId: 'real-owner',
    tenantId: 'real-tenant',
    buffer: input,
    fileName: 'file-id-image-original.png',
  });
  expect(file).toMatchObject({ ...association, user: 'real-owner', tenantId: 'real-tenant' });
});
