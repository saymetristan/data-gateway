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
