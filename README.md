# Data Gateway

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
confidence = 0.35·scoreGap + 0.25·filterCoverage + 0.25·lexicalOverlap + 0.15·resultFill
```

- **scoreGap**: gap relativo entre score RRF #1 y #2
- **filterCoverage**: filtros aplicados / filtros pedidos (1 si no hubo filtros)
- **lexicalOverlap**: 1 si el top result matcheó el tsquery
- **resultFill**: `min(1, results.length / limit)`

### Fallbacks

- Sin embeddings para la fuente → `lexical` + warning
- Embedding provider falla → `lexical` + warning (no 500)
- Sin LLM o `useLlmFallback: false` → solo extractor determinístico
- LLM devuelve campos inválidos → descartados con warning
