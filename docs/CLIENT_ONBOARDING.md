# Onboarding de cliente real (Runbook Interno)

> **Importante:** Esta es la guía operativa interna para el equipo de Whaapy. Si eres un cliente buscando conectar tus datos, dirígete a las [Documentaciones Públicas (Docs Site)](../docs-site/onboarding/overview.mdx).

Flujo operativo para llevar un cliente de cero a `agent_ready` + MCP en Whaapy.

## Prerrequisitos

- `ADMIN_API_KEY` de producción (password manager; no commitear)
- Credencial **read-only** del cliente (`SELECT` únicamente) o CSV/Shopify
- OpenRouter activo en Railway (`OPENROUTER_API_KEY`)

## Resumen del flujo

```mermaid
sequenceDiagram
  participant Ops as Ops_Whaapy
  participant API as data.whaapy.com
  participant Worker as worker
  participant Whaapy as Whaapy_MCP

  Ops->>API: POST /workspaces + api-keys
  Ops->>API: POST /sources (database_url|csv|shopify)
  Worker->>API: sync + profile jobs
  Ops->>API: POST /sources/:id/mapping
  Ops->>API: POST /sources/:id/index
  Ops->>API: POST /evals/sets + cases + run
  Ops->>API: POST /sources/:id/activate
  Whaapy->>API: MCP tools/list + tools/call via mcp.data.whaapy.com
```



## 1. Workspace y API key

Una key de workspace sirve para **API y MCP** (mismo `dgw_live_...` como bearer).

```bash
export GATEWAY_URL=https://data.whaapy.com
export ADMIN_API_KEY=dgw_admin_...

curl -X POST "$GATEWAY_URL/workspaces" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Cliente X","slug":"cliente-x"}'

curl -X POST "$GATEWAY_URL/workspaces/{workspace_id}/api-keys" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"scopes":["*"]}'
```

Guarda la key en el password manager del cliente. **No** la reenvíes por chat.

## 2. Fuente database_url (caso más común)

Pedir al cliente un usuario PostgreSQL con:

```sql
CREATE USER data_gateway_ro WITH PASSWORD '...';
GRANT CONNECT ON DATABASE catalog TO data_gateway_ro;
GRANT USAGE ON SCHEMA public TO data_gateway_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO data_gateway_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO data_gateway_ro;
```

```bash
export WORKSPACE_KEY=dgw_live_tu_api_key_aqui

curl -X POST "$GATEWAY_URL/sources" \
  -H "Authorization: Bearer $WORKSPACE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"database_url",
    "name":"Catálogo",
    "config":{
      "connectionUrl":"postgresql://data_gateway_ro:...@host:5432/catalog",
      "tables":["products"]
    }
  }'
```

La API valida read-only (422 si tiene write). Sync y profiling se encolan solos.

## 2b. Fuente Shopify

Para apps nuevas creadas desde enero 2026, Shopify ya no entrega un `shpat_...` permanente en UI. Usa `client_credentials`: guardamos `clientId/clientSecret` y el Gateway pide tokens Admin API de corta vida en runtime. Scopes mínimos en Shopify: `read_products`, `read_inventory`.

```bash
export WORKSPACE_KEY=dgw_...
export SHOPIFY_CLIENT_ID=...
export SHOPIFY_CLIENT_SECRET=...
export SHOPIFY_WEBHOOK_SECRET=...

curl -X POST "$GATEWAY_URL/sources" \
  -H "Authorization: Bearer $WORKSPACE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"shopify",
    "name":"Shopify",
    "config":{
      "shopDomain":"bayon.myshopify.com",
      "clientId":"'"$SHOPIFY_CLIENT_ID"'",
      "clientSecret":"'"$SHOPIFY_CLIENT_SECRET"'",
      "webhookSecret":"'"$SHOPIFY_WEBHOOK_SECRET"'"
    }
  }'
```

La API normaliza el dominio, intercambia client credentials por token Admin API, valida conexión, cifra credenciales, encola sync inicial y registra webhooks si `PUBLIC_API_URL` está configurado. Fuentes legacy con `accessToken` siguen soportadas.

## 3. Mapping (paso crítico)

Revisa el perfil antes de mapear:

```bash
curl "$GATEWAY_URL/sources/{source_id}/profile" -H "Authorization: Bearer $WORKSPACE_KEY"
```

Define por campo:


| Flag         | Efecto en tools                                                 |
| ------------ | --------------------------------------------------------------- |
| `searchable` | Entra al índice semántico                                       |
| `filterable` | Se expone como parámetro en `search_*` / `check_availability_*` |
| `sensitive`  | Nunca sale en respuestas                                        |


Ajusta el mapping a la ontología del negocio (no uses el auto-mapping del script para prod).

## 4. Index, evals, activate

```bash
curl -X POST "$GATEWAY_URL/sources/{source_id}/index" -H "Authorization: Bearer $WORKSPACE_KEY"

curl -X POST "$GATEWAY_URL/evals/sets" \
  -H "Authorization: Bearer $WORKSPACE_KEY" \
  -d '{"name":"Cliente X QA","sourceId":"{source_id}","threshold":0.8}'

# Casos con preguntas reales del negocio y expectedExternalIds correctos
curl -X POST "$GATEWAY_URL/evals/sets/{set_id}/cases" \
  -H "Authorization: Bearer $WORKSPACE_KEY" \
  -d '{"query":"¿tienen camiseta roja talla M?","expectedExternalIds":["SKU-001:..."]}'

curl -X POST "$GATEWAY_URL/evals/run" \
  -H "Authorization: Bearer $WORKSPACE_KEY" \
  -d '{"evalSetId":"{set_id}"}'

curl -X POST "$GATEWAY_URL/sources/{source_id}/activate" \
  -H "Authorization: Bearer $WORKSPACE_KEY"
```

Sin evals que pasen el threshold, `activate` no debería usarse en prod.

## 5. Whaapy MCP

En el dashboard del cliente → MCPs:


| Campo      | Valor                              |
| ---------- | ---------------------------------- |
| URL        | `https://mcp.data.whaapy.com/mcp`  |
| Transporte | Streamable HTTP                    |
| Auth       | Bearer = `WORKSPACE_KEY`           |
| Protocol   | `MCP-Protocol-Version: 2025-06-18` |


Las tools (`search_product`, etc.) aparecen tras `tools/list`. Configúralas en Subagents/Tools con las descripciones semánticas (`When to use`, `Fallback`).

## Script automatizado

Para CSV de validación o bootstrap rápido:

```bash
chmod +x scripts/onboard-client.sh

ADMIN_API_KEY=... GATEWAY_URL=https://data.whaapy.com \
  ./scripts/onboard-client.sh \
  --name "Cliente X" --slug cliente-x \
  --type database_url \
  --connection-url "postgresql://readonly:...@host/db" \
  --tables products,variants
```

Shopify:

```bash
ADMIN_API_KEY=... GATEWAY_URL=https://data.whaapy.com \
SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... SHOPIFY_WEBHOOK_SECRET=... \
  ./scripts/onboard-client.sh \
  --name "Bayon" --slug bayon \
  --type shopify \
  --shop-domain bayon.myshopify.com \
  --evals ./bayon-evals.json \
  --activate \
  --print-secrets
```

Para producción, `--evals` debe contener casos reales del cliente con `expectedExternalIds`, `mustApplyFilters` o `mustNotContainFields`. No uses `fixtures/shopify-evals.json` para un catálogo real; esos IDs son del mock.

## Monitoreo post-onboarding


| Check      | URL                                  | Esperado               |
| ---------- | ------------------------------------ | ---------------------- |
| API health | `https://data.whaapy.com/health`     | `200`, `db: connected` |
| MCP health | `https://mcp.data.whaapy.com/health` | `200`, `ok: true`      |
| Métricas   | `GET /metrics` (admin)               | p50/p95, colas pg-boss |
| Query logs | `GET /query-logs` (workspace key)    | latencia y errores     |


Configura UptimeRobot (o similar) con intervalo 5 min sobre los dos `/health`.

## npm self-host (opcional)

```bash
npx @whaapy/data-gateway-mcp
# o
npm i -g @whaapy/data-gateway-mcp
GATEWAY_URL=https://data.whaapy.com node node_modules/@whaapy/data-gateway-mcp/dist/http.js
```

Para stdio local: `GATEWAY_API_KEY=dgw_live_... data-gateway-mcp`.