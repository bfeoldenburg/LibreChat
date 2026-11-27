import { z } from 'zod';
import getStream from 'get-stream';
import { addAbortSignal } from 'node:stream';
import { FileContext } from 'librechat-data-provider';
import type { AppConfig, IMessage, IMongoFile } from '@librechat/data-schemas';
import type { Readable } from 'node:stream';
import { configuredRequestBudget } from '~/utils/timeouts';
import { resolveDownloadPath } from '~/storage/path';
import { sniffImageMimeType } from '~/files/mime';
import { walkBranch } from '~/messages/history';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const FILE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

type InputFile = Pick<IMongoFile, 'source' | 'filepath' | 'storageKey' | 'bytes'>;
type InputScope = { userId: string; tenantId?: string; conversationId?: string };
export type MCPImageHistoryRow = Pick<
  IMessage,
  | 'messageId'
  | 'parentMessageId'
  | 'isCreatedByUser'
  | 'isUserSubmitted'
  | 'expiredAt'
  | 'files'
  | 'attachments'
>;
export type MCPCompletedImage = {
  fileId: string;
  messageId: string;
  conversationId: string;
  toolCallId?: string;
  width?: number;
  height?: number;
};

const dimensions = {
  width: z.number().int().positive().optional().catch(undefined),
  height: z.number().int().positive().optional().catch(undefined),
};
const generatedImage = z.object({
  file_id: z.string().regex(FILE_ID),
  toolCallId: z
    .string()
    .regex(/^[A-Za-z0-9_:-]{1,256}$/)
    .optional()
    .catch(undefined),
  ...dimensions,
  metadata: z.object({
    mcpImage: z.literal(true),
    imageOriginalFileId: z.string().regex(FILE_ID).optional().catch(undefined),
    originalFile: z
      .object({ type: z.string(), ...dimensions })
      .optional()
      .catch(undefined),
  }),
});

/** The host-written attachments are the durable record of successful delivery. */
export function collectMCPCompletedImages(
  rows: readonly MCPImageHistoryRow[],
  conversationId: string,
  parentMessageId: string,
): ReadonlyMap<string, MCPCompletedImage> {
  const images = new Map<string, MCPCompletedImage>();
  const now = Date.now();
  for (const row of walkBranch(rows, parentMessageId).reverse()) {
    if (row.isCreatedByUser !== false || row.isUserSubmitted === true) continue;
    if (row.expiredAt != null && new Date(row.expiredAt).getTime() <= now) continue;
    for (const item of [...(row.files ?? []), ...(row.attachments ?? [])]) {
      const parsed = generatedImage.safeParse(item);
      if (!parsed.success) continue;
      const { file_id, metadata, width, height, toolCallId } = parsed.data;
      const original = metadata.originalFile;
      const originalId =
        original && IMAGE_TYPES.includes(original.type) && metadata.imageOriginalFileId;
      const size = originalId ? original : { width, height };
      images.set(`mcp-image-${file_id}`, {
        fileId: originalId || file_id,
        messageId: row.messageId,
        conversationId,
        toolCallId,
        width: size?.width,
        height: size?.height,
      });
    }
  }
  return images;
}

export function readMCPImageFileIds(req: object): string[] {
  const body = 'body' in req ? req.body : undefined;
  if (!body || typeof body !== 'object' || !('files' in body) || !Array.isArray(body.files)) {
    return [];
  }
  if (body.files.length > 64) return [];
  const ids = new Set<string>();
  for (const file of body.files as unknown[]) {
    const id = file && typeof file === 'object' && 'file_id' in file ? file.file_id : file;
    if (typeof id === 'string' && FILE_ID.test(id)) {
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
      conversationId?: string;
      messageId?: string;
      'storageOperations.deleting': { $exists: false };
      'storageOperations.deletionPending': { $ne: true };
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
    image?: MCPCompletedImage,
  ): Promise<string | undefined> => {
    if (image && image.conversationId !== scope.conversationId) return;
    if (!image && !fileIds.length) return;
    const now = new Date();
    const files = await getFiles(
      {
        file_id: { $in: image ? [image.fileId] : fileIds },
        user: scope.userId,
        tenantId: scope.tenantId ?? null,
        context: image ? FileContext.image_generation : FileContext.message_attachment,
        ...(image && { conversationId: image.conversationId, messageId: image.messageId }),
        type: { $in: IMAGE_TYPES },
        'storageOperations.deleting': { $exists: false },
        'storageOperations.deletionPending': { $ne: true },
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
