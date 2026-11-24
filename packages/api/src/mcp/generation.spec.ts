import type { IUser } from '@librechat/data-schemas';
import type { AgentMCPToolInvoker } from './agent';
import { createMCPImageInvoker } from './generation';

const userId = 'a'.repeat(24);
const conversationId = '11111111-1111-4111-8111-111111111111';
const context = { conversationId, messageId: 'trusted-answer', toolCallId: 'qwen-call' };

function harness() {
  const saved = { conversationId, isCreatedByUser: false, isUserSubmitted: false };
  const saveMessage = jest.fn(async (): Promise<typeof saved | undefined> => saved);
  const getConvo = jest.fn(async () => ({}));
  const invokeTool = jest.fn<ReturnType<AgentMCPToolInvoker>, Parameters<AgentMCPToolInvoker>>(
    async (_manager, input) => {
      input.imageContext?.();
      return ['{"status":"queued"}', undefined];
    },
  );
  const deps = {
    saveMessage,
    getConvo,
    getAppConfig: jest.fn(async () => undefined),
    findFileById: jest.fn(async () => null),
  };
  const manager = { callTool: jest.fn() };
  const invocation: Parameters<AgentMCPToolInvoker>[1] = {
    user: { id: userId } as IUser,
    serverName: 'bfe-medien',
    toolName: 'generate_image',
    provider: 'openai',
    toolArguments: { prompt: 'Qwen prompt', message_id: 'forged' },
    flowManager: {} as Parameters<AgentMCPToolInvoker>[1]['flowManager'],
  };
  const call = createMCPImageInvoker({
    enabled: true,
    toolName: 'generate_image',
    invokeTool,
    deps,
  });
  return { call, deps, manager, invocation, invokeTool, saved };
}

it('requires trusted server context before invoking the MCP', async () => {
  const h = harness();
  await expect(h.call(h.manager, h.invocation, {})).rejects.toThrow('image_context_unavailable');
  expect(h.invokeTool).not.toHaveBeenCalled();
});

it('refuses an unpersisted result message', async () => {
  const h = harness();
  h.deps.saveMessage.mockResolvedValueOnce(undefined);
  await expect(h.call(h.manager, h.invocation, context)).rejects.toThrow(
    'image_context_unavailable',
  );
  expect(h.invokeTool).not.toHaveBeenCalled();
});

it('rejects a user-authored result row and a different conversation', async () => {
  const h = harness();
  h.deps.saveMessage.mockResolvedValueOnce({ ...h.saved, isCreatedByUser: true });
  await expect(h.call(h.manager, h.invocation, context)).rejects.toThrow(
    'image_context_unavailable',
  );
  h.deps.saveMessage.mockResolvedValueOnce({ ...h.saved, conversationId: 'another' });
  await expect(h.call(h.manager, h.invocation, context)).rejects.toThrow(
    'image_context_unavailable',
  );
  expect(h.invokeTool).not.toHaveBeenCalled();
});

it('marks subsequent transport attempts as retries and ignores model target IDs', async () => {
  const h = harness();
  const metadata: Record<string, string | boolean>[] = [];
  h.invokeTool.mockImplementation(async (_manager, input) => {
    metadata.push(input.imageContext!());
    throw new Error('synthetic transport loss');
  });
  await expect(h.call(h.manager, h.invocation, context)).rejects.toThrow(
    'synthetic transport loss',
  );
  await expect(h.call(h.manager, h.invocation, context)).rejects.toThrow(
    'synthetic transport loss',
  );
  expect(metadata.map((item) => item.new_intent)).toEqual([true, false]);
  expect(metadata[0]).toEqual({
    conversation_id: conversationId,
    message_id: context.messageId,
    call_id: expect.stringMatching(/^[0-9a-f]{64}$/),
    new_intent: true,
  });
  expect(metadata[1].call_id).toBe(metadata[0].call_id);
  expect(h.deps.saveMessage).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      messageId: context.messageId,
      conversationId,
      isCreatedByUser: false,
    }),
    { insertOnly: true },
  );
});

it('does not turn an unverified receipt into a native attachment', async () => {
  const h = harness();
  h.invokeTool.mockResolvedValue([
    '{"delivery_status":"stored","file_id":"bad","display_file_id":"bad"}',
    undefined,
  ]);
  const result = await h.call(h.manager, h.invocation, context);
  expect(result[1]).toBeUndefined();
  expect(h.deps.findFileById).not.toHaveBeenCalled();
});

it('keeps other tools and disabled integrations on the existing invocation path', async () => {
  const h = harness();
  const call = createMCPImageInvoker({
    enabled: false,
    toolName: 'generate_image',
    invokeTool: h.invokeTool,
    deps: h.deps,
  });
  await call(h.manager, h.invocation, {});
  expect(h.deps.saveMessage).not.toHaveBeenCalled();
  expect(h.invokeTool).toHaveBeenCalledWith(h.manager, h.invocation);
});
