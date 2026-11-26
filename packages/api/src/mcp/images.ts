import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { EModelEndpoint, FileContext } from 'librechat-data-provider';
import type { AppConfig, IMessage } from '@librechat/data-schemas';
import type { ImageFile } from 'librechat-data-provider';
import type { Readable } from 'node:stream';
import type { GeneratedImage, GeneratedImageDependencies } from '~/files/generation';
import type { LeaseDeps } from '~/admin/lease';
import { prepareGeneratedImage } from '~/files/generation';
import { withLease } from '~/admin/lease';

const MAX_IMAGE_BYTES = 16_777_216;
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/tiff']);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

type Owner = { id: string; role?: string; idOnTheSource?: string | null; tenantId?: string };
type ImageLinks = { imageOriginalFileId?: string; imageDisplayFileId?: string };
type ImportFile = {
  file_id: string;
  user: { toString(): string };
  tenantId?: string;
  conversationId?: string;
  messageId?: string;
  context?: string;
  source: string;
  filename: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  type: string;
  bytes: number;
  width?: number;
  height?: number;
  expiredAt?: Date;
  storageOperations?: { deleting?: string; deletionPending?: boolean };
  metadata?: ImageLinks;
};
type Target = {
  userId: string;
  tenantId?: string;
  conversationId: string;
  messageId: string;
  toolCallId?: string;
};
type StorageRequest = {
  user: Owner;
  config: AppConfig;
  body: { conversationId: string };
  fileRetentionSource: { isTemporary?: boolean; expiredAt?: Date | null };
};

export interface ImageStorageDependencies {
  lease?: LeaseDeps;
  getMessage: (query: {
    user: string;
    messageId: string;
  }) => Promise<Pick<
    IMessage,
    | 'conversationId'
    | 'tenantId'
    | 'isCreatedByUser'
    | 'isUserSubmitted'
    | 'isTemporary'
    | 'expiredAt'
    | 'files'
    | 'attachments'
  > | null>;
  findFileById: (id: string) => Promise<ImportFile | null>;
  attachMCPImage: (target: Target, image: ImageFile, originalFileId: string) => Promise<boolean>;
  savePreparedImage: (
    image: GeneratedImage,
    options: {
      req: StorageRequest;
      file_id: string;
      filename: string;
      context: FileContext;
      association: {
        conversationId: string;
        messageId: string;
        metadata: ImageLinks;
      };
    },
  ) => Promise<ImportFile | null>;
  readStoredImage: (req: StorageRequest, file: ImportFile) => Promise<Readable>;
  resizeImageBuffer: GeneratedImageDependencies['resizeImageBuffer'];
}

async function prepare(
  input: Buffer,
  mime: string,
  config: AppConfig,
  resizeImageBuffer: ImageStorageDependencies['resizeImageBuffer'],
) {
  const endpoint = EModelEndpoint.agents;
  const options = { endpoint, config: config.fileConfig?.imageGeneration };
  try {
    const original = await prepareGeneratedImage(
      input,
      { endpoint, config: { preserveOriginal: true } },
      { resizeImageBuffer },
    );
    if (original.type !== mime) throw new Error('Image does not match declared type');
    if (mime === 'image/tiff') {
      const { data, info } = await sharp(input)
        .rotate()
        .png()
        .toBuffer({ resolveWithObject: true });
      return {
        original,
        display: {
          buffer: data,
          type: 'image/png',
          bytes: data.length,
          width: info.width,
          height: info.height,
        },
      };
    }
    if (options.config?.preserveOriginal === true) return { original };
    const display = await prepareGeneratedImage(input, options, { resizeImageBuffer });
    return input.equals(display.buffer) ? { original } : { original, display };
  } catch {
    throw new Error('image_content_invalid');
  }
}

function checkFile(file: ImportFile, target: Target, tenantId: string | undefined) {
  if (
    String(file.user) !== target.userId ||
    (file.tenantId ?? null) !== (tenantId ?? null) ||
    file.conversationId !== target.conversationId ||
    file.messageId !== target.messageId ||
    file.context !== FileContext.image_generation ||
    file.storageOperations?.deleting != null ||
    file.storageOperations?.deletionPending === true ||
    (file.expiredAt != null && file.expiredAt.getTime() <= Date.now())
  ) {
    throw new Error('image_file_unavailable');
  }
  return file;
}

export function asMCPImageFile(file: ImportFile): ImageFile {
  const image = {
    user: String(file.user),
    file_id: file.file_id,
    filename: file.filename,
    filepath: file.filepath,
    storageKey: file.storageKey,
    storageRegion: file.storageRegion,
    type: file.type,
    object: 'file' as const,
    bytes: file.bytes,
    usage: 0,
    embedded: false,
    width: file.width ?? 0,
    height: file.height ?? 0,
    source: file.source as ImageFile['source'],
    metadata: {
      mcpImage: true,
      ...(file.metadata?.imageOriginalFileId && {
        imageOriginalFileId: file.metadata.imageOriginalFileId,
      }),
    },
  };
  return image;
}

function attachedDisplayId(files: unknown[] | undefined, originalId: string) {
  for (const file of files ?? []) {
    if (
      !file ||
      typeof file !== 'object' ||
      !('file_id' in file) ||
      typeof file.file_id !== 'string'
    )
      continue;
    if (file.file_id === originalId) return originalId;
    const metadata = 'metadata' in file ? file.metadata : undefined;
    if (
      metadata &&
      typeof metadata === 'object' &&
      'imageOriginalFileId' in metadata &&
      metadata.imageOriginalFileId === originalId
    )
      return file.file_id;
  }
  return undefined;
}

async function readOriginal(req: StorageRequest, file: ImportFile, deps: ImageStorageDependencies) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const stream = await deps.readStoredImage(req, file);
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk) || (bytes += chunk.length) > MAX_IMAGE_BYTES) {
      throw new Error('Stored image exceeds transfer limit');
    }
    chunks.push(chunk);
  }
  if (bytes !== file.bytes) throw new Error('Stored image is incomplete');
  return Buffer.concat(chunks, bytes);
}

async function store(
  target: Target,
  fileId: string,
  mime: string,
  input: Buffer,
  user: Owner,
  config: AppConfig,
  deps: ImageStorageDependencies,
  fence: () => Promise<void>,
) {
  const tenantId = user.tenantId;
  const [message, existing] = await Promise.all([
    deps.getMessage({ user: target.userId, messageId: target.messageId }),
    deps.findFileById(fileId),
  ]);
  if (
    !message ||
    (message.tenantId ?? null) !== (tenantId ?? null) ||
    message.conversationId !== target.conversationId ||
    message.isCreatedByUser !== false ||
    message.isUserSubmitted === true ||
    (message.expiredAt != null && message.expiredAt.getTime() <= Date.now())
  ) {
    throw new Error('image_target_unavailable');
  }

  const attachDisplay = async (display: ImportFile) => {
    const image = asMCPImageFile(display);
    await fence();
    if (!(await deps.attachMCPImage(target, image, fileId))) {
      throw new Error('image_target_unavailable');
    }
    return image;
  };
  const messageFileId = attachedDisplayId(message.files, fileId);
  const attachmentId = attachedDisplayId(message.attachments, fileId);
  const displayId = attachmentId ?? messageFileId;
  if (displayId) {
    const display = displayId === fileId ? existing : await deps.findFileById(displayId);
    if (!existing || !display) throw new Error('image_file_unavailable');
    checkFile(existing, target, tenantId);
    checkFile(display, target, tenantId);
    return attachmentId && messageFileId ? asMCPImageFile(display) : attachDisplay(display);
  }

  const req = {
    user,
    config,
    body: { conversationId: target.conversationId },
    fileRetentionSource: { isTemporary: message.isTemporary, expiredAt: message.expiredAt },
  };
  const association = { conversationId: target.conversationId, messageId: target.messageId };
  let originalFile = existing;
  let preparedDisplay: GeneratedImage | undefined;
  if (originalFile) {
    checkFile(originalFile, target, tenantId);
  } else {
    const prepared = await prepare(input, mime, config, deps.resizeImageBuffer);
    preparedDisplay = prepared.display;
    await fence();
    originalFile = await deps.savePreparedImage(prepared.original, {
      req,
      file_id: fileId,
      filename: 'image-original',
      context: FileContext.image_generation,
      association: {
        ...association,
        metadata: preparedDisplay ? { imageDisplayFileId: randomUUID() } : {},
      },
    });
    if (!originalFile) throw new Error('Image file record was not created');
  }
  let displayFile = originalFile;
  const previewId = originalFile.metadata?.imageDisplayFileId;
  if (previewId) {
    const preview = await deps.findFileById(previewId);
    if (preview) {
      checkFile(preview, target, tenantId);
      if (preview.metadata?.imageOriginalFileId !== fileId) {
        throw new Error('image_file_unavailable');
      }
      displayFile = preview;
    } else {
      // A failed import may already have saved the original. Derive the preview from
      // that file on retry, since the upstream filename may now hold different bytes.
      const display =
        preparedDisplay ??
        (
          await prepare(
            await readOriginal(req, originalFile, deps),
            originalFile.type,
            config,
            deps.resizeImageBuffer,
          )
        ).display;
      if (!display) throw new Error('image_file_unavailable');
      await fence();
      const saved = await deps.savePreparedImage(display, {
        req,
        file_id: previewId,
        filename: 'image-display',
        context: FileContext.image_generation,
        association: { ...association, metadata: { imageOriginalFileId: fileId } },
      });
      if (!saved) throw new Error('Image display file record was not created');
      displayFile = saved;
    }
  }
  return attachDisplay(displayFile);
}

export interface ImageStorageInput {
  user: Owner;
  config: AppConfig;
  conversationId: string;
  messageId: string;
  toolCallId?: string;
  fileId: string;
  dataUrl: string;
}

/** Store a regular MCP image result using only trusted, host-owned context. */
export function createMCPImageStorage(
  deps: ImageStorageDependencies,
): (input: ImageStorageInput) => Promise<ImageFile> {
  const active = new Map<string, Promise<ImageFile>>();
  return async (input) => {
    if (!uuid.test(input.fileId)) throw new Error('image_file_invalid');
    const key = JSON.stringify([
      input.user.id,
      input.user.tenantId,
      input.conversationId,
      input.messageId,
      input.fileId,
    ]);
    const pending = active.get(key);
    if (pending) return pending;
    const save = async (): Promise<ImageFile> => {
      const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(input.dataUrl);
      if (
        !match ||
        !rasterTypes.has(match[1]) ||
        match[2].length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)
      ) {
        throw new Error('image_content_invalid');
      }
      const data = Buffer.from(match[2], 'base64');
      if (!data.length || data.length > MAX_IMAGE_BYTES || data.toString('base64') !== match[2]) {
        throw new Error('image_content_invalid');
      }
      return withLease(deps.lease, 'mcp-image:' + input.fileId, (fence) =>
        store(
          {
            userId: input.user.id,
            tenantId: input.user.tenantId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            toolCallId: input.toolCallId,
          },
          input.fileId,
          match[1],
          data,
          input.user,
          input.config,
          deps,
          fence,
        ),
      );
    };
    const operation = save();
    active.set(key, operation);
    try {
      return await operation;
    } finally {
      active.delete(key);
    }
  };
}
