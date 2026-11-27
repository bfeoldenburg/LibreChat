import type { IUser, AppConfig } from '@librechat/data-schemas';
import type { ImageFile } from 'librechat-data-provider';
import type { AgentMCPToolInvoker } from './agent';
import type { ImageStorageInput } from './images';
import { createMCPImageInvoker, formatMCPImageJobResult } from './generation';
import { isMCPToolResultError, markMCPToolResultError } from './status';

const conversationId = '11111111-1111-4111-8111-111111111111';
const context = { conversationId, messageId: 'trusted-answer', toolCallId: 'qwen-call' };
const dataUrl = 'data:image/png;base64,c3ludGhldGlj';
function harness(image = true) {
  const saved = { conversationId, isCreatedByUser: false, isUserSubmitted: false };
  const deps = {
    bindJob: jest.fn(async () => true),
    findJob: jest.fn(async () => null),
    saveMessage: jest.fn(async (): Promise<typeof saved | undefined> => saved),
    getConvo: jest.fn(async () => ({})),
    getAppConfig: jest.fn(async () => ({}) as AppConfig),
    saveImage: jest.fn(
      async (_input: ImageStorageInput) => ({ file_id: 'native-display' }) as ImageFile,
    ),
  };
  const invokeTool = jest.fn<ReturnType<AgentMCPToolInvoker>, Parameters<AgentMCPToolInvoker>>(
    async (_manager, input) => {
      input.requestMeta?.();
      return [
        JSON.stringify({
          status: image ? 'image_ready' : 'queued',
          delivery_status: image ? 'pending' : 'not_started',
          job_reference: 'f'.repeat(32),
        }),
        image ? { content: [{ type: 'image_url', image_url: { url: dataUrl } }] } : undefined,
      ];
    },
  );
  const invocation: Parameters<AgentMCPToolInvoker>[1] = {
    user: { id: 'a'.repeat(24) } as IUser,
    serverName: 'bfe-medien',
    toolName: 'generate_image',
    provider: 'openai',
    toolArguments: { prompt: 'Qwen prompt', settings: { steps: 7 }, message_id: 'forged' },
    flowManager: {} as Parameters<AgentMCPToolInvoker>[1]['flowManager'],
  };
  return {
    deps,
    invocation,
    invokeTool,
    manager: { callTool: jest.fn() },
    saved,
    call: createMCPImageInvoker({ invokeTool, deps }),
  };
}
it('provides only an opaque request identity and marks transport retries', async () => {
  const h = harness(false);
  const metadata: Record<string, unknown>[] = [];
  h.invokeTool.mockImplementation(async (_manager, input) => {
    metadata.push(input.requestMeta!());
    throw new Error('transport loss');
  });
  await expect(h.call(h.manager, h.invocation, context)).rejects.toThrow('transport loss');
  await expect(h.call(h.manager, h.invocation, context)).rejects.toThrow('transport loss');
  const first = metadata[0]['librechat/call'];
  expect(first).toEqual({ call_id: expect.stringMatching(/^[0-9a-f]{64}$/), new_intent: true });
  expect(metadata[1]['librechat/call']).toEqual({ ...(first as object), new_intent: false });
  expect(JSON.stringify(metadata)).not.toContain(conversationId);
  expect(h.deps.saveMessage).not.toHaveBeenCalled();
});
it('binds a queued job and leaves catalog results on the existing path', async () => {
  const h = harness(false);
  const result = await h.call(h.manager, h.invocation, context);
  expect(result[1]).toBeUndefined();
  expect(h.deps.bindJob).toHaveBeenCalledWith(
    {
      userId: h.invocation.user?.id,
      tenantId: undefined,
      conversationId,
      messageId: context.messageId,
    },
    {
      key: JSON.stringify([h.invocation.serverName, 'f'.repeat(32)]),
      fileId: expect.any(String),
      toolCallId: context.toolCallId,
      generation: { prompt: 'Qwen prompt', steps: 7 },
    },
  );
  expect(h.deps.saveImage).not.toHaveBeenCalled();
  h.deps.getConvo.mockClear();
  await h.call(h.manager, { ...h.invocation, toolName: 'list_media_options' }, context);
  expect(h.deps.getConvo).not.toHaveBeenCalled();
});
it('saves the existing result message before local image storage and reports stored afterward', async () => {
  const h = harness();
  h.deps.saveImage.mockImplementation(async (input) => {
    expect(h.deps.saveMessage).toHaveBeenCalledTimes(1);
    expect(input).toMatchObject({
      conversationId,
      messageId: context.messageId,
      dataUrl,
      generation: { prompt: 'Qwen prompt', steps: 7 },
    });
    return { file_id: input.fileId } as ImageFile;
  });
  const first = await h.call(h.manager, h.invocation, context);
  expect(JSON.parse(first[0]).delivery_status).toBe('stored');
  expect(first[1]?.content).toBeUndefined();
  expect(first[1]?.nativeImageFiles).toHaveLength(1);
  await h.call(h.manager, h.invocation, context);
  expect(h.deps.saveImage.mock.calls[0][0].fileId).toBe(h.deps.saveImage.mock.calls[1][0].fileId);
});
it('does not save for missing, user-authored or conflicting result messages', async () => {
  const h = harness();
  h.deps.saveMessage.mockResolvedValueOnce(undefined);
  const missing = await h.call(h.manager, h.invocation, context);
  expect(isMCPToolResultError(missing)).toBe(true);
  h.deps.saveMessage.mockResolvedValueOnce({ ...h.saved, isCreatedByUser: true });
  const authored = await h.call(h.manager, h.invocation, context);
  expect(isMCPToolResultError(authored)).toBe(true);
  h.deps.saveMessage.mockResolvedValueOnce({ ...h.saved, conversationId: 'another' });
  await h.call(h.manager, h.invocation, context);
  expect(h.deps.saveImage).not.toHaveBeenCalled();
});
it('returns a storage failure with the existing job reference and no image bytes', async () => {
  const h = harness();
  h.deps.saveImage.mockRejectedValue(new Error('private failure /internal/path secret'));
  const result = await h.call(h.manager, h.invocation, context);
  expect(isMCPToolResultError(result)).toBe(true);
  expect(JSON.parse(result[0])).toMatchObject({
    status: 'image_storage_failed',
    delivery_status: 'failed',
    job_reference: 'f'.repeat(32),
  });
  expect(JSON.stringify(result)).not.toContain('private failure');
  expect(JSON.stringify(result)).not.toContain('base64');
});
it('preserves MCP error status without attempting image storage', async () => {
  const h = harness();
  h.invokeTool.mockResolvedValue(
    markMCPToolResultError(
      ['tool error', { content: [{ type: 'image_url', image_url: { url: dataUrl } }] }],
      true,
    ),
  );
  const result = await h.call(h.manager, h.invocation, context);
  expect(isMCPToolResultError(result)).toBe(true);
  expect(h.deps.saveMessage).not.toHaveBeenCalled();
  expect(h.deps.saveImage).not.toHaveBeenCalled();
});

it('isolates native job images from model content and passes unrelated image results through', async () => {
  const h = harness();
  const unrelated = [
    'a general image tool result',
    { content: [{ type: 'image_url', image_url: { url: dataUrl } }] },
  ] as const;
  h.invokeTool.mockResolvedValue([unrelated[0], { content: [...unrelated[1].content] }]);
  expect(await h.call(h.manager, h.invocation, context)).toEqual(unrelated);
  expect(h.deps.saveImage).not.toHaveBeenCalled();

  const formatted = formatMCPImageJobResult({
    structuredContent: {
      status: 'image_ready',
      delivery_status: 'pending',
      job_reference: 'f'.repeat(32),
      ignored: 'private',
    },
    content: [{ type: 'image', mimeType: 'image/png', data: 'c3ludGhldGlj' }],
  });
  expect(formatted?.[0]).not.toMatch(/base64|private/);
  expect(formatted?.[1]?.content).toEqual(unrelated[1].content);
  const missing = formatMCPImageJobResult({
    structuredContent: {
      status: 'image_ready',
      delivery_status: 'pending',
      job_reference: 'f'.repeat(32),
    },
    content: [],
  });
  expect(missing && isMCPToolResultError(missing)).toBe(true);
});
