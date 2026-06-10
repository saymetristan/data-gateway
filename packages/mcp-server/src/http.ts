import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { GatewayClient } from './client.js';
import { loadMcpEnv } from './env.js';
import { createGatewayMcpServer } from './server.js';

async function main(): Promise<void> {
  const env = loadMcpEnv();
  const client = new GatewayClient({
    gatewayUrl: env.GATEWAY_URL,
    apiKey: env.GATEWAY_API_KEY,
  });
  const server = await createGatewayMcpServer(client);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  // SDK Transport typings are incompatible with exactOptionalPropertyTypes (onclose getter).
  await server.connect(transport as unknown as Transport);

  const app = createMcpExpressApp({ host: '127.0.0.1' });
  app.post('/mcp', async (req: Request, res: Response) => {
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', async (req: Request, res: Response) => {
    await transport.handleRequest(req, res);
  });

  app.listen(env.MCP_PORT, () => {
    console.log(`Data Gateway MCP server listening on http://127.0.0.1:${String(env.MCP_PORT)}/mcp`);
  });
}

main().catch((error: unknown) => {
  console.error('MCP HTTP server failed:', error);
  process.exit(1);
});
