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
