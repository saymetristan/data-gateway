import { describe, expect, it, vi } from 'vitest';
import type { GatewayClient, ToolManifest } from './client.js';
import { createGatewayMcpServer } from './server.js';

const manifest: ToolManifest = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  generatedAt: new Date().toISOString(),
  tools: [
    {
      name: 'search_variant',
      kind: 'search',
      description: 'Buscar variantes',
      entity: 'variant',
      sourceIds: ['22222222-2222-4222-8222-222222222222'],
      mappingVersion: 1,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          color: { type: 'string', enum: ['rojo', 'azul'] },
        },
      },
    },
  ],
};

describe('createGatewayMcpServer', () => {
  it('registers tools from manifest', async () => {
    const client = {
      fetchManifest: vi.fn(async () => manifest),
      invokeTool: vi.fn(async () => ({ kind: 'search', results: [] })),
    } as unknown as GatewayClient;

    const server = await createGatewayMcpServer(client);
    expect(server.isConnected()).toBe(false);
    expect(client.fetchManifest).toHaveBeenCalledOnce();
  });
});
