import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export const MAX_IMAGE_BYTES: number = 16_777_216;
const MAX_DIRECT_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_TRANSFER_MS = 120_000;

export interface ImageDownload {
  ticket: string;
  expires_at: number;
  signal?: AbortSignal;
}

export async function withTemporaryMCPImage<T>(
  processFile: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-mcp-image-'));
  try {
    return await processFile(join(directory, 'original'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function stageStoredMCPImage(
  path: string,
  stream: Readable,
  size: number,
  signal?: AbortSignal,
): Promise<void> {
  let written = 0;
  async function* chunks() {
    for await (const chunk of stream) {
      if (
        !Buffer.isBuffer(chunk) ||
        (written += chunk.length) > size ||
        written > MAX_DIRECT_IMAGE_BYTES
      ) {
        throw new Error('Stored image exceeds its transfer limit');
      }
      yield chunk;
    }
    if (written !== size) throw new Error('Stored image is incomplete');
  }
  try {
    await pipeline(chunks(), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
  } finally {
    stream.destroy();
  }
}

/** Stream from the configured backend into a private temporary file, then hand it to storage. */
export async function withMCPImageDownload<T>(
  origin: string,
  download: ImageDownload,
  processFile: (path: string, mime: string, size: number, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const duration = Math.min(download.expires_at - Date.now(), MAX_TRANSFER_MS);
  if (duration <= 0) throw new Error('image_download_failed');
  const timeout = AbortSignal.timeout(duration);
  const signal = download.signal ? AbortSignal.any([timeout, download.signal]) : timeout;
  return withTemporaryMCPImage(async (path) => {
    let mime: string;
    let size: number;
    try {
      const response = await fetch(new URL('/api/mcp/media/download', origin), {
        headers: { 'X-Media-Download-Ticket': download.ticket, 'Accept-Encoding': 'identity' },
        redirect: 'error',
        signal,
      });
      if (response.status === 404) {
        await response.body?.cancel();
        throw new Error('image_target_unavailable');
      }
      mime = response.headers.get('content-type')?.split(';', 1)[0] ?? '';
      size = Number(response.headers.get('content-length'));
      if (
        response.status !== 200 ||
        !response.body ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > MAX_DIRECT_IMAGE_BYTES ||
        (response.headers.get('content-encoding') ?? 'identity') !== 'identity'
      ) {
        await response.body?.cancel();
        throw new Error('Invalid image response');
      }
      const reader = response.body.getReader();
      async function* chunks() {
        let written = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            written += chunk.value.length;
            if (written > size) throw new Error('Image exceeds declared size');
            yield chunk.value;
          }
          if (written !== size) throw new Error('Incomplete image');
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      await pipeline(chunks(), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
    } catch (error) {
      if (error instanceof Error && error.message === 'image_target_unavailable') throw error;
      throw new Error('image_download_failed');
    }
    return await processFile(path, mime, size, signal);
  });
}
