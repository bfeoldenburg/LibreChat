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
  collectMCPImageAttachments,
  formatMCPImageJobResult,
} from '../../../api/src/mcp/generation';
import { createMCPMembershipRouter } from '../../../api/src/mcp/membership';
import { createMCPImageStorage } from '../../../api/src/mcp/images';
import { formatToolContent } from '../../../api/src/mcp/parsers';
import { tenantStorage } from '~/config/tenantContext';
import { createMessageMethods } from './message';
import { createFileMethods } from './file';
import { createModels } from '../models';
const root = process.env.MEDIA_MCP_TEST_ROOT;
const python = process.env.MEDIA_MCP_TEST_PYTHON;
const integration = root && python ? describe : describe.skip;
const OWNER = 'a'.repeat(24);
const GROUP = 'c'.repeat(24);
const READ_KEY = 'test-callback-' + 'l'.repeat(32);
const GATEWAY = 'test-gateway-' + 'g'.repeat(32);
integration('foreground image generation with real MCP and native MongoDB attachments', () => {
  it('stores linked originals/displays, preserves the final attachment, deduplicates and leaves running jobs alone', async () => {
    const mongo = await MongoMemoryServer.create();
    const directory = await mkdtemp(join(tmpdir(), 'mcp-generation-'));
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    const messages = createMessageMethods(mongoose);
    const files = createFileMethods(mongoose);
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const conversation = await mongoose.models.Conversation.create({
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
    const imageStorage = {
      getMessage: messages.getMessage,
      findFileById: files.findFileById,
      attachMCPImage: messages.attachMCPImage,
      // Test storage adapter: actual temporary files and native File rows.
      // The production provider's storage strategy is tested separately.
      savePreparedImage: async (image, options) => {
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
      },
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
      ],
      {
        env: {
          ...process.env,
          PYTHONPATH: join(root, 'mcp-media/src'),
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
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: {
            headers: {
              Authorization: 'Bearer ' + GATEWAY,
              'X-LibreChat-User-ID': OWNER,
            },
          },
        }),
      );
      expect(
        (await fetch(`http://127.0.0.1:${nativePort}/api/internal/mcp/images`, { method: 'POST' }))
          .status,
      ).toBe(404);
      const invokeTool = async (_manager, invocation) => {
        const result = await client.callTool({
          name: 'generate_image',
          arguments: invocation.toolArguments,
          _meta: invocation.requestMeta?.(),
        });
        return formatMCPImageJobResult(result) ?? formatToolContent(result, 'openai');
      };
      const call = createMCPImageInvoker({
        invokeTool,
        deps: {
          saveMessage: messages.saveMessage,
          getConvo: async () => conversation,
          getAppConfig: async () => storageConfig,
          saveImage: createMCPImageStorage(imageStorage),
        },
      });
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
          prompt: 'A green fox, as authored by Qwen.',
        },
        flowManager: {},
      };
      const context = {
        conversationId,
        messageId,
        toolCallId: 'qwen-call-1',
      };
      const [text, artifact] = await call(manager, invocation, context);
      const receipt = JSON.parse(text);
      expect(receipt.delivery_status).toBe('stored');
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
          run_id: messageId,
          thread_id: conversationId,
        },
        toolCallId: 'qwen-call-1',
        writeAttachment: emit,
      });
      expect(await Promise.all(collected)).toHaveLength(1);
      expect(emit).toHaveBeenCalledTimes(1);
      // A terminal/disconnect snapshot made before import cannot erase the attachment.
      await messages.saveMessage(
        {
          userId: OWNER,
        },
        {
          conversationId,
          messageId,
          text: 'Final answer',
          files: [],
          isCreatedByUser: false,
        },
      );
      const saved = await messages.getMessage({
        user: OWNER,
        messageId,
      });
      expect(saved?.files).toEqual([
        expect.objectContaining({
          file_id: receipt.display_file_id,
        }),
      ]);
      expect(JSON.parse((await call(manager, invocation, context))[0])).toEqual(receipt);
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
      expect(await (await fetch(`http://127.0.0.1:${port}/test-state`)).json()).toEqual({
        jobs: 1,
      });
      const running = await call(
        manager,
        {
          ...invocation,
          toolArguments: {
            prompt: 'still-running',
          },
        },
        {
          ...context,
          toolCallId: 'running',
        },
      );
      expect(JSON.parse(running[0])).toMatchObject({
        status: 'queued',
        delivery_status: 'not_started',
      });
      expect(await (await fetch(`http://127.0.0.1:${port}/test-state`)).json()).toEqual({
        jobs: 2,
      });
    } finally {
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
  }, 45000);
});
