import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileSources } from 'librechat-data-provider';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { saveGeneratedImagePath } from '~/files/generatedStorage';
import { withMCPImageDownload } from './download';

afterEach(() => jest.restoreAllMocks());

const origin = 'http://backend.invalid:8000';
const ticket = 'synthetic-private-ticket';

it('stages separate chunks and atomically installs the complete original in local image storage', async () => {
  const original = Buffer.from('synthetic original bytes');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(original.subarray(0, 9));
      controller.enqueue(original.subarray(9));
      controller.close();
    },
  });
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(stream, {
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(original.length) },
    }),
  );
  const publicPath = await mkdtemp(join(tmpdir(), 'librechat-local-image-'));
  let temporaryDirectory: string | undefined;
  try {
    const url = await withMCPImageDownload(
      origin,
      { ticket, expires_at: Date.now() + 5_000 },
      (path, mime, bytes) => {
        temporaryDirectory = dirname(path);
        return saveGeneratedImagePath(
          FileSources.local,
          {},
          { user: { id: 'owner' }, config: { paths: { publicPath } } },
          'file-id',
          'file-id-image-original.png',
          { path, bytes, type: mime, width: 4, height: 2 },
        );
      },
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(origin + '/api/mcp/media/download');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { 'X-Media-Download-Ticket': ticket },
      redirect: 'error',
    });
    expect(url).toBe('/images/owner/file-id-image-original.png');
    expect(await readFile(join(publicPath, url))).toEqual(original);
    expect(temporaryDirectory).toBeDefined();
    await expect(access(temporaryDirectory!)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(publicPath, { recursive: true, force: true });
  }
});

it('rejects an incomplete response before the storage callback', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('one chunk', {
      headers: { 'Content-Type': 'image/png', 'Content-Length': '18' },
    }),
  );
  const store = jest.fn();
  await expect(
    withMCPImageDownload(origin, { ticket, expires_at: Date.now() + 5_000 }, store),
  ).rejects.toThrow('image_download_failed');
  expect(store).not.toHaveBeenCalled();
});
