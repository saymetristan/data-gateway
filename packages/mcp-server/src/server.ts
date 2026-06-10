import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GatewayClient } from './client.js';
import { jsonSchemaToZodShape } from './schema-to-zod.js';

export async function createGatewayMcpServer(client: GatewayClient): Promise<McpServer> {
  const server = new McpServer(
    { name: 'data-gateway', version: '0.0.1' },
    {
      instructions:
        'Tools compiladas desde mappings validados del Data Gateway. Usa search_* para búsquedas y check_availability_* para verificar stock/disponibilidad por identificador.',
    },
  );

  const manifest = await client.fetchManifest();
  for (const tool of manifest.tools) {
    const inputSchema = jsonSchemaToZodShape(tool.inputSchema);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
      },
      async (args) => {
        try {
          const result = await client.invokeTool(tool.name, args as Record<string, unknown>);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Tool invocation failed';
          return {
            content: [{ type: 'text', text: message }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
