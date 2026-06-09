# Data Gateway

## Local development

```bash
docker compose up -d
pnpm install
cp .env.example .env   # fill OPENROUTER_API_KEY, ADMIN_API_KEY, CREDENTIALS_ENCRYPTION_KEY
pnpm db:migrate
pnpm dev               # api :3000 + worker
pnpm test
```

## API (phase 1)

```bash
# health
curl http://localhost:3000/health

# create workspace (admin key)
curl -X POST http://localhost:3000/workspaces \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo","slug":"demo"}'

# create workspace API key (admin key)
curl -X POST http://localhost:3000/workspaces/{workspace_id}/api-keys \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'

# create source (workspace API key)
curl -X POST http://localhost:3000/sources \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"database_url","name":"External","config":{"connectionUrl":"postgresql://readonly:pass@host/db"}}'
```
