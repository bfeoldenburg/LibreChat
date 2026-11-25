import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { ImageFile } from 'librechat-data-provider';
import type { Artifacts, FormattedToolResponse, MCPToolCallResponse } from './types';
import type { AgentMCPToolInvoker } from './agent';
import type { ImageStorageInput } from './images';
import { isMCPToolResultError, markMCPToolResultError } from './status';
import { formatToolContent } from './parsers';

type Context = { conversationId?: string; messageId?: string; toolCallId?: string };
type ResultTarget = {
  conversationId?: string;
  tenantId?: string;
  isCreatedByUser?: boolean;
  isUserSubmitted?: boolean;
  expiredAt?: Date | null;
};
type JobScope = { userId: string; tenantId?: string; conversationId: string };
type JobBinding = { key: string; fileId: string; toolCallId: string };
type Dependencies = {
  bindJob: (target: JobScope & { messageId: string }, binding: JobBinding) => Promise<boolean>;
  findJob: (scope: JobScope, key: string) => Promise<(JobBinding & { messageId: string }) | null>;
  saveMessage: (
    context: {
      userId: string;
      isTemporary?: boolean;
      expiredAt?: Date;
      interfaceConfig?: AppConfig['interfaceConfig'];
    },
    message: {
      messageId: string;
      conversationId: string;
      isCreatedByUser: false;
      isUserSubmitted: false;
      unfinished: true;
      sender: string;
      text: string;
    },
    metadata: { insertOnly: true },
  ) => Promise<ResultTarget | null | undefined>;
  getConvo: (
    userId: string,
    conversationId: string,
  ) => Promise<{
    tenantId?: string;
    isTemporary?: boolean;
    expiredAt?: Date | null;
  } | null>;
  getAppConfig: (user: {
    userId: string;
    role?: string;
    tenantId?: string;
  }) => Promise<AppConfig | undefined>;
  saveImage: (input: ImageStorageInput) => Promise<ImageFile>;
};
const targetSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  toolCallId: z.string().min(1).max(256),
});
const jobReference = z.string().regex(/^[0-9a-f]{32}$/);
const lookupSchema = z.strictObject({ job_reference: jobReference });
const startedSchema = z.object({
  job_reference: jobReference,
  delivery_status: z.enum(['not_started', 'pending', 'failed']),
});
const resultSchema = z.object({
  job_reference: jobReference,
  status: z.literal('image_ready'),
  delivery_status: z.literal('pending'),
  job_status: z.literal('succeeded').optional(),
  acceptance: z.literal('confirmed').optional(),
});

function parseResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function lookupError(
  tool: string,
  status: 'job_unavailable' | 'invalid_parameters' | 'backend_unavailable',
): FormattedToolResponse {
  const messages = {
    job_unavailable: 'Dieser Bildauftrag ist nicht verfügbar. Keinen Ersatzauftrag starten.',
    invalid_parameters: 'Nur die öffentliche Auftragsreferenz job_reference angeben.',
    backend_unavailable:
      'Der Bildauftrag kann derzeit nicht abgefragt werden. Keinen Ersatzauftrag starten.',
  };
  return markMCPToolResultError(
    [
      JSON.stringify({ status, job_created: false, tool, message: messages[status], errors: [] }),
      undefined,
    ],
    true,
  );
}

function conversationAvailable(
  conversation: Awaited<ReturnType<Dependencies['getConvo']>>,
  user: IUser,
): conversation is NonNullable<typeof conversation> {
  return (
    conversation != null &&
    (conversation.tenantId ?? null) === (user.tenantId ?? null) &&
    (!conversation.expiredAt || conversation.expiredAt.getTime() > Date.now())
  );
}

function imageId(callId: string): string {
  const id = createHash('sha256')
    .update('mcp-image:' + callId)
    .digest('hex');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-5${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
}

function storageFailed(jobReference: string): FormattedToolResponse {
  return markMCPToolResultError(
    [
      JSON.stringify({
        job_reference: jobReference,
        status: 'image_storage_failed',
        delivery_status: 'failed',
        message: 'Das Bild konnte nicht nativ gespeichert werden. Keinen Ersatzauftrag starten.',
      }),
      undefined,
    ],
    true,
  );
}

/** Keep generated image data out of the provider and MCP Apps output. */
export function formatMCPImageJobResult(
  result: MCPToolCallResponse,
): FormattedToolResponse | undefined {
  const ready = resultSchema.safeParse(result?.structuredContent);
  if (!ready.success || result?.isError) return undefined;
  const images = result?.content?.filter((part) => part.type === 'image') ?? [];
  if (images.length !== 1) return storageFailed(ready.data.job_reference);
  try {
    const [, artifacts] = formatToolContent({ content: images }, 'openai');
    return [JSON.stringify(ready.data), artifacts];
  } catch {
    return storageFailed(ready.data.job_reference);
  }
}

async function storeResult(
  result: FormattedToolResponse,
  publicResult: z.infer<typeof resultSchema>,
  target: Omit<ImageStorageInput, 'dataUrl'>,
  saveImage: Dependencies['saveImage'],
): Promise<FormattedToolResponse> {
  const image = result[1]?.content?.[0];
  if (result[1]?.content?.length !== 1 || image?.type !== 'image_url') {
    return storageFailed(publicResult.job_reference);
  }
  const saved = await saveImage({ ...target, dataUrl: image.image_url.url });
  return [
    JSON.stringify({
      ...publicResult,
      status: 'stored',
      delivery_status: 'stored',
      file_id: saved.metadata?.imageOriginalFileId ?? saved.file_id,
      display_file_id: saved.file_id,
      message:
        'Das Bild ist als nativer Anhang an der ursprünglichen Ergebnisnachricht gespeichert.',
    }),
    {
      nativeImageFiles: [{ ...saved, messageId: target.messageId, toolCallId: target.toolCallId }],
    },
  ];
}

/** Bind the existing job to its original response and store native images in the host. */
export function createMCPImageInvoker({
  invokeTool,
  deps,
}: {
  invokeTool: AgentMCPToolInvoker;
  deps: Dependencies;
}): (
  manager: Parameters<AgentMCPToolInvoker>[0],
  invocation: Parameters<AgentMCPToolInvoker>[1],
  context: Context,
) => ReturnType<AgentMCPToolInvoker> {
  const dispatched = new Set<string>();
  return async (manager, invocation, context) => {
    const { toolName, serverName } = invocation;
    const lookup = toolName === 'get_media_job_status' || toolName === 'get_media_result';
    if (!lookup && toolName !== 'generate_image') return invokeTool(manager, invocation);
    const user = invocation.user;
    const target = targetSchema.safeParse(context);
    const scope =
      user?.id && target.success
        ? { userId: user.id, tenantId: user.tenantId, conversationId: target.data.conversationId }
        : undefined;
    const getConfig = () =>
      scope &&
      deps.getAppConfig({ userId: scope.userId, role: user?.role, tenantId: scope.tenantId });
    const bindingKey = (reference: string) => JSON.stringify([serverName, reference]);
    if (lookup) {
      const args = lookupSchema.safeParse(invocation.toolArguments);
      if (!args.success) return lookupError(toolName, 'invalid_parameters');
      if (!scope || !user) return lookupError(toolName, 'job_unavailable');
      const reference = args.data.job_reference;
      const [conversation, binding] = await Promise.all([
        deps.getConvo(scope.userId, scope.conversationId),
        deps.findJob(scope, bindingKey(reference)),
      ]).catch(() => [undefined, undefined] as const);
      if (conversation === undefined) return lookupError(toolName, 'backend_unavailable');
      if (!binding || !conversationAvailable(conversation, user)) {
        return lookupError(toolName, 'job_unavailable');
      }
      const result = await invokeTool(manager, {
        ...invocation,
        nativeImageResult: toolName === 'get_media_result',
      });
      if (toolName === 'get_media_job_status' || isMCPToolResultError(result)) return result;
      const ready = resultSchema.safeParse(parseResult(result[0])).data;
      if (!ready) return [result[0], undefined];
      if (ready.job_reference !== reference) return lookupError(toolName, 'job_unavailable');
      try {
        const config = await getConfig();
        if (!config) return storageFailed(reference);
        return await storeResult(
          result,
          ready,
          {
            user,
            config,
            conversationId: scope.conversationId,
            messageId: binding.messageId,
            fileId: binding.fileId,
            toolCallId: binding.toolCallId,
          },
          deps.saveImage,
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'image_target_unavailable') {
          return lookupError(toolName, 'job_unavailable');
        }
        return storageFailed(reference);
      }
    }

    const callId =
      user?.id && target.success
        ? createHash('sha256')
            .update(JSON.stringify([user.id, invocation.serverName, target.data]))
            .digest('hex')
        : undefined;
    const result = await invokeTool(manager, {
      ...invocation,
      ...(callId && {
        requestMeta: () => {
          const newIntent = !dispatched.has(callId);
          dispatched.add(callId);
          return { 'librechat/call': { call_id: callId, new_intent: newIntent } };
        },
      }),
    });
    const data = parseResult(result[0]);
    const started = startedSchema.safeParse(data).data;
    if (!started) return result;
    const reference = started.job_reference;
    try {
      if (!user || !scope || !target.success || !callId) return storageFailed(reference);
      const { conversationId, messageId, toolCallId } = target.data;
      const [conversation, config] = await Promise.all([
        deps.getConvo(user.id, conversationId),
        getConfig(),
      ]);
      if (!config || !conversationAvailable(conversation, user)) return storageFailed(reference);
      const row = await deps.saveMessage(
        {
          userId: user.id,
          isTemporary: conversation.isTemporary,
          expiredAt: conversation.expiredAt ?? undefined,
          interfaceConfig: config.interfaceConfig,
        },
        {
          messageId,
          conversationId,
          isCreatedByUser: false,
          isUserSubmitted: false,
          unfinished: true,
          sender: 'Assistant',
          text: '',
        },
        { insertOnly: true },
      );
      if (
        !row ||
        row.conversationId !== conversationId ||
        (row.tenantId ?? null) !== (user.tenantId ?? null) ||
        row.isCreatedByUser !== false ||
        row.isUserSubmitted === true ||
        (row.expiredAt && row.expiredAt.getTime() <= Date.now())
      ) {
        return storageFailed(reference);
      }
      const fileId = imageId(callId);
      if (
        !(await deps.bindJob(
          { ...scope, messageId },
          { key: bindingKey(reference), fileId, toolCallId },
        ))
      ) {
        return storageFailed(reference);
      }
      const ready = resultSchema.safeParse(data).data;
      if (!ready || isMCPToolResultError(result)) return result;
      return await storeResult(
        result,
        ready,
        { user, config, conversationId, messageId, fileId, toolCallId },
        deps.saveImage,
      );
    } catch {
      return storageFailed(reference);
    }
  };
}

/** Reuse native files in the normal attachment event and final response assembly. */
export function collectMCPImageAttachments({
  artifact,
  artifactPromises,
  metadata,
  toolCallId,
  writeAttachment,
}: {
  artifact: Artifacts;
  artifactPromises: Promise<ImageFile>[];
  metadata: { run_id?: string; thread_id?: string };
  toolCallId: string;
  writeAttachment: (file: ImageFile) => void;
}): void {
  for (const file of artifact?.nativeImageFiles ?? []) {
    const attachment = {
      ...file,
      messageId: file.messageId ?? metadata.run_id,
      conversationId: metadata.thread_id,
      toolCallId: file.toolCallId ?? toolCallId,
    };
    if (attachment.messageId === metadata.run_id) {
      artifactPromises.push(Promise.resolve(attachment));
    }
    writeAttachment(attachment);
  }
}
