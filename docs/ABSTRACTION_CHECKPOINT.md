# Abstraction Checkpoint — Fase 5 (Shopify)

## Cambios requeridos en el core

### 1. `indexSource({ invalidateMaturity })`

**Problema**: re-index siempre demovía `validated`/`agent_ready` → `indexed`. Con webhooks/sync frecuentes, una fuente nunca permanecería `agent_ready`.

**Solución**: `invalidateMaturity` default `true` (comportamiento manual `POST /sources/:id/index`); `false` en jobs disparados por sync/webhook.

**Archivos**: `packages/core/src/services/indexing.ts`, `packages/core/src/queue/jobs.ts`, worker indexing handler.

### 2. Rules con `conditions[]` (AND)

**Problema**: regla `available = status active + stock > 0` no cabía en el schema de una sola condición.

**Solución**: `mappingRuleSchema` acepta `conditions[]` backward-compatible con `{field, op, column, value}`.

**Archivos**: `packages/core/src/schemas/mapping.ts`, `packages/core/src/mapping/apply.ts`, `packages/core/src/mapping/validate.ts`.

### 3. Dispatcher de sync por `source.type`

**Problema**: `syncDatabaseSource` era el único path; Shopify necesitaba tercer conector.

**Solución**: `syncSource()` en core despacha por tipo; worker sin lógica de dominio.

**Archivos**: `packages/core/src/services/source-sync.ts`, `packages/core/src/services/shopify-sync.ts`.

## Sin cambios (abstracción validada)

- Contrato `source_records_raw`: `{tabla}:{externalId}`, `payload.__table`, `payloadHash` idempotente
- Profiling sobre JSONB raw (agrupa por `__table`)
- Mapping document (`sourceTable` → entity) sin extensión de schema
- Query engine híbrido, shaping, evals gate
- Máquina de madurez + `source_transitions`
- Worker pattern: pool-per-job + providers inyectables

## Decisiones Shopify-específicas (no generalizadas)

- `sourceRecordId` usa IDs numéricos (`products:123`), no GIDs (`gid://shopify/...`)
- Variantes denormalizadas con datos del producto padre (sin joins en query-time)
- Webhooks con HMAC + job async (`SHOPIFY_WEBHOOK_JOB`)
- Mock client determinístico para CI (`MockShopifyClient`)

## Upgrade path documentado

- Catálogos >10k productos: Bulk Operations API
- OAuth público: fuera de MVP (custom app token only)
- Dedupe webhook: LRU in-memory → tabla `webhook_events` si multi-instancia API

---

# Abstraction Checkpoint — Fase 6 (Tool Compiler + MCP)

## Nuevas piezas

### Tool compiler (`packages/core/src/tools/compiler.ts`)

- Compila `MappingEntity` + `SourceProfileDocument` → `ToolDefinition[]` (`search_<entity>`, `check_availability_<entity>`)
- Enums de parámetros desde `topValues` reales del profiling
- Sin tabla persistida: manifest on-the-fly versionado por `mappingVersion`

### Capa tools (`packages/core/src/services/tools.ts`)

- `getToolManifest(workspaceId)` — solo fuentes `agent_ready`
- `invokeTool` — valida args, traduce a `executeQuery` con `requiredMaturity: 'agent_ready'` y `allowedSourceIds`
- Logging en `query_logs.structuredQuery.toolName`

### API

- `GET /tools` — scope `tools:read` (workspace desde API key)
- `POST /tools/:name/invoke` — scope `tools:invoke`
- Desviación documentada: no `GET /workspaces/:id/tools` (ruta admin-only incompatible con MCP)

### MCP server (`packages/mcp-server`)

- Consume solo REST; nunca importa `@data-gateway/core`
- Transportes: stdio + Streamable HTTP (`/mcp`)

## Sin cambios (reutilizado)

- `executeQuery` como motor de ejecución (default filters, shaping, confidence)
- Query path existente `/query` sigue aceptando `indexed|validated|agent_ready`
- Mapping document + profiling + eval gate antes de `agent_ready`

## Extensibilidad

- `ToolKind` registry en compiler para nuevos tipos de tool
- `description` opcional en `mappingFieldSchema` y `mappingEntitySchema` para schemas MCP más ricos

---

# Abstraction Checkpoint — Fase 7 (Hardening y Operación)

## RLS por workspace

- Migración `0005_workspace_rls.sql`: `ENABLE` + `FORCE ROW LEVEL SECURITY` en 15 tablas tenant
- Policy permissive: si `app.workspace_id` no está seteado → acceso total (worker, admin, migraciones)
- Rol `gateway_app` (`NOBYPASSRLS`): la API hace `SET LOCAL ROLE gateway_app` + `set_config('app.workspace_id', ..., true)` en transacción
- `postgres` local tiene `BYPASSRLS` — sin `SET ROLE` las policies no aplican aunque existan
- Upgrade path: usuario de conexión dedicado miembro de `gateway_app` sin `BYPASSRLS` en prod

## Re-embed por cambio de modelo

- `indexSource({ embeddingModel })` detecta records sin embedding del par `(modelo activo, mappingVersion activa)`
- `purgeOldEmbeddingsForSource` también purga modelos viejos cuando ya existe el activo (sin ventana vacía)
- Worker pasa `embeddingProvider.model` al index job

## Operación

- Rate limit in-memory por API key (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`; `0` desactiva)
- `GET /query-logs` — scope `logs:read`, filtros + cursor
- `GET /metrics` — admin-only, p50/p95 query, colas pg-boss, estado sync
