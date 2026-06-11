import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { GatewayClient } from './client.js';
import { loadMcpEnv } from './env.js';
import type { McpServerEnv } from './env.js';
import { createGatewayMcpServer } from './server.js';

type Session = {
  transport: StreamableHTTPServerTransport;
  apiKey: string;
};

function extractApiKey(req: Request, fallbackApiKey: string | undefined): string | null {
  if (fallbackApiKey) return fallbackApiKey;

  const authorization = req.header('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim();
  }

  const apiKey = req.header('x-api-key');
  return apiKey?.trim() || null;
}

function writeUnauthorized(res: Response): void {
  res.status(401).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: 'Missing MCP API key. Send Authorization: Bearer <workspace_api_key>.',
    },
    id: null,
  });
}

function main(): void {
  const env = loadMcpEnv();
  const app = createGatewayMcpHttpApp(env);

  app.listen(env.MCP_PORT, () => {
    console.log(`Data Gateway MCP server listening on http://0.0.0.0:${String(env.MCP_PORT)}/mcp`);
  });
}

export function createGatewayMcpHttpApp(env: McpServerEnv) {
  const sessions = new Map<string, Session>();

  async function createSession(apiKey: string): Promise<Session> {
    const client = new GatewayClient({
      gatewayUrl: env.GATEWAY_URL,
      apiKey,
    });
    const server = await createGatewayMcpServer(client);
    let sessionId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessionId = id;
        sessions.set(id, { transport, apiKey });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (sessionId) sessions.delete(sessionId);
    };
    // SDK Transport typings are incompatible with exactOptionalPropertyTypes (onclose getter).
    await server.connect(transport as unknown as Transport);
    return { transport, apiKey };
  }

  async function resolveSession(req: Request, res: Response): Promise<Session | null> {
    const apiKey = extractApiKey(req, env.GATEWAY_API_KEY);
    if (!apiKey) {
      writeUnauthorized(res);
      return null;
    }

    const sessionId = req.header('mcp-session-id');
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) return session;
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32004, message: 'MCP session not found' },
        id: null,
      });
      return null;
    }

    return createSession(apiKey);
  }

  const app = createMcpExpressApp({ host: '0.0.0.0' });
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, service: 'data-gateway-mcp' });
  });
  app.post('/mcp', async (req: Request, res: Response) => {
    const session = await resolveSession(req, res);
    if (!session) return;
    await session.transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', async (req: Request, res: Response) => {
    const session = await resolveSession(req, res);
    if (!session) return;
    await session.transport.handleRequest(req, res);
  });
  app.delete('/mcp', async (req: Request, res: Response) => {
    const session = await resolveSession(req, res);
    if (!session) return;
    await session.transport.handleRequest(req, res);
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error: unknown) {
    console.error('MCP HTTP server failed:', error);
    process.exit(1);
  }
}
