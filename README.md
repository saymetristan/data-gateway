# Data Gateway

Capa de infraestructura que convierte fuentes de negocio (database URL, Shopify, CSV) en tools consultables por agentes de IA con búsqueda híbrida determinística, evals como gate y manifest MCP.

> **Documentación Pública:** La documentación para integración de clientes, incluyendo tutoriales, referencia API y guías detalladas para el MCP se encuentra en el [Sitio de Docs (Mintlify)](docs-site/).

## Arquitectura

```mermaid
flowchart TB
  subgraph ingest [Ingesta]
    Connectors[Connectors DB/Shopify/CSV]
    Raw[source_records_raw]
    Profile[source_profiles]
    Mapping[mappings versionados]
    Records[records JSONB]
    Embeddings[record_embeddings HNSW]
  end
  subgraph queryPath [Query]
    Extract[extract-filters determinístico]
    Hybrid[lexical + vector + RRF]
    QueryAPI[POST /query]
  end
  subgraph agentLayer [Capa agente]
    Compiler[tool compiler]
    ToolsAPI[GET /tools + POST /tools/:name/invoke]
    McpServer[packages/mcp-server]
  end
  Connectors --> Raw --> Profile --> Mapping --> Records --> Embeddings
  Records --> Hybrid
  Embeddings --> Hybrid
  Extract --> Hybrid --> QueryAPI
  Mapping --> Compiler --> ToolsAPI --> McpServer
  ToolsAPI --> Hybrid
```

Madurez de fuente: `connected → profiled → mapped → indexed → validated → agent_ready` (evals + activación explícita).

## Producción

- API: `https://data.whaapy.com` (Railway fallback: `https://api-production-4d24.up.railway.app`)
- MCP Whaapy-compatible: `https://mcp.data.whaapy.com/mcp` (Railway fallback: `https://mcp-production-91e6.up.railway.app/mcp`)
- Railway proyecto `data-gateway`: servicios `api` (healthcheck `/health`), `worker` (sin dominio) y `mcp` (healthcheck `/health`, build con `@whaapy/data-gateway-mcp`)
- Monitoreo mínimo: UptimeRobot (o similar) sobre `https://data.whaapy.com/health` y `https://mcp.data.whaapy.com/health` cada 5 min
- Onboarding clientes: ver el [sitio de documentación](docs-site/) y el runbook interno [docs/CLIENT_ONBOARDING.md](docs/CLIENT_ONBOARDING.md)
- DB: Supabase `data-ingest` vía session pooler (`aws-1-us-east-1.pooler.supabase.com:5432`; pg-boss requiere session mode)
- Deploy manual: `railway up --service api|worker` desde la raíz; migraciones SIEMPRE vía MCP `data-gateway-supabase` (nunca `db:migrate` contra prod)

### Whaapy MCP

En Whaapy, agrega un MCP con:

- URL: `https://mcp.data.whaapy.com/mcp`
- Auth: bearer token = API key de workspace (`tools:read` + `tools:invoke`)
- Protocolo: Streamable HTTP (`MCP-Protocol-Version: 2025-06-18`)

El server traduce `tools/list` a `GET /tools` y `tools/call` a `POST /tools/:name/invoke`. Paquete npm: `@whaapy/data-gateway-mcp`. Los clientes que necesiten combinar tools propias pueden extender el paquete; ver la [guía de extensión MCP en los docs](docs-site/mcp/extend-custom-tools.mdx).

## Local development

```bash
docker compose up -d          # postgres :5432 + fixture-db :5433
pnpm install
cp .env.example .env          # OPENROUTER_API_KEY, ADMIN_API_KEY, CREDENTIALS_ENCRYPTION_KEY
pnpm db:migrate
pnpm dev                      # api :3000 + worker
pnpm test
```

Fixture ecommerce: `postgresql://readonly_user:readonly_pass@localhost:5433/catalog` (~300 productos).

Para tests locales sin OpenRouter: `USE_MOCK_PROVIDERS=true`. El profiling usa una muestra máxima de 10k raw rows por fuente para evitar consumo excesivo de memoria.

## Onboarding de una fuente database URL

Permisos mínimos en la DB del cliente: usuario **SELECT-only** (sin INSERT/UPDATE/DELETE).

```bash
# 1. workspace + api key (admin)
curl -X POST http://localhost:3000/workspaces \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo","slug":"demo"}'

curl -X POST http://localhost:3000/workspaces/{workspace_id}/api-keys \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{}'

# 2. crear fuente (valida read-only + cifra connectionUrl)
curl -X POST http://localhost:3000/sources \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"database_url",
    "name":"Catalog",
    "config":{
      "connectionUrl":"postgresql://readonly_user:readonly_pass@localhost:5433/catalog",
      "tables":["products"]
    }
  }'

# 3. sync manual (también se encola al crear la fuente)
curl -X POST http://localhost:3000/sources/{source_id}/sync \
  -H "Authorization: Bearer $WORKSPACE_API_KEY"

# 4. perfil (después del job source.profile)
curl http://localhost:3000/sources/{source_id}/profile \
  -H "Authorization: Bearer $WORKSPACE_API_KEY"

# 5. mapping (JSON, validado contra perfil)
curl -X POST http://localhost:3000/sources/{source_id}/mapping \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d @mapping.example.json

# 6. indexar (raw → records → embeddings)
curl -X POST http://localhost:3000/sources/{source_id}/index \
  -H "Authorization: Bearer $WORKSPACE_API_KEY"

# 7. estado
curl http://localhost:3000/sources/{source_id}/status \
  -H "Authorization: Bearer $WORKSPACE_API_KEY"
```

## CSV

```bash
curl -X POST http://localhost:3000/sources \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -d '{"type":"csv","name":"Upload","config":{}}'

curl -X POST http://localhost:3000/sources/{source_id}/upload \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -H "Content-Type: text/csv" \
  --data-binary @catalog.csv
```

## API phase 1

```bash
curl http://localhost:3000/health
```

## Query (`POST /query`)

Requiere fuente con `maturityStatus >= indexed`, mapping activo y scope `query:execute` (keys legacy sin scopes = permitido).

```bash
curl -X POST http://localhost:3000/query \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "camiseta rojo menos de 100",
    "limit": 10
  }'
```

**Request** (`queryRequestSchema`):

| Campo | Tipo | Notas |
|-------|------|-------|
| `query` | string | Obligatorio |
| `entity` | string? | Filtra entidad del mapping |
| `sourceId` | uuid? | Limita a una fuente |
| `filters` | record? | Filtros explícitos (no pueden anular `defaultFilters`) |
| `limit` | int | Default 10, max 50 |
| `useLlmFallback` | bool | Default false |

`workspace_id` sale de la API key, no va en el body.

**Response**:

```json
{
  "results": [{ "id": "...", "entity": "product", "score": 0.03, "data": { } }],
  "applied_filters": [{ "field": "price", "op": "lt", "value": 100 }],
  "query_type": "hybrid_search",
  "confidence": 0.72,
  "sources_used": ["..."],
  "warnings": []
}
```

`query_type`: `filter_only` | `lexical` | `hybrid_search`

### Confidence (determinístico, sin LLM)

```
confidence = 0.25·scoreGap + 0.15·filterCoverage + 0.20·lexicalOverlap
           + 0.25·distinctiveCoverage + 0.15·resultFill
```

- **scoreGap**: gap relativo entre score RRF #1 y #2 (no uses el score RRF absoluto como umbral)
- **filterCoverage**: filtros aplicados / filtros pedidos (1 si no hubo filtros)
- **lexicalOverlap**: 1 si el top result matcheó una rama lexical/tsquery
- **distinctiveCoverage**: fracción de términos distintivos de la query presentes en el top hit
- **resultFill**: `min(1, results.length / limit)`
- Fallback vector-only sin cobertura distintiva se acota (`≤ 0.42`) para no parecer un match fuerte

### Fallbacks

- Sin embeddings para la fuente → `lexical` + warning
- Embedding provider falla → `lexical` + warning (no 500)
- Sin LLM o `useLlmFallback: false` → solo extractor determinístico
- LLM devuelve campos inválidos → descartados con warning

## Madurez de fuentes

```
connected → profiled → mapped → indexed → validated → agent_ready
```

- `profiled`: tras profiling
- `mapped`: mapping activo creado
- `indexed`: records + embeddings generados
- `validated`: último eval run del set aplicable supera `threshold` y no tiene leaks sensibles
- `agent_ready`: `POST /sources/:id/activate` tras `validated`

Re-index o mapping nuevo sobre `validated`/`agent_ready` regresa a `indexed`. Transiciones auditadas en `source_transitions`.

## Evals (gate de activación)

Scopes: `evals:read`, `evals:write` (legacy keys sin scopes = permitido).

```bash
# Crear eval set (opcional sourceId para gate por fuente; uno global o uno por fuente)
curl -X POST http://localhost:3000/evals/sets \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -d '{"name":"Ecommerce","sourceId":"...","threshold":0.8}'

# Añadir case (al menos una assertion)
curl -X POST http://localhost:3000/evals/sets/{set_id}/cases \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -d '{"query":"SKU-00042","expectedExternalIds":["42"]}'

# Ejecutar eval set (worker job evals.run)
curl -X POST http://localhost:3000/evals/run \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -d '{"evalSetId":"..."}'

# Ver resultado
curl http://localhost:3000/evals/runs/{run_id} \
  -H "Authorization: Bearer $WORKSPACE_API_KEY"

# Activar fuente (requiere validated + último run >= threshold + sensitiveLeaks = 0)
curl -X POST http://localhost:3000/sources/{source_id}/activate \
  -H "Authorization: Bearer $WORKSPACE_API_KEY"
```

**Assertions por case** (al menos una):

| Campo | Descripción |
|-------|-------------|
| `expectedExternalIds` | IDs externos (`records.external_id`), no UUIDs de records |
| `mustApplyFilters` | Filtros que deben aparecer en `applied_filters` |
| `mustNotContainFields` | Campos que no deben salir en `data` (ej. `cost`) |

**Métricas del run**:

- `score = casesPassed / casesTotal` (gate principal)
- `precisionAtK`: promedio de precision@k por case con `expectedExternalIds`
- `filterAccuracy`: fracción de filtros requeridos aplicados
- `sensitiveLeaks`: conteo de campos prohibidos en responses (debe ser 0; bloquea `validated`/`agent_ready`)
- `latencyMsP50` / `latencyMsP95`

Si `GET /evals/runs/:id` devuelve un run `running` con `stale: true`, el worker probablemente murió o perdió el job después de tomarlo. Re-encola el run o crea uno nuevo; `runEvalSet` es idempotente y no reprocesa runs que ya no están en `running`.

Fixture: `fixtures/ecommerce-evals.json` (24 cases para el catálogo de prueba).

## Retrieval policies (sinónimos hot-update)

Scopes: `retrieval:read`, `retrieval:write`.

```bash
# Crear draft inmutable
curl -X POST http://localhost:3000/sources/{source_id}/retrieval-policies \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -d @fixtures/bayon-retrieval-policy.json

# Evaluar el draft v1 contra el eval set específico del source
curl -X POST http://localhost:3000/sources/{source_id}/retrieval-policies/1/eval \
  -H "Authorization: Bearer $WORKSPACE_API_KEY"

# Activar al aprobar; expectedActiveVersion=0 para la primera policy
curl -X POST http://localhost:3000/sources/{source_id}/retrieval-policies/1/activate \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -d '{"expectedActiveVersion":0}'
```

Activar o restaurar una policy cambia la configuración de query en O(1): no modifica records, embeddings ni `maturity_status`. Sin policy activa, el Gateway conserva los sinónimos del mapping legacy.

## Shopify (Fase 5)

Apps nuevas de Shopify usan client credentials grant; fuentes legacy con `accessToken` siguen soportadas. Scopes: `read_products`, `read_inventory`.

```bash
# Crear fuente Shopify
curl -X POST http://localhost:3000/sources \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -d '{
    "type": "shopify",
    "name": "Mi tienda",
    "config": {
      "shopDomain": "mi-tienda.myshopify.com",
      "clientId": "...",
      "clientSecret": "...",
      "webhookSecret": "whsec_..."
    }
  }'

# Sync manual (incremental)
curl -X POST http://localhost:3000/sources/{source_id}/sync \
  -H "Authorization: Bearer $WORKSPACE_API_KEY"
```

- Sync inicial automático al crear (full sync → profile)
- El Gateway intercambia `clientId/clientSecret` por token Admin API de corta vida en runtime; no persiste tokens derivados
- Webhooks en `POST /webhooks/shopify` (HMAC con `webhookSecret`; requiere `PUBLIC_API_URL` para registro automático)
- Variantes indexadas como entidad `variant` (`fixtures/shopify-mapping.json`)
- `available = status active AND inventoryQuantity > 0` vía rules `conditions[]`
- Re-index por webhook **no** demota `agent_ready` (`invalidateMaturity: false`)
- CI usa `MockShopifyClient` (~60 productos determinísticos)

Env API adicional: `PUBLIC_API_URL` (URL pública para callback de webhooks).

Fixtures: `fixtures/shopify-mapping.json`, `fixtures/shopify-evals.json` (18 cases).
Checkpoint: `docs/ABSTRACTION_CHECKPOINT.md`.

## MCP / Tools (Fase 6)

Solo fuentes `agent_ready` aparecen en el manifest. El workspace sale de la API key (no va en la URL).

```bash
# Manifest de tools (JSON Schema por tool)
curl http://localhost:3000/tools \
  -H "Authorization: Bearer $WORKSPACE_API_KEY"

# Invocar tool compilada
curl -X POST http://localhost:3000/tools/search_variant/invoke \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"args":{"query":"playeras rojas","color":"rojo","limit":5}}'
```

Scopes: `tools:read`, `tools:invoke` (keys con `*` incluyen todo).

MCP server de referencia (`packages/mcp-server`): stdio o Streamable HTTP consumiendo solo la API REST. Ver `packages/mcp-server/README.md`.

Dogfooding local sin credenciales: `DOGFOOD_DRY_RUN=true pnpm dogfood`.

## Operación (Fase 7)

### Rate limiting

Por API key, in-memory (fixed window). Configurable:

| Variable | Default | Notas |
|----------|---------|-------|
| `RATE_LIMIT_MAX` | 120 | Requests por ventana; `0` desactiva |
| `RATE_LIMIT_WINDOW_MS` | 60000 | Ventana en ms |

Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After` en 429.

### Query logs

```bash
curl "http://localhost:3000/query-logs?maxConfidence=0.5&limit=20" \
  -H "Authorization: Bearer $WORKSPACE_API_KEY"
```

Scope: `logs:read`. Filtros: `from`, `to`, `queryType`, `maxConfidence`, `sourceId`, `onlyErrors`, `cursor`.

### Métricas (admin)

```bash
curl http://localhost:3000/metrics \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

Incluye p50/p95 de latencia de query (24h), tamaño de colas pg-boss y estado de webhooks/fuentes.

### RLS (defensa en profundidad)

Postgres RLS por `workspace_id` con `FORCE` en tablas tenant. La API hace `SET LOCAL ROLE gateway_app` + `app.workspace_id` en transacción por request workspace (`gateway_app` no tiene `BYPASSRLS`; `postgres` local sí). Worker/admin corren sin contexto (acceso total). Upgrade path documentado en `docs/ABSTRACTION_CHECKPOINT.md`.

### Reindexación por cambio de modelo

`POST /sources/:id/index` detecta records sin embedding del `(EMBEDDING_MODEL, mappingVersion)` activo y los re-encola aunque el record no haya cambiado. Purga embeddings de modelos/versiones viejas solo cuando ya existe el activo.
