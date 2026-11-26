import sharp from 'sharp';
import express from 'express';
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createMCPImageInvoker,
  createMCPImagePickup,
  collectMCPImageAttachments,
  formatMCPImageJobResult,
} from '../../../api/src/mcp/generation';
import { isMCPToolResultError, markMCPToolResultError } from '../../../api/src/mcp/status';
import { createMCPMembershipRouter } from '../../../api/src/mcp/membership';
import { CLIENT_MESSAGE_SELECT, createMessageMethods } from './message';
import { createMCPImageStorage } from '../../../api/src/mcp/images';
import { formatToolContent } from '../../../api/src/mcp/parsers';
import { createResourceLockMethods } from './resourceLock';
import { createConversationMethods } from './conversation';
import { tenantStorage } from '~/config/tenantContext';
import { createFileMethods } from './file';
import { createModels } from '../models';
const root = process.env.MEDIA_MCP_TEST_ROOT;
const python = process.env.MEDIA_MCP_TEST_PYTHON;
const integration = root && python ? describe : describe.skip;
const OWNER = 'a'.repeat(24);
const GROUP = 'c'.repeat(24);
const READ_KEY = 'test-callback-' + 'l'.repeat(32);
const GATEWAY = 'test-gateway-' + 'g'.repeat(32);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, message) {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(25);
  }
}

integration('image retrieval with real MCP and native MongoDB attachments', () => {
  it.each(['manual', 'closed', 'race', 'expired', 'lost'])(
    'retrieves or stops an existing job (%s)',
    async (scenario) => {
      const mongo = await MongoMemoryServer.create();
      const directory = await mkdtemp(join(tmpdir(), 'mcp-generation-'));
      await mongoose.connect(mongo.getUri());
      const models = createModels(mongoose);
      await models.ResourceLock.init();
      const messages = createMessageMethods(mongoose);
      const conversations = createConversationMethods(mongoose);
      const files = createFileMethods(mongoose);
      const conversationId = randomUUID();
      const messageId = randomUUID();
      await mongoose.models.Conversation.create({
        user: OWNER,
        conversationId,
        title: 'Synthetic image test',
        isTemporary: false,
        endpoint: 'agents',
      });
      const storageConfig = {
        fileConfig: {
          imageGeneration: {
            preserveOriginal: true,
          },
        },
      };
      const source = await sharp({
        create: {
          width: 12,
          height: 8,
          channels: 3,
          background: 'green',
        },
      })
        .tiff()
        .toBuffer();
      await writeFile(join(directory, 'source.tiff'), source);
      const savePreparedImage = jest.fn(async (image, options) => {
        const { req, file_id, filename, context, association } = options;
        await writeFile(join(directory, file_id), image.buffer);
        return files.createFile(
          {
            ...association,
            file_id,
            filename,
            context,
            user: req.user.id,
            source: 'local',
            filepath: '/images/' + file_id,
            type: image.type,
            bytes: image.bytes,
            width: image.width,
            height: image.height,
          },
          true,
        );
      });
      const imageStorage = {
        lease: createResourceLockMethods(mongoose),
        getMessage: messages.getMessage,
        findFileById: files.findFileById,
        attachMCPImage: messages.attachMCPImage,
        // Test storage adapter: actual temporary files and native File rows.
        // The production provider's storage strategy is tested separately.
        savePreparedImage,
        readStoredImage: async (_req, file) =>
          Readable.from([await readFile(join(directory, file.file_id))]),
        resizeImageBuffer: async () => {
          throw new Error('preserveOriginal must bypass resizing');
        },
      };
      const app = express();
      app.use(express.json());
      app.use(
        '/api/internal/mcp',
        createMCPMembershipRouter({
          getAppConfig: async () => ({
            config: {
              mcpAuthorization: {
                enabled: true,
                apiKeyEnv: 'TEST_READ_KEY',
                groupCatalogPageSize: 100,
              },
            },
          }),
          getMCPGroupMembership: async (id) => ({
            userId: id,
            tenantId: null,
            groupIds: [GROUP],
            groups: [
              {
                id: GROUP,
                name: 'Testgruppe',
                updatedAt: '2026-11-24T10:00:00.000Z',
              },
            ],
          }),
          getMCPGroupCatalog: async () => ({
            tenantId: null,
            groups: [],
            nextCursor: null,
          }),
          runWithContext: (context, action) => tenantStorage.run(context, action),
          env: {
            TEST_READ_KEY: READ_KEY,
          },
          logger: {
            error: jest.fn(),
          },
        }),
      );
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const nativePort = server.address().port;
      const reservation = createServer().listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(() => resolve()));
      const child = spawn(
        python,
        [
          join(root, 'mcp-media/tests/generation_service.py'),
          String(port),
          `http://127.0.0.1:${nativePort}`,
          directory,
          scenario,
        ],
        {
          env: {
            ...process.env,
            PYTHONPATH: [join(root, 'mcp-media/src'), process.env.PYTHONPATH]
              .filter(Boolean)
              .join(':'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let diagnostics = '';
      child.stderr.on('data', (chunk) => {
        diagnostics += chunk;
      });
      const client = new Client({
        name: 'native-image-integration',
        version: '1',
      });
      const pickupClient = new Client({ name: 'image-pickup-integration', version: '1' });
      const connect = (sdk) =>
        sdk.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
            requestInit: {
              headers: { Authorization: 'Bearer ' + GATEWAY, 'X-LibreChat-User-ID': OWNER },
            },
          }),
        );
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            if ((await fetch(`http://127.0.0.1:${port}/live`)).ok) break;
          } catch {
            /* starting */
          }
          if (child.exitCode != null || attempt >= 100)
            throw new Error('MCP test process failed: ' + diagnostics);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await connect(client);
        if (scenario !== 'manual') await connect(pickupClient);
        expect(
          (
            await fetch(`http://127.0.0.1:${nativePort}/api/internal/mcp/images`, {
              method: 'POST',
            })
          ).status,
        ).toBe(404);
        const callMCP = async (sdk, invocation) => {
          const result = await sdk.callTool(
            {
              name: invocation.toolName,
              arguments: invocation.toolArguments,
              _meta: invocation.requestMeta?.(),
            },
            undefined,
            invocation.options,
          );
          return (
            formatMCPImageJobResult(result) ??
            markMCPToolResultError(formatToolContent(result, 'openai'), result.isError === true)
          );
        };
        const automaticStatuses = [];
        let allowStorage;
        const concurrentResult = new Promise((resolve) => {
          allowStorage = resolve;
        });
        const pickupManager = {
          callTool: jest.fn(async (input) => {
            const result = await callMCP(pickupClient, input);
            const status = JSON.parse(result[0]).status;
            automaticStatuses.push(status);
            if (scenario === 'race' && status === 'image_ready') await concurrentResult;
            return result;
          }),
        };
        const imageJobs = {
          saveMessage: messages.saveMessage,
          bindJob: messages.bindMCPImageJob,
          findJob: messages.findMCPImageJob,
          getConvo: conversations.getConvo,
          getAppConfig: async () => storageConfig,
          saveImage: createMCPImageStorage(imageStorage),
        };
        let pickedUp;
        const enqueuePickup = createMCPImagePickup({
          deps: {
            ...imageJobs,
            runWithScope: ({ userId, tenantId }, action) =>
              tenantStorage.run({ userId, tenantId }, action),
            getUser: async () => ({ role: 'USER' }),
            canUseServers: async () => true,
            getServerConfigs: async () => ({ 'bfe-medien': { type: 'streamable-http' } }),
            getManager: () => pickupManager,
            getFlowManager: () => ({}),
            settlePickup: messages.settleMCPImagePickup,
            saveImage: async (input) => (pickedUp = await imageJobs.saveImage(input)),
          },
          intervalMs: 60,
        });
        const createHost = (background) =>
          createMCPImageInvoker({
            invokeTool: async (_manager, input) => {
              const result = await callMCP(client, input);
              if (scenario === 'race' && JSON.parse(result[0]).status === 'image_ready') {
                await waitFor(
                  () => automaticStatuses.includes('image_ready'),
                  'pickup did not reach native storage',
                );
                allowStorage();
              }
              return result;
            },
            deps: { ...imageJobs, saveImage: createMCPImageStorage(imageStorage) },
            enqueuePickup: background,
          });
        const call = createHost(scenario === 'manual' ? undefined : enqueuePickup);
        const manager = {
          callTool: jest.fn(),
        };
        const invocation = {
          serverName: 'bfe-medien',
          toolName: 'generate_image',
          provider: 'openai',
          user: {
            id: OWNER,
          },
          toolArguments: {
            prompt:
              scenario === 'manual' || scenario === 'race' ? 'delayed-result' : 'still-running',
          },
          flowManager: {},
        };
        const context = {
          conversationId,
          messageId,
          toolCallId: 'qwen-call-1',
        };
        const request = new AbortController();
        const [running] = await call(
          manager,
          { ...invocation, options: { signal: request.signal } },
          context,
        );
        const started = JSON.parse(running);
        if (scenario !== 'manual') {
          expect(await messages.getMessage({ user: OWNER, messageId })).toMatchObject({
            mcpImagePickups: [
              {
                toolCallId: context.toolCallId,
                expiresAt: started.pickup_expires_at,
                resolution: started.resolution,
              },
            ],
          });
        }
        const backendState = async () =>
          (await fetch(`http://127.0.0.1:${port}/test-state`)).json();
        const initialStatus =
          invocation.toolArguments.prompt === 'delayed-result' ? 'running' : 'queued';
        expect(started).toMatchObject({
          status: initialStatus,
          delivery_status: 'not_started',
          pickup_expires_at: expect.any(Number),
        });
        const laterContext = { conversationId, messageId: randomUUID(), toolCallId: 'qwen-call-2' };
        const statusInvocation = {
          ...invocation,
          toolName: 'get_media_job_status',
          toolArguments: { job_reference: started.job_reference },
        };
        const resultInvocation = { ...statusInvocation, toolName: 'get_media_result' };
        const readStatus = async () =>
          JSON.parse((await call(manager, statusInvocation, laterContext))[0]).status;
        if (scenario === 'manual') {
          expect(await readStatus()).toBe('running');
          const [pending, pendingArtifact] = await call(manager, resultInvocation, laterContext);
          expect(JSON.parse(pending)).toMatchObject({
            status: 'running',
            job_reference: started.job_reference,
          });
          expect(pendingArtifact).toBeUndefined();
        } else {
          request.abort();
          await waitFor(
            () => automaticStatuses.includes(initialStatus),
            'no independent pickup poll',
          );
          expect(pickupManager.callTool).toHaveBeenCalledWith(
            expect.objectContaining({
              toolName: 'get_media_result',
              toolArguments: { job_reference: started.job_reference },
              serverName: 'bfe-medien',
              requestBody: { messageId: expect.any(String) },
              unattended: true,
            }),
          );
          expect(pickupManager.callTool.mock.calls[0][0].options.signal).not.toBe(request.signal);
          expect(pickupManager.callTool.mock.calls[0][0].requestBody.messageId).not.toBe(messageId);
        }
        expect(savePreparedImage).not.toHaveBeenCalled();

        // Save the original response after generation and before the user asks for the image.
        const saveOriginal = () =>
          messages.saveMessage(
            { userId: OWNER },
            {
              conversationId,
              messageId,
              text: 'Final answer',
              files: scenario === 'closed' ? null : [],
              attachments: scenario === 'closed' ? null : [],
              isCreatedByUser: false,
            },
          );
        await saveOriginal();
        expect(await messages.getMessage({ user: OWNER, messageId })).not.toHaveProperty(
          'mcpImageJobs',
        );
        if (scenario === 'expired' || scenario === 'lost') {
          if (scenario === 'expired') {
            await delay(Math.max(0, started.pickup_expires_at - Date.now()) + 100);
            expect(pickupManager.callTool.mock.calls[0][0].options.signal.aborted).toBe(true);
          } else {
            await fetch(`http://127.0.0.1:${port}/test-drop-binding`, { method: 'POST' });
            await waitFor(
              () => automaticStatuses.at(-1) === 'job_unavailable',
              'pickup missed lost binding',
            );
          }
          const pollCount = pickupManager.callTool.mock.calls.length;
          await delay(250);
          expect(pickupManager.callTool).toHaveBeenCalledTimes(pollCount);
          const unavailable = await call(manager, resultInvocation, laterContext);
          expect(isMCPToolResultError(unavailable)).toBe(true);
          expect(JSON.parse(unavailable[0]).status).toBe('job_unavailable');
          expect(await mongoose.models.File.countDocuments()).toBe(0);
          await waitFor(async () => {
            const row = await messages.getMessage({ user: OWNER, messageId });
            return row?.mcpImagePickups?.length === 0;
          }, 'the settled pickup was still advertised');
          expect(await backendState()).toEqual({ jobs: 1, submissions: 1, translations: 1 });
          return;
        }
        const reopen = () =>
          messages.getMessages({ user: OWNER, conversationId, messageId }, CLIENT_MESSAGE_SELECT);
        if (scenario === 'closed') await client.close();
        await fetch(`http://127.0.0.1:${port}/test-complete`, { method: 'POST' });
        if (scenario === 'closed') {
          // The foreground session is closed. No user lookup is involved in obtaining the attachment.
          await waitFor(
            async () => (await reopen())[0]?.attachments?.length === 1,
            'background attachment did not persist',
          );
          const [reopened] = await reopen();
          expect(reopened.attachments[0]).toMatchObject({
            messageId,
            toolCallId: context.toolCallId,
          });
          expect(savePreparedImage).toHaveBeenCalledTimes(2);
          await connect(client);
        } else {
          await waitFor(
            async () => (await readStatus()) === 'succeeded',
            'test worker did not finish: ' + diagnostics,
          );
        }
        // Independent host/storage instances share MongoDB but no in-process deduplication state.
        const anotherHost = createHost();
        const [[text, artifact], [concurrent]] = await Promise.all([
          call(manager, resultInvocation, laterContext),
          anotherHost(manager, resultInvocation, { ...laterContext, toolCallId: 'qwen-call-3' }),
        ]);
        const receipt = JSON.parse(text);
        expect(receipt).toMatchObject({ status: 'stored', delivery_status: 'stored' });
        expect(JSON.parse(concurrent)).toEqual(receipt);
        if (scenario !== 'manual') {
          expect(automaticStatuses.filter((status) => status === 'image_ready')).toHaveLength(1);
          await waitFor(() => pickedUp, 'background pickup did not finish saving');
          expect(pickedUp.file_id).toBe(receipt.display_file_id);
        }
        expect(savePreparedImage).toHaveBeenCalledTimes(2);
        expect(receipt.file_id).not.toBe(receipt.display_file_id);
        expect(await readFile(join(directory, receipt.file_id))).toEqual(source);
        expect(
          (await sharp(await readFile(join(directory, receipt.display_file_id))).metadata()).format,
        ).toBe('png');
        expect((await files.findFileById(receipt.file_id))?.metadata?.imageDisplayFileId).toBe(
          receipt.display_file_id,
        );
        expect(
          (await files.findFileById(receipt.display_file_id))?.metadata?.imageOriginalFileId,
        ).toBe(receipt.file_id);
        const collected = [];
        const emit = jest.fn();
        collectMCPImageAttachments({
          artifact,
          artifactPromises: collected,
          metadata: {
            run_id: laterContext.messageId,
            thread_id: conversationId,
          },
          toolCallId: laterContext.toolCallId,
          writeAttachment: emit,
        });
        expect(collected).toHaveLength(0);
        expect(emit).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId,
            toolCallId: context.toolCallId,
            file_id: receipt.display_file_id,
          }),
        );
        // A stale final/disconnect snapshot cannot erase the display attachment.
        await saveOriginal();
        const [saved] = await reopen();
        if (scenario !== 'manual') expect(saved.mcpImagePickups).toEqual([]);
        expect(saved).not.toHaveProperty('mcpImageJobs');
        expect(saved?.files).toEqual([
          expect.objectContaining({
            file_id: receipt.display_file_id,
          }),
        ]);
        expect(saved?.attachments).toEqual([
          expect.objectContaining({
            file_id: receipt.display_file_id,
            messageId,
            toolCallId: context.toolCallId,
          }),
        ]);
        expect(
          await messages.getMessage({ user: OWNER, messageId: laterContext.messageId }),
        ).toBeNull();
        expect(JSON.parse((await anotherHost(manager, resultInvocation, laterContext))[0])).toEqual(
          receipt,
        );
        expect(savePreparedImage).toHaveBeenCalledTimes(2);
        expect(await mongoose.models.File.countDocuments()).toBe(2);
        const invalid = await call(
          manager,
          {
            ...invocation,
            toolArguments: {
              prompt: '',
              width: 200,
            },
          },
          {
            ...context,
            toolCallId: 'invalid',
          },
        );
        expect(JSON.parse(invalid[0]).job_created).toBe(false);
        expect(await backendState()).toEqual({ jobs: 1, submissions: 1, translations: 1 });
        const otherTarget = { ...context, messageId: randomUUID(), toolCallId: 'deleted-target' };
        const other = await anotherHost(
          manager,
          {
            ...invocation,
            toolArguments: {
              prompt: 'still-running',
            },
          },
          otherTarget,
        );
        expect(JSON.parse(other[0])).toMatchObject({
          status: 'queued',
          delivery_status: 'not_started',
        });
        const otherResult = {
          ...resultInvocation,
          toolArguments: { job_reference: JSON.parse(other[0]).job_reference },
        };
        await messages.deleteMessages({ user: OWNER, messageId: otherTarget.messageId });
        const [deleted] = await call(manager, otherResult, laterContext);
        expect(JSON.parse(deleted).status).toBe('job_unavailable');
        const [missing] = await call(
          manager,
          { ...resultInvocation, toolArguments: { job_reference: '0'.repeat(32) } },
          laterContext,
        );
        expect(missing).toBe(deleted);
        const [wrongOwner] = await call(
          manager,
          { ...resultInvocation, user: { id: 'b'.repeat(24) } },
          laterContext,
        );
        expect(wrongOwner).toBe(deleted);
        const [wrongTenant] = await call(
          manager,
          { ...resultInvocation, user: { id: OWNER, tenantId: 'other-tenant' } },
          laterContext,
        );
        expect(wrongTenant).toBe(deleted);
        const [wrongConversation] = await call(manager, resultInvocation, {
          ...laterContext,
          conversationId: randomUUID(),
        });
        expect(wrongConversation).toBe(deleted);
        expect(savePreparedImage).toHaveBeenCalledTimes(2);
        expect(await backendState()).toEqual({ jobs: 2, submissions: 2, translations: 2 });
      } finally {
        await pickupClient.close();
        await client.close();
        child.kill('SIGTERM');
        await once(child, 'exit').catch(() => undefined);
        await new Promise((resolve) => server.close(() => resolve()));
        await mongoose.disconnect();
        await mongo.stop();
        await rm(directory, {
          recursive: true,
          force: true,
        });
      }
    },
    45000,
  );
});
