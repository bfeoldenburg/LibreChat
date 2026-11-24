import sharp from 'sharp';
import { raw } from 'express';
import { randomUUID } from 'node:crypto';
import { EModelEndpoint, FileContext } from 'librechat-data-provider';
import type { ImageFile, MCPAuthorizationConfig } from 'librechat-data-provider';
import type { AppConfig, IMessage } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Readable } from 'node:stream';
import type { GeneratedImage, GeneratedImageDependencies } from '~/files/generation';
import { prepareGeneratedImage } from '~/files/generation';
import { getSafeErrorMetadata } from '~/utils/errors';

const MAX_IMAGE_BYTES = 16_777_216;
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/tiff']);
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const readRaw = raw({ type: 'application/octet-stream', limit: MAX_IMAGE_BYTES, inflate: false });

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
type Target = { userId: string; conversationId: string; messageId: string };
type StorageRequest = {
  user: Owner;
  config: AppConfig;
  body: { conversationId: string };
  fileRetentionSource: { isTemporary?: boolean; expiredAt?: Date | null };
};

export interface ImageImportDependencies {
  findPrincipalUser: (id: string) => Promise<Owner | null>;
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
  > | null>;
  getStorageConfig: (user: Owner) => Promise<AppConfig>;
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
  logger: Pick<Console, 'error'>;
}

class ImportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function readImage(req: Request, res: Response): Promise<Buffer> {
  if (!req.is('application/octet-stream')) throw new ImportError(415, 'image_type_invalid');
  await new Promise<void>((resolve, reject) => {
    readRaw(req, res, (error?: { status?: number }) => {
      if (error) {
        reject(new ImportError(error.status === 413 ? 413 : 400, 'image_body_invalid'));
      } else {
        resolve();
      }
    });
  });
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    throw new ImportError(400, 'image_body_invalid');
  }
  return req.body;
}

async function prepare(
  input: Buffer,
  mime: string,
  config: AppConfig,
  resizeImageBuffer: ImageImportDependencies['resizeImageBuffer'],
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
    throw new ImportError(422, 'image_content_invalid');
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
    throw new ImportError(409, 'image_file_unavailable');
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

async function readOriginal(req: StorageRequest, file: ImportFile, deps: ImageImportDependencies) {
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
  tenantId: string | undefined,
  deps: ImageImportDependencies,
) {
  const [user, message, existing] = await Promise.all([
    deps.findPrincipalUser(target.userId),
    deps.getMessage({ user: target.userId, messageId: target.messageId }),
    deps.findFileById(fileId),
  ]);
  if (
    !user ||
    (user.tenantId ?? null) !== (tenantId ?? null) ||
    !message ||
    (message.tenantId ?? null) !== (tenantId ?? null) ||
    message.conversationId !== target.conversationId ||
    message.isCreatedByUser !== false ||
    message.isUserSubmitted === true ||
    (message.expiredAt != null && message.expiredAt.getTime() <= Date.now())
  ) {
    throw new ImportError(404, 'image_target_unavailable');
  }

  const displayId = attachedDisplayId(message.files, fileId);
  if (displayId) {
    const display = displayId === fileId ? existing : await deps.findFileById(displayId);
    if (!existing || !display) throw new ImportError(409, 'image_file_unavailable');
    checkFile(existing, target, tenantId);
    checkFile(display, target, tenantId);
    return displayId;
  }

  const config = await deps.getStorageConfig(user);
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
        throw new ImportError(409, 'image_file_unavailable');
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
      if (!display) throw new ImportError(409, 'image_file_unavailable');
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
  if (!(await deps.attachMCPImage(target, asMCPImageFile(displayFile), fileId))) {
    throw new ImportError(409, 'image_target_unavailable');
  }
  return displayFile.file_id;
}

export function createMCPImageImport(
  deps: ImageImportDependencies,
  runWithContext: <T>(
    context: { tenantId?: string; userId: string },
    action: () => Promise<T>,
  ) => Promise<T>,
): (req: Request, res: Response, config: MCPAuthorizationConfig) => Promise<void> {
  const active = new Set<string>();
  return async (req, res, config) => {
    const userId = req.get('X-LibreChat-User-ID') ?? '';
    const conversationId = req.get('X-LibreChat-Conversation-ID') ?? '';
    const messageId = req.get('X-LibreChat-Message-ID') ?? '';
    const fileId = req.get('X-LibreChat-File-ID') ?? '';
    const mime = req.get('X-Image-Mime-Type') ?? '';
    if (
      !/^[0-9a-f]{24}$/.test(userId) ||
      !identifier.test(conversationId) ||
      !identifier.test(messageId) ||
      !uuid.test(fileId) ||
      !rasterTypes.has(mime)
    ) {
      res.status(400).json({ error: { code: 'image_request_invalid' } });
      return;
    }
    if (active.has(fileId)) {
      res.status(409).json({ error: { code: 'image_import_in_progress' } });
      return;
    }
    active.add(fileId);
    try {
      const data = await readImage(req, res);
      const displayId = await runWithContext({ tenantId: config.tenantId, userId }, () =>
        store({ userId, conversationId, messageId }, fileId, mime, data, config.tenantId, deps),
      );
      res
        .status(200)
        .json({ delivery_status: 'stored', file_id: fileId, display_file_id: displayId });
    } catch (error) {
      if (error instanceof ImportError) {
        res.status(error.status).json({ error: { code: error.code } });
        return;
      }
      deps.logger.error('[MCP image import] Storage failed', getSafeErrorMetadata(error));
      res.status(503).json({ error: { code: 'image_import_failed' } });
    } finally {
      active.delete(fileId);
    }
  };
}
