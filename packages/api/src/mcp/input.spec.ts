import { Readable } from 'node:stream';
import { FileContext } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  bindMCPCompletedImages,
  getMCPImageCompletionContext,
  getMCPRequestContext,
} from './request';
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

it('reports completed images on the active branch with their originating tool calls', () => {
  const req = { body: {} };
  getMCPRequestContext(req);
  const second = '9ca8ff03-65cd-40a4-8c13-b16c30708392';
  const sibling = 'e314a4f0-327d-4439-97c6-86471d4b6d9f';
  const attachment = (file_id: string, toolCallId: string) => ({
    file_id,
    toolCallId,
    width: 800,
    height: 600,
    metadata: { mcpImage: true },
  });
  bindMCPCompletedImages(
    req,
    [
      { messageId: 'root', isCreatedByUser: true, files: [attachment(sibling, 'upload')] },
      {
        messageId: 'first',
        parentMessageId: 'root',
        isCreatedByUser: false,
        attachments: [attachment(id, 'call1')],
      },
      {
        messageId: 'other',
        parentMessageId: 'first',
        isCreatedByUser: false,
        attachments: [attachment(sibling, 'other-call')],
      },
      {
        messageId: 'second',
        parentMessageId: 'first',
        isCreatedByUser: false,
        attachments: [attachment(second, 'call2')],
      },
      { messageId: 'pending', parentMessageId: 'second', isCreatedByUser: false },
    ],
    'conversation',
    'pending',
  );

  const facts = getMCPImageCompletionContext(req)?.split('\n')[1];
  expect(JSON.parse(facts!)).toEqual([
    {
      image_number: 1,
      image_reference: `mcp-image-${id}`,
      status: 'image_ready',
      tool_call_id: 'call1',
      width: 800,
      height: 600,
    },
    {
      image_number: 2,
      image_reference: `mcp-image-${second}`,
      status: 'image_ready',
      tool_call_id: 'call2',
      width: 800,
      height: 600,
    },
  ]);
});

it('checks the exact generated-image owner, tenant, conversation, and message before reading', async () => {
  const selected = { fileId: id, conversationId: 'conversation', messageId: 'first' };
  const getFiles = jest.fn(async () => [file]);
  const readStoredImage = jest.fn(async () => Readable.from([image]));
  const input = createMCPImageInput({ getFiles, readStoredImage });
  const config = {} as AppConfig;
  await expect(
    input({ ...scope, conversationId: 'other' }, [], config, undefined, selected),
  ).resolves.toBeUndefined();
  expect(getFiles).not.toHaveBeenCalled();

  await expect(
    input({ ...scope, conversationId: 'conversation' }, [], config, undefined, selected),
  ).resolves.toBe(image.toString('base64'));
  expect(getFiles).toHaveBeenCalledWith(
    expect.objectContaining({
      file_id: { $in: [id] },
      user: scope.userId,
      tenantId: scope.tenantId,
      context: FileContext.image_generation,
      conversationId: 'conversation',
      messageId: 'first',
    }),
    null,
    expect.any(String),
    2,
  );
});
