import { Readable } from 'node:stream';
import type { AppConfig } from '@librechat/data-schemas';
import { createMCPImageInput, readMCPImageFileIds } from './input';

const id = 'bc14b3b8-458e-456f-8677-f2da2b6f027e';
const scope = { userId: 'a'.repeat(24), tenantId: 'tenant-a' };
const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const file = { source: 'local', filepath: '/images/example.png', bytes: image.length };

it('takes only attachment IDs from the turn and reads the stored file', async () => {
  const ids = readMCPImageFileIds({
    body: { files: [{ file_id: id, filepath: 'https://external.invalid' }, id, '../example'] },
  });
  expect(ids).toEqual([id]);
  const getFiles = jest.fn(async () => [file]);
  const readStoredImage = jest.fn(async () => Readable.from([image]));
  const input = createMCPImageInput({ getFiles, readStoredImage });

  await expect(input(scope, ids, {} as AppConfig)).resolves.toBe(image.toString('base64'));
  expect(getFiles).toHaveBeenCalledWith(
    expect.objectContaining({
      file_id: { $in: ids },
      user: scope.userId,
      tenantId: scope.tenantId,
    }),
    null,
    expect.any(String),
    2,
  );
  expect(readStoredImage).toHaveBeenCalledWith(
    expect.anything(),
    file,
    file.filepath,
    expect.any(AbortSignal),
  );
});

it('skips transfer when there is no unique owned image and bounds actual bytes read', async () => {
  const getFiles = jest.fn(async () => [file, file]);
  const readStoredImage = jest.fn(async () => Readable.from([Buffer.alloc(4 * 1024 * 1024 + 1)]));
  const input = createMCPImageInput({ getFiles, readStoredImage });

  await expect(input(scope, [id], {} as AppConfig)).resolves.toBeUndefined();
  expect(readStoredImage).not.toHaveBeenCalled();

  getFiles.mockResolvedValueOnce([file]);
  await expect(input(scope, [id], {} as AppConfig)).rejects.toThrow();
});
