# @data-gateway/mcp-server

Servidor MCP de referencia para el Data Gateway. Consume el manifest REST (`GET /tools`) y ejecuta tools vía `POST /tools/:name/invoke`.

## Requisitos

- API key de workspace con scopes `tools:read` y `tools:invoke` (o `*`)
- Fuentes en estado `agent_ready`

## Variables de entorno

| Variable | Descripción |
| --- | --- |
| `GATEWAY_URL` | URL base de la API (ej. `http://localhost:3000`) |
| `GATEWAY_API_KEY` | API key del workspace |
| `MCP_PORT` | Puerto HTTP (default `3100`, solo transporte HTTP) |

## stdio (Claude Desktop / Cursor)

```bash
pnpm --filter @data-gateway/mcp-server build
GATEWAY_URL=http://localhost:3000 GATEWAY_API_KEY=dgw_... pnpm --filter @data-gateway/mcp-server start:stdio
```

Ejemplo de configuración MCP:

```json
{
  "mcpServers": {
    "data-gateway": {
      "command": "node",
      "args": ["/ruta/al/repo/packages/mcp-server/dist/stdio.js"],
      "env": {
        "GATEWAY_URL": "http://localhost:3000",
        "GATEWAY_API_KEY": "dgw_..."
      }
    }
  }
}
```

## Streamable HTTP

```bash
GATEWAY_URL=http://localhost:3000 GATEWAY_API_KEY=dgw_... pnpm --filter @data-gateway/mcp-server start:http
```

Endpoint MCP: `http://127.0.0.1:3100/mcp`

## Extender con tools propias

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GatewayClient } from '@data-gateway/mcp-server/dist/client.js';
import { createGatewayMcpServer } from '@data-gateway/mcp-server/dist/server.js';

const client = new GatewayClient({
  gatewayUrl: process.env.GATEWAY_URL!,
  apiKey: process.env.GATEWAY_API_KEY!,
});

const server = await createGatewayMcpServer(client);

server.registerTool(
  'my_custom_tool',
  {
    description: 'Tool adicional del cliente',
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: `Echo: ${message}` }],
  }),
);

await server.connect(new StdioServerTransport());
```

## Nota sobre rutas

El plan original menciona `GET /workspaces/:id/tools`, pero el manifest vive en `GET /tools` autenticado con API key de workspace (el workspace se infiere de la key). Esto permite que el MCP server funcione sin `ADMIN_API_KEY`.
