#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GatewayClient } from './client.js';
import { loadMcpEnv } from './env.js';
import { createGatewayMcpServer } from './server.js';

async function main(): Promise<void> {
  const env = loadMcpEnv();
  if (!env.GATEWAY_API_KEY) {
    throw new Error('GATEWAY_API_KEY is required for stdio mode');
  }
  const client = new GatewayClient({
    gatewayUrl: env.GATEWAY_URL,
    apiKey: env.GATEWAY_API_KEY,
  });
  const server = await createGatewayMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error('MCP stdio server failed:', error);
  process.exit(1);
});
