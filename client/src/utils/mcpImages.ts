import { Constants, ContentTypes } from 'librechat-data-provider';
import type { TMessage, TAttachment } from 'librechat-data-provider';

type Pickup = NonNullable<TMessage['mcpImagePickups']>[number];
type Message = Pick<
  TMessage,
  'isCreatedByUser' | 'isUserSubmitted' | 'attachments' | 'mcpImagePickups'
> & {
  content?: Array<NonNullable<TMessage['content']>[number] | undefined>;
};

export function isNativeMCPImage(attachment: TAttachment): boolean {
  return 'metadata' in attachment && attachment.metadata?.mcpImage === true;
}

/** Recover pending results from the stream until the authoritative history record arrives. */
export function pendingMCPImages(message: Message, now: number): Pickup[] {
  if (message.isCreatedByUser || message.isUserSubmitted) return [];
  const received = (toolCallId: string) =>
    message.attachments?.some(
      (attachment) => attachment?.toolCallId === toolCallId && 'file_id' in attachment,
    );
  if (message.mcpImagePickups != null) {
    return message.mcpImagePickups.filter(
      ({ toolCallId, expiresAt }) => expiresAt > now && !received(toolCallId),
    );
  }

  const pending: Pickup[] = [];
  for (const part of message.content ?? []) {
    if (part?.type !== ContentTypes.TOOL_CALL) continue;
    const call = part.tool_call;
    if (!call || typeof call !== 'object' || typeof call.id !== 'string') continue;
    const tool = 'function' in call ? call.function : call;
    if (
      !tool ||
      typeof tool !== 'object' ||
      !('name' in tool) ||
      typeof tool.name !== 'string' ||
      !('output' in tool)
    )
      continue;
    if (
      tool.name !== 'generate_image' &&
      !tool.name.startsWith(`generate_image${Constants.mcp_delimiter}`)
    )
      continue;
    if (received(call.id) || typeof tool.output !== 'string' || tool.output.length > 2048) continue;
    try {
      const result: {
        status?: string;
        acceptance?: string;
        pickup_expires_at?: number;
        resolution?: Pickup['resolution'];
      } | null = JSON.parse(tool.output);
      if (
        result?.acceptance !== 'confirmed' ||
        (result.status !== 'queued' && result.status !== 'running') ||
        typeof result.pickup_expires_at !== 'number' ||
        !Number.isSafeInteger(result.pickup_expires_at) ||
        result.pickup_expires_at <= now ||
        result.pickup_expires_at > now + 30 * 60 * 60 * 1000
      )
        continue;
      pending.push({
        toolCallId: call.id,
        expiresAt: result.pickup_expires_at,
        resolution: result.resolution,
      });
    } catch {
      // Other image tools can return plain text.
    }
  }
  return pending;
}
