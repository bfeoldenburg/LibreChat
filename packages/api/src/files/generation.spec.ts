import sharp from 'sharp';
import { createHash } from 'node:crypto';
import type { TFileConfig } from 'librechat-data-provider';
import { prepareGeneratedImage } from './generation';

const digest = (input: Buffer) => createHash('sha256').update(input).digest('hex');
const resizeImageBuffer = jest.fn();
const options = { endpoint: 'openAI' };

afterEach(() => jest.resetAllMocks());

async function encode(format: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff' | 'avif') {
  const image = sharp({
    create: { width: 1024, height: 512, channels: 3, background: { r: 11, g: 22, b: 33 } },
  }).withMetadata();
  if (format === 'jpeg') {
    image.withMetadata({ orientation: 6 });
  }
  return image.toFormat(format).toBuffer();
}

describe('generated image storage policy', () => {
  it.each(['png', 'jpeg', 'webp', 'gif', 'tiff', 'avif'] as const)(
    'preserves exact %s bytes and their actual media type without resizing',
    async (format) => {
      const input = await encode(format);
      const hash = digest(input);
      const result = await prepareGeneratedImage(
        input,
        {
          ...options,
          config: { preserveOriginal: true, percentage: 25, px: 128 },
          resolution: 'low',
        },
        { resizeImageBuffer },
      );
      expect(result.buffer).toBe(input);
      expect(digest(result.buffer)).toBe(hash);
      expect(result).toMatchObject({
        bytes: input.length,
        width: 1024,
        height: 512,
        type: `image/${format}`,
      });
      expect(await sharp(result.buffer).metadata()).toEqual(await sharp(input).metadata());
      expect(resizeImageBuffer).not.toHaveBeenCalled();
    },
  );

  it('retains EXIF orientation and metadata rather than applying auto-rotation', async () => {
    const input = await encode('jpeg');
    const result = await prepareGeneratedImage(
      input,
      { ...options, config: { preserveOriginal: true } },
      { resizeImageBuffer },
    );
    const before = await sharp(input).metadata();
    const after = await sharp(result.buffer).metadata();
    expect(before.orientation).toBe(6);
    expect(after.exif).toEqual(before.exif);
    expect(after.orientation).toBe(6);
    expect(result.width).toBe(1024);
    expect(result.height).toBe(512);
  });

  it('retains all GIF frames and reports the height of a single frame', async () => {
    const input = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
      raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    })
      .gif({ delay: [100, 200], loop: 0 })
      .toBuffer();
    expect((await sharp(input, { animated: true }).metadata()).pages).toBe(2);
    const result = await prepareGeneratedImage(
      input,
      { ...options, config: { preserveOriginal: true } },
      { resizeImageBuffer },
    );
    expect(result.buffer).toEqual(input);
    expect(result.height).toBe(1);
    expect((await sharp(result.buffer, { animated: true }).metadata()).pages).toBe(2);
  });

  it.each([
    [undefined, undefined, 'high'],
    [{ preserveOriginal: false }, undefined, 'high'],
    [{ percentage: 100 }, undefined, { percentage: 100 }],
    [{ px: 512 }, undefined, { px: 512 }],
    [
      { preserveOriginal: false, percentage: 50 },
      undefined,
      { preserveOriginal: false, percentage: 50 },
    ],
    [{ percentage: 50 }, 'low', 'low'],
  ] as const)(
    'keeps the existing resize path for config %j and override %j',
    async (config, resolution, expected) => {
      const input = await encode('png');
      const prepared = {
        buffer: Buffer.from('resized'),
        width: 32,
        height: 16,
        bytes: 7,
        type: 'image/png',
      };
      resizeImageBuffer.mockResolvedValue(prepared);
      const result = await prepareGeneratedImage(
        input,
        { ...options, config, resolution },
        { resizeImageBuffer },
      );
      expect(result).toBe(prepared);
      expect(resizeImageBuffer).toHaveBeenCalledWith(input, expected, options.endpoint);
    },
  );

  it.each([undefined, 'true', 1, null])(
    'does not enable original mode for unvalidated %j',
    async (preserveOriginal) => {
      resizeImageBuffer.mockResolvedValue({ buffer: Buffer.alloc(0) });
      const config = { preserveOriginal } as TFileConfig['imageGeneration'];
      await prepareGeneratedImage(Buffer.alloc(0), { ...options, config }, { resizeImageBuffer });
      expect(resizeImageBuffer).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    Buffer.alloc(0),
    Buffer.from('not an image, secret content'),
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
    ),
  ])('rejects invalid or unsupported originals without conversion fallback', async (input) => {
    await expect(
      prepareGeneratedImage(
        input,
        { ...options, config: { preserveOriginal: true } },
        { resizeImageBuffer },
      ),
    ).rejects.toThrow('Generated image cannot be preserved: invalid or unsupported raster image');
    expect(resizeImageBuffer).not.toHaveBeenCalled();
  });

  it('rejects truncated image pixels even if the metadata can be read', async () => {
    const complete = await encode('png');
    const input = complete.subarray(0, complete.length - 32);
    expect((await sharp(input).metadata()).width).toBe(1024);
    await expect(
      prepareGeneratedImage(
        input,
        { ...options, config: { preserveOriginal: true } },
        { resizeImageBuffer },
      ),
    ).rejects.toThrow('Generated image cannot be preserved: invalid or unsupported raster image');
    expect(resizeImageBuffer).not.toHaveBeenCalled();
  });
});
