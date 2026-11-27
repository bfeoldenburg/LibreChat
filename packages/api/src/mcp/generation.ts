import { z } from 'zod';
import { setTimeout } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { FileGenerationDetails, ImageFile } from 'librechat-data-provider';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type {
  Artifacts,
  FormattedToolResponse,
  MCPToolCallResponse,
  ParsedServerConfig,
} from './types';
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
type JobBinding = {
  key: string;
  fileId: string;
  toolCallId: string;
  generation?: FileGenerationDetails;
};
type PickupTarget = JobScope & { messageId: string; toolCallId: string };
type Pickup = PickupTarget & { serverName: string; reference: string; expiresAt: number };
type Dependencies = {
  bindJob: (
    target: JobScope & { messageId: string },
    binding: JobBinding & {
      pickupExpiresAt?: number;
      pickupResolution?: { width: number; height: number };
    },
  ) => Promise<boolean>;
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
type LookupDependencies = Pick<Dependencies, 'getConvo' | 'findJob' | 'getAppConfig' | 'saveImage'>;
type LookupTool = 'get_media_job_status' | 'get_media_result';
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
const pickupSchema = z.object({
  status: z.enum(['queued', 'running', 'image_ready']),
  acceptance: z.literal('confirmed'),
  pickup_expires_at: z.number().int().positive(),
  resolution: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional()
    .catch(undefined),
});
const statusSchema = z.object({ status: z.string() });
const pickupRetryStatuses = new Set([
  'queued',
  'running',
  'backend_unavailable',
  'image_download_failed',
  'image_storage_failed',
]);
const MAX_PICKUP_MS = 30 * 60 * 60 * 1000; // Upper bound of the private MCP job cache.
const PICKUP_INTERVAL_MS = 5_000; // One status read per interval while the backend is working.
const resultSchema = z.object({
  job_reference: jobReference,
  status: z.literal('image_ready'),
  delivery_status: z.literal('pending'),
  job_status: z.literal('succeeded').optional(),
  acceptance: z.literal('confirmed').optional(),
  pickup_expires_at: pickupSchema.shape.pickup_expires_at.optional(),
  resolution: pickupSchema.shape.resolution,
});
const downloadTicketSchema = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{1,1024}={0,2}$/),
  expires_at: z.number().int().positive(),
});
const generationArgumentsSchema = z.object({
  prompt: z.string().max(16384).optional().catch(undefined),
  settings: z
    .object({
      steps: z.number().int().positive().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

function imageGenerationDetails(args: unknown): FileGenerationDetails | undefined {
  const parsed = generationArgumentsSchema.safeParse(args);
  if (!parsed.success) return;
  const prompt = parsed.data.prompt?.trim() ? parsed.data.prompt : undefined;
  const steps = parsed.data.settings?.steps;
  if (prompt != null || steps != null) return { prompt, steps };
}

function parseResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function lookupError(
  tool: string,
  status:
    | 'job_unavailable'
    | 'invalid_parameters'
    | 'backend_unavailable'
    | 'image_download_failed',
): FormattedToolResponse {
  const messages = {
    job_unavailable: 'Dieser Bildauftrag ist nicht verfügbar. Keinen Ersatzauftrag starten.',
    invalid_parameters: 'Nur die öffentliche Auftragsreferenz job_reference angeben.',
    backend_unavailable:
      'Der Bildauftrag kann derzeit nicht abgefragt werden. Keinen Ersatzauftrag starten.',
    image_download_failed:
      'Das vorhandene Bild konnte nicht abgerufen werden. Keinen Ersatzauftrag starten.',
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
  directDownload = false,
): FormattedToolResponse | undefined {
  const ready = resultSchema.safeParse(result?.structuredContent);
  if (!ready.success || result?.isError) return undefined;
  const transfer = result?._meta?.['librechat/media-download'];
  if (transfer != null) {
    const parsed = downloadTicketSchema.safeParse(transfer);
    return directDownload && parsed.success
      ? [JSON.stringify(ready.data), { mediaDownload: parsed.data }]
      : storageFailed(ready.data.job_reference);
  }
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
  target: Omit<ImageStorageInput, 'dataUrl' | 'download'>,
  saveImage: Dependencies['saveImage'],
  signal?: AbortSignal,
): Promise<FormattedToolResponse> {
  const transfer = result[1]?.mediaDownload;
  const image = result[1]?.content?.[0];
  const base64 =
    result[1]?.content?.length === 1 && image?.type === 'image_url'
      ? { dataUrl: image.image_url.url }
      : undefined;
  const source = transfer ? { download: { ...transfer, signal } } : base64;
  if (!source) {
    return storageFailed(publicResult.job_reference);
  }
  const saved = await saveImage({ ...target, ...source });
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

function bindingKey(serverName: string, reference: string): string {
  return JSON.stringify([serverName, reference]);
}

async function lookupImageJob({
  deps,
  scope,
  user,
  serverName,
  reference,
  toolName,
  invoke,
  signal,
}: {
  deps: LookupDependencies;
  scope: JobScope;
  user: IUser;
  serverName: string;
  reference: string;
  toolName: LookupTool;
  invoke: (directDownload: boolean) => Promise<FormattedToolResponse>;
  signal?: AbortSignal;
}): Promise<FormattedToolResponse> {
  const [conversation, binding] = await Promise.all([
    deps.getConvo(scope.userId, scope.conversationId),
    deps.findJob(scope, bindingKey(serverName, reference)),
  ]).catch(() => [undefined, undefined] as const);
  if (conversation === undefined) return lookupError(toolName, 'backend_unavailable');
  if (signal?.aborted || !binding || !conversationAvailable(conversation, user)) {
    return lookupError(toolName, 'job_unavailable');
  }
  const config =
    toolName === 'get_media_result'
      ? await deps
          .getAppConfig({ userId: scope.userId, role: user.role, tenantId: scope.tenantId })
          .catch(() => undefined)
      : undefined;
  if (toolName === 'get_media_result' && !config) return storageFailed(reference);
  const result = await invoke(!!config?.mcpSettings?.mediaDownloadOrigin);
  if (toolName === 'get_media_job_status' || isMCPToolResultError(result)) return result;
  const ready = resultSchema.safeParse(parseResult(result[0])).data;
  if (!ready) return [result[0], undefined];
  if (signal?.aborted || ready.job_reference !== reference) {
    return lookupError(toolName, 'job_unavailable');
  }
  try {
    if (!config) return storageFailed(reference);
    if (signal?.aborted || !conversationAvailable(conversation, user)) {
      return lookupError(toolName, 'job_unavailable');
    }
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
        bindingKey: binding.key,
        ...(binding.generation && { generation: binding.generation }),
      },
      deps.saveImage,
      signal,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'image_target_unavailable') {
      return lookupError(toolName, 'job_unavailable');
    }
    if (error instanceof Error && error.message === 'image_download_failed') {
      return lookupError(toolName, 'image_download_failed');
    }
    return storageFailed(reference);
  }
}

/** Retrieve an accepted job in server scope after the originating request ends. */
export function createMCPImagePickup({
  deps,
  intervalMs = PICKUP_INTERVAL_MS,
}: {
  deps: LookupDependencies & {
    runWithScope: <T>(scope: JobScope, action: () => Promise<T>) => Promise<T>;
    getUser: (userId: string) => Promise<IUser | null>;
    canUseServers: (user: IUser) => Promise<boolean>;
    getServerConfigs: (userId: string, user: IUser) => Promise<Record<string, ParsedServerConfig>>;
    getManager: (userId: string) => Parameters<AgentMCPToolInvoker>[0];
    getFlowManager: () => Parameters<AgentMCPToolInvoker>[1]['flowManager'];
    settlePickup: (target: PickupTarget) => Promise<void>;
  };
  intervalMs?: number;
}): (pickup: Pickup) => void {
  const active = new Set<string>();
  const toolName = 'get_media_result';
  return (pickup) => {
    const {
      userId,
      tenantId,
      conversationId,
      messageId,
      toolCallId,
      serverName,
      reference,
      expiresAt,
    } = pickup;
    const duration = Math.min(MAX_PICKUP_MS, expiresAt - Date.now());
    if (duration <= 0) return;
    const key = JSON.stringify([userId, tenantId, conversationId, serverName, reference]);
    if (active.has(key)) return;
    active.add(key);
    const signal = AbortSignal.timeout(duration);
    const scope = { userId, tenantId, conversationId };
    const requestBody = { messageId: randomUUID() };

    const poll = async () => {
      while (!signal.aborted) {
        const result = await deps
          .runWithScope(scope, async () => {
            const row = await deps.getUser(userId);
            if (!row || (row.tenantId ?? null) !== (tenantId ?? null)) {
              return lookupError(toolName, 'job_unavailable');
            }
            const user = Object.assign(row, { id: userId });
            if (!(await deps.canUseServers(user))) return lookupError(toolName, 'job_unavailable');
            return lookupImageJob({
              deps,
              scope,
              user,
              serverName,
              reference,
              toolName,
              signal,
              invoke: async (directMediaDownload) => {
                const configs = await deps.getServerConfigs(userId, user);
                const serverConfig = Object.prototype.hasOwnProperty.call(configs, serverName)
                  ? configs[serverName]
                  : undefined;
                if (!serverConfig || signal.aborted)
                  return lookupError(toolName, 'job_unavailable');
                return deps.getManager(userId).callTool({
                  user,
                  serverName,
                  serverConfig,
                  toolName,
                  provider: 'openai',
                  toolArguments: { job_reference: reference },
                  requestBody,
                  nativeImageResult: true,
                  directMediaDownload,
                  unattended: true,
                  options: { signal },
                  flowManager: deps.getFlowManager(),
                });
              },
            });
          })
          .catch(() => lookupError(toolName, 'backend_unavailable'));
        const status = statusSchema.safeParse(parseResult(result[0])).data?.status;
        if (!status || !pickupRetryStatuses.has(status)) return;
        await setTimeout(intervalMs, undefined, { signal, ref: false });
      }
    };

    // Start without the chat's abort signal, request-scoped connections or OAuth callbacks.
    void poll()
      .finally(async () => {
        try {
          await deps.runWithScope(scope, () =>
            deps.settlePickup({ ...scope, messageId, toolCallId }),
          );
        } finally {
          active.delete(key);
        }
      })
      .catch(() => undefined);
  };
}

/** Bind the existing job to its original response and store native images in the host. */
export function createMCPImageInvoker({
  invokeTool,
  deps,
  enqueuePickup,
}: {
  invokeTool: AgentMCPToolInvoker;
  deps: Dependencies;
  enqueuePickup?: (pickup: Pickup) => void;
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
    if (lookup) {
      const args = lookupSchema.safeParse(invocation.toolArguments);
      if (!args.success) return lookupError(toolName, 'invalid_parameters');
      if (!scope || !user) return lookupError(toolName, 'job_unavailable');
      return lookupImageJob({
        deps,
        scope,
        user,
        serverName,
        reference: args.data.job_reference,
        toolName,
        signal: invocation.options?.signal,
        invoke: (directMediaDownload) =>
          invokeTool(manager, {
            ...invocation,
            nativeImageResult: toolName === 'get_media_result',
            directMediaDownload,
          }),
      });
    }

    const callId =
      user?.id && target.success
        ? createHash('sha256')
            .update(JSON.stringify([user.id, invocation.serverName, target.data]))
            .digest('hex')
        : undefined;
    const config = scope ? await getConfig()?.catch(() => undefined) : undefined;
    const result = await invokeTool(manager, {
      ...invocation,
      directMediaDownload: !!config?.mcpSettings?.mediaDownloadOrigin,
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
      const conversation = await deps.getConvo(user.id, conversationId);
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
      const generation = imageGenerationDetails(invocation.toolArguments);
      const failed = isMCPToolResultError(result);
      const pickup = !failed && enqueuePickup ? pickupSchema.safeParse(data).data : undefined;
      const expiresAt =
        pickup &&
        Math.min(
          pickup.pickup_expires_at,
          conversation.expiredAt?.getTime() ?? Infinity,
          Date.now() + MAX_PICKUP_MS,
        );
      if (
        !(await deps.bindJob(
          { ...scope, messageId },
          {
            key: bindingKey(serverName, reference),
            fileId,
            toolCallId,
            ...(generation && { generation }),
            ...(expiresAt != null && { pickupExpiresAt: expiresAt }),
            ...(pickup?.resolution && { pickupResolution: pickup.resolution }),
          },
        ))
      ) {
        return storageFailed(reference);
      }
      if (failed) return result;
      if (expiresAt != null && pickup?.status !== 'image_ready') {
        enqueuePickup?.({ ...scope, messageId, toolCallId, serverName, reference, expiresAt });
        return [result[0], undefined];
      }
      const ready = resultSchema.safeParse(data).data;
      if (!ready) return result;
      try {
        return await storeResult(
          result,
          ready,
          {
            user,
            config,
            conversationId,
            messageId,
            fileId,
            toolCallId,
            bindingKey: bindingKey(serverName, reference),
            ...(generation && { generation }),
          },
          deps.saveImage,
          invocation.options?.signal,
        );
      } catch (error) {
        if (expiresAt == null || !enqueuePickup) throw error;
        enqueuePickup({ ...scope, messageId, toolCallId, serverName, reference, expiresAt });
        return [
          JSON.stringify({
            status: 'running',
            acceptance: 'confirmed',
            job_reference: reference,
            pickup_expires_at: expiresAt,
            resolution: ready.resolution,
            message: 'LibreChat holt das fertige Bild im Hintergrund ab.',
          }),
          undefined,
        ];
      }
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
