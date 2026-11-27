import getStream from 'get-stream';
import { addAbortSignal } from 'node:stream';
import { FileContext } from 'librechat-data-provider';
import type { AppConfig, IMongoFile } from '@librechat/data-schemas';
import type { Readable } from 'node:stream';
import { configuredRequestBudget } from '~/utils/timeouts';
import { resolveDownloadPath } from '~/storage/path';
import { sniffImageMimeType } from '~/files/mime';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

type InputFile = Pick<IMongoFile, 'source' | 'filepath' | 'storageKey' | 'bytes'>;
type InputScope = { userId: string; tenantId?: string };

export function readMCPImageFileIds(req: object): string[] {
  const body = 'body' in req ? req.body : undefined;
  if (!body || typeof body !== 'object' || !('files' in body) || !Array.isArray(body.files)) {
    return [];
  }
  if (body.files.length > 64) return [];
  const ids = new Set<string>();
  for (const file of body.files as unknown[]) {
    const id = file && typeof file === 'object' && 'file_id' in file ? file.file_id : file;
    if (typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function createMCPImageInput({
  getFiles,
  readStoredImage,
}: {
  getFiles: (
    filter: {
      file_id: { $in: readonly string[] };
      user: string;
      tenantId: string | null;
      context: FileContext;
      type: { $in: string[] };
      $and: Array<{ $or: Record<string, null | { $gt: Date }>[] }>;
    },
    sort: null,
    selection: string,
    limit: number,
  ) => Promise<InputFile[] | null>;
  readStoredImage: (
    req: { config: AppConfig; user: { id: string } },
    file: InputFile,
    path: string,
    signal: AbortSignal,
  ) => Promise<Readable>;
}) {
  return async (
    scope: InputScope,
    fileIds: readonly string[],
    config: AppConfig,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (!fileIds.length) return;
    const now = new Date();
    const files = await getFiles(
      {
        file_id: { $in: fileIds },
        user: scope.userId,
        tenantId: scope.tenantId ?? null,
        context: FileContext.message_attachment,
        type: { $in: IMAGE_TYPES },
        $and: [
          { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
          { $or: [{ expiredAt: null }, { expiredAt: { $gt: now } }] },
        ],
      },
      null,
      'source filepath storageKey bytes',
      2,
    );
    if (files?.length !== 1) return;
    const file = files[0];
    if (file.bytes > MAX_IMAGE_BYTES || (!file.storageKey && !file.filepath)) return;
    const budget = configuredRequestBudget(config, 'imageFetchMs', signal);
    budget.signal.throwIfAborted();
    const stream = await readStoredImage(
      { config, user: { id: scope.userId } },
      file,
      resolveDownloadPath(file),
      budget.signal,
    );
    const buffer = await getStream.buffer(addAbortSignal(budget.signal, stream), {
      maxBuffer: MAX_IMAGE_BYTES,
    });
    const type = sniffImageMimeType(buffer);
    if (type && IMAGE_TYPES.includes(type)) return buffer.toString('base64');
  };
}
