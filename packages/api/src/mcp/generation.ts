import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AppConfig } from '@librechat/data-schemas';
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
type Dependencies = {
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
const resultSchema = z.object({
  job_reference: z.string().regex(/^[0-9a-f]{32}$/),
  status: z.literal('image_ready'),
  delivery_status: z.literal('pending'),
  job_status: z.literal('succeeded').optional(),
  acceptance: z.literal('confirmed').optional(),
});

function readResult(text: string): z.infer<typeof resultSchema> | undefined {
  try {
    return resultSchema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
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

/** Supply an opaque retry identity, then store regular MCP image results in the host. */
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
    if (invocation.toolName !== 'generate_image') return invokeTool(manager, invocation);
    const user = invocation.user;
    const target = targetSchema.safeParse(context);
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
    if (isMCPToolResultError(result)) return result;
    const publicResult = readResult(result[0]);
    if (!publicResult) return result;
    const image = result[1]?.content?.[0];
    if (result[1]?.content?.length !== 1 || image?.type !== 'image_url') {
      return storageFailed(publicResult.job_reference);
    }
    try {
      if (!user?.id || !target.success || !callId) throw new Error('image_context_unavailable');
      const { conversationId, messageId } = target.data;
      const [conversation, config] = await Promise.all([
        deps.getConvo(user.id, conversationId),
        deps.getAppConfig({ userId: user.id, role: user.role, tenantId: user.tenantId }),
      ]);
      if (
        !conversation ||
        !config ||
        (conversation.tenantId ?? null) !== (user.tenantId ?? null) ||
        (conversation.expiredAt && conversation.expiredAt.getTime() <= Date.now())
      ) {
        throw new Error('image_context_unavailable');
      }
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
        throw new Error('image_context_unavailable');
      }
      const fileId = imageId(callId);
      const saved = await deps.saveImage({
        user,
        config,
        conversationId,
        messageId,
        fileId,
        dataUrl: image.image_url.url,
      });
      return [
        JSON.stringify({
          ...publicResult,
          status: 'stored',
          delivery_status: 'stored',
          file_id: saved.metadata?.imageOriginalFileId ?? saved.file_id,
          display_file_id: saved.file_id,
          message: 'Das Bild ist als nativer Anhang gespeichert.',
        }),
        { nativeImageFiles: [saved] },
      ];
    } catch {
      return storageFailed(publicResult.job_reference);
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
      messageId: metadata.run_id,
      conversationId: metadata.thread_id,
      toolCallId,
    };
    artifactPromises.push(Promise.resolve(attachment));
    writeAttachment(attachment);
  }
}
