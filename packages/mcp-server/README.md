# @data-gateway/mcp-server

Servidor MCP de referencia para el Data Gateway. Consume el manifest REST (`GET /tools`) y ejecuta tools vía `POST /tools/:name/invoke`.

## Requisitos

- API key de workspace con scopes `tools:read` y `tools:invoke` (o `*`)
- Fuentes en estado `agent_ready`

## Variables de entorno

| Variable | Descripción |
| --- | --- |
| `GATEWAY_URL` | URL base de la API (ej. `http://localhost:3000`) |
| `GATEWAY_API_KEY` | API key del workspace (requerida en `stdio`; opcional en HTTP multi-tenant) |
| `MCP_PORT` / `PORT` | Puerto HTTP (default `3100`; Railway inyecta `PORT`) |

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

Endpoint MCP: `http://0.0.0.0:3100/mcp`.

Si `GATEWAY_API_KEY` no está configurada, el servidor corre en modo multi-tenant: cada request MCP debe traer `Authorization: Bearer <workspace_api_key>` o `X-API-Key: <workspace_api_key>`.

## Conectar a Whaapy

### Opción A: MCP hosteado por Data Gateway

Configura en Whaapy:

- URL: `https://mcp-production-91e6.up.railway.app/mcp`
- Transporte: Streamable HTTP
- Auth: `bearer`
- Token: API key del workspace (`dgw_...`) con scopes `tools:read` y `tools:invoke`

Whaapy hará `initialize`, `tools/list` y `tools/call`. Las respuestas usan un envelope JSON dentro de `content[0].text`:

```json
{
  "ok": true,
  "status": "success",
  "data": {},
  "toolName": "search_product",
  "safety": "read_only",
  "durationMs": 419
}
```

### Opción B: MCP propio del cliente

El cliente puede hostear este paquete y extenderlo con tools propias. Mantén `GATEWAY_API_KEY` como env si la instancia es de un solo workspace; omítela si quieres pasar la key por header.

Checklist de compatibilidad Whaapy:

- Endpoint `POST /mcp` y `DELETE /mcp`
- Header `Accept: application/json, text/event-stream`
- `MCP-Protocol-Version: 2025-06-18`
- `inputSchema.type = "object"` y `additionalProperties: false`
- `tools/call` responde `content: [{ "type": "text", "text": "<JSON parseable>" }]`
- Operaciones lentas deben responder antes de 30s o devolver `status: "queued"`

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
    description:
      'Tool adicional del cliente. When to use: cuando el agente necesite ejecutar la accion propia. Never use for: casos sin datos suficientes. Success criteria: ok=true con data verificable. Fallback: pedir mas datos o transferir a humano.',
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          status: 'success',
          data: { message },
          toolName: 'my_custom_tool',
          safety: 'read_only',
        }),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
```

## Nota sobre rutas

El plan original menciona `GET /workspaces/:id/tools`, pero el manifest vive en `GET /tools` autenticado con API key de workspace (el workspace se infiere de la key). Esto permite que el MCP server funcione sin `ADMIN_API_KEY`.
