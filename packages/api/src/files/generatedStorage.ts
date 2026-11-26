import { join } from 'node:path';
import { openAsBlob } from 'node:fs';
import { FileSources } from 'librechat-data-provider';
import type { DownloadedImage } from '~/mcp/images';
import { moveLocalFile } from '~/storage/local';
import { toLocalUrlPath } from '~/storage/path';

type Request = {
  user: { id: string; tenantId?: string };
  config: { paths: { publicPath: string } };
};

type Storage = {
  saveBuffer?: (options: {
    userId: string;
    fileName: string;
    buffer: Awaited<ReturnType<typeof openAsBlob>>;
    tenantId?: string;
  }) => Promise<string>;
  handleFileUpload?: (options: {
    req: Request;
    file: { path: string; originalname: string; mimetype: string; size: number };
    file_id: string;
    basePath: string;
  }) => Promise<{ filepath: string }>;
};

/** Write a validated original from disk using the configured storage provider. */
export async function saveGeneratedImagePath(
  source: string,
  storage: Storage,
  req: Request,
  fileId: string,
  filename: string,
  image: DownloadedImage,
): Promise<string> {
  const userId = req.user.id;
  if (source === FileSources.local) {
    const filepath = toLocalUrlPath('images', userId, filename);
    await moveLocalFile(image.path, join(req.config.paths.publicPath, 'images', userId), filename);
    return filepath;
  }
  if (source === FileSources.firebase && storage.saveBuffer) {
    return storage.saveBuffer({
      userId,
      fileName: filename,
      buffer: await openAsBlob(image.path, { type: image.type }),
      tenantId: req.user.tenantId,
    });
  }
  if (!storage.handleFileUpload)
    throw new Error('The configured file storage cannot upload images');
  const stored = await storage.handleFileUpload({
    req,
    file: {
      path: image.path,
      originalname: filename,
      mimetype: image.type ?? 'application/octet-stream',
      size: image.bytes,
    },
    file_id: fileId,
    basePath: 'images',
  });
  return stored.filepath;
}
