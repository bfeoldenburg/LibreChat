import { useEffect, useState } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { Spinner, useLocalize } from '@librechat/client';
import { AttachmentGroup } from '@librechat/chat/components';
import type { TAttachment, TMessage } from 'librechat-data-provider';

type Pickup = NonNullable<TMessage['mcpImagePickups']>[number];

function PendingImage({ expiresAt, resolution }: Pickup) {
  const localize = useLocalize();
  const [expiredDeadline, setExpiredDeadline] = useState<number>();
  useEffect(() => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return;
    const timeout = setTimeout(() => setExpiredDeadline(expiresAt), remaining);
    return () => clearTimeout(timeout);
  }, [expiresAt]);
  if (expiredDeadline === expiresAt || expiresAt <= Date.now()) return null;
  const ratio =
    resolution && resolution.width > 0 && resolution.height > 0
      ? resolution.width / resolution.height
      : 1;
  const aspectRatio = Number.isFinite(ratio) ? ratio : 1;
  return (
    <div
      role="status"
      aria-label={localize('com_ui_generating_image')}
      className="bg-surface-secondary border-border-light text-text-secondary mt-1 grid max-w-full place-items-center rounded-lg border"
      style={{ aspectRatio, width: `min(100%, 32rem, ${45 * aspectRatio}vh)` }}
    >
      <Spinner />
    </div>
  );
}

/** Keep the pending and saved views in the same order and position in the reply. */
export default function MCPImages({
  pickups,
  files,
  content,
}: {
  pickups: Pickup[];
  files: TAttachment[];
  content?: Array<NonNullable<TMessage['content']>[number] | undefined>;
}) {
  if (pickups.length === 0 && files.length === 0) return null;
  const slots = new Map<string, { pickup?: Pickup; image?: TAttachment }>(
    pickups.map((pickup) => [pickup.toolCallId, { pickup }]),
  );
  for (const image of files) slots.set(image.toolCallId, { image });
  const order = new Set<string>();
  for (const part of content ?? []) {
    if (part?.type === ContentTypes.TOOL_CALL && part.tool_call?.id) order.add(part.tool_call.id);
  }
  for (const key of slots.keys()) order.add(key);
  return Array.from(order, (key) => {
    const slot = slots.get(key);
    if (!slot) return null;
    return slot.image ? (
      <AttachmentGroup key={key} attachments={[slot.image]} />
    ) : (
      slot.pickup && <PendingImage key={key} {...slot.pickup} />
    );
  });
}
