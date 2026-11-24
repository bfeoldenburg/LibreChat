import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AppConfig } from '@librechat/data-schemas';
import type { ImageFile } from 'librechat-data-provider';
import type { Artifacts, ParsedServerConfig } from './types';
import type { ImageImportDependencies } from './images';
import type { AgentMCPToolInvoker } from './agent';
import { asMCPImageFile } from './images';

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
  findFileById: ImageImportDependencies['findFileById'];
};
const targetSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  toolCallId: z.string().min(1).max(256),
});
const receiptSchema = z.object({
  delivery_status: z.literal('stored'),
  file_id: z.string().uuid(),
  display_file_id: z.string().uuid(),
});

/** Prepare a real result row before the MCP can import, using host metadata only. */
export function createMCPImageInvoker({
  enabled,
  serverConfig,
  toolName,
  invokeTool,
  deps,
}: {
  enabled?: boolean;
  serverConfig?: Pick<ParsedServerConfig, 'source' | 'dbId'>;
  toolName: string;
  invokeTool: AgentMCPToolInvoker;
  deps: Dependencies;
}) {
  const dispatched = new Set<string>();
  return async (
    manager: Parameters<AgentMCPToolInvoker>[0],
    invocation: Parameters<AgentMCPToolInvoker>[1],
    context: Context,
  ): ReturnType<AgentMCPToolInvoker> => {
    if (
      !enabled ||
      toolName !== 'generate_image' ||
      serverConfig?.source === 'user' ||
      serverConfig?.source === 'plugin' ||
      (serverConfig?.source == null && serverConfig?.dbId)
    )
      return invokeTool(manager, invocation);
    const user = invocation.user;
    const parsed = targetSchema.safeParse(context);
    if (!user?.id || !parsed.success) throw new Error('image_context_unavailable');
    const { conversationId, messageId, toolCallId } = parsed.data;
    const [conversation, config] = await Promise.all([
      deps.getConvo(user.id, conversationId),
      deps.getAppConfig({ userId: user.id, role: user.role, tenantId: user.tenantId }),
    ]);
    if (
      !conversation ||
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
        interfaceConfig: config?.interfaceConfig,
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
    const callId = createHash('sha256')
      .update(JSON.stringify([user.id, conversationId, messageId, toolCallId]))
      .digest('hex');
    const result = await invokeTool(manager, {
      ...invocation,
      imageContext: () => {
        const newIntent = !dispatched.has(callId);
        dispatched.add(callId);
        return {
          conversation_id: conversationId,
          message_id: messageId,
          call_id: callId,
          new_intent: newIntent,
        };
      },
    });
    // Only a native receipt from this configured tool can become a host attachment.
    let body: unknown;
    try {
      body = JSON.parse(result[0]);
    } catch {
      return result;
    }
    const receipt = receiptSchema.safeParse(body);
    if (!receipt.success) return result;
    const file = await deps.findFileById(receipt.data.display_file_id);
    if (
      !file ||
      String(file.user) !== user.id ||
      (file.tenantId ?? null) !== (user.tenantId ?? null) ||
      file.conversationId !== conversationId ||
      file.messageId !== messageId ||
      (file.expiredAt && file.expiredAt.getTime() <= Date.now())
    ) {
      throw new Error('image_attachment_unavailable');
    }
    return [result[0], { ...result[1], nativeImageFiles: [asMCPImageFile(file)] }];
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
}) {
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
