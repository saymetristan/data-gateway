#!/usr/bin/env bash
# Onboarding de un cliente en Data Gateway (prod o local).
# Uso:
#   ADMIN_API_KEY=dgw_admin_... GATEWAY_URL=https://data.whaapy.com ./scripts/onboard-client.sh \
#     --name "Cliente X" --slug cliente-x --type database_url \
#     --connection-url "postgresql://readonly:...@host/db" --tables products
#
# CSV rápido (validación):
#   ADMIN_API_KEY=... GATEWAY_URL=https://data.whaapy.com ./scripts/onboard-client.sh \
#     --name "Demo" --slug demo --type csv --csv /path/catalog.csv

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-https://data.whaapy.com}"
ADMIN_API_KEY="${ADMIN_API_KEY:?ADMIN_API_KEY requerida}"

NAME=""
SLUG=""
TYPE=""
CONNECTION_URL=""
TABLES=""
CSV_PATH=""
THRESHOLD="0.8"

usage() {
  sed -n '2,8p' "$0"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --slug) SLUG="$2"; shift 2 ;;
    --type) TYPE="$2"; shift 2 ;;
    --connection-url) CONNECTION_URL="$2"; shift 2 ;;
    --tables) TABLES="$2"; shift 2 ;;
    --csv) CSV_PATH="$2"; shift 2 ;;
    --threshold) THRESHOLD="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Argumento desconocido: $1"; usage ;;
  esac
done

[[ -n "$NAME" && -n "$SLUG" && -n "$TYPE" ]] || usage

auth() { echo "Authorization: Bearer $ADMIN_API_KEY"; }
wauth() { echo "Authorization: Bearer $WORKSPACE_KEY"; }

echo "==> 1. Workspace"
WS=$(curl -fsS -X POST "$GATEWAY_URL/workspaces" \
  -H "$(auth)" -H "Content-Type: application/json" \
  -d "{\"name\":\"$NAME\",\"slug\":\"$SLUG\"}")
WSID=$(echo "$WS" | jq -r '.id // .workspace.id')
echo "workspace_id=$WSID"

echo "==> 2. API key"
KEY=$(curl -fsS -X POST "$GATEWAY_URL/workspaces/$WSID/api-keys" \
  -H "$(auth)" -H "Content-Type: application/json" \
  -d '{"scopes":["*"]}')
WORKSPACE_KEY=$(echo "$KEY" | jq -r '.key // .apiKey // .api_key')
echo "workspace_key_prefix=${WORKSPACE_KEY:0:12}..."

echo "==> 3. Source ($TYPE)"
if [[ "$TYPE" == "database_url" ]]; then
  [[ -n "$CONNECTION_URL" && -n "$TABLES" ]] || { echo "database_url requiere --connection-url y --tables"; exit 1; }
  IFS=',' read -ra TABLE_ARR <<< "$TABLES"
  TABLES_JSON=$(printf '%s\n' "${TABLE_ARR[@]}" | jq -R . | jq -s .)
  SRC_BODY=$(jq -n \
    --arg url "$CONNECTION_URL" \
    --argjson tables "$TABLES_JSON" \
    '{type:"database_url",name:"Catalog",config:{connectionUrl:$url,tables:$tables}}')
elif [[ "$TYPE" == "csv" ]]; then
  [[ -n "$CSV_PATH" && -f "$CSV_PATH" ]] || { echo "csv requiere --csv con archivo existente"; exit 1; }
  SRC_BODY='{"type":"csv","name":"Catalog CSV","config":{}}'
else
  echo "type soportados: database_url, csv"
  exit 1
fi

SRC=$(curl -fsS -X POST "$GATEWAY_URL/sources" \
  -H "$(wauth)" -H "Content-Type: application/json" \
  -d "$SRC_BODY")
SRCID=$(echo "$SRC" | jq -r .id)
echo "source_id=$SRCID"

if [[ "$TYPE" == "csv" ]]; then
  curl -fsS -X POST "$GATEWAY_URL/sources/$SRCID/upload" \
    -H "$(wauth)" -H "Content-Type: text/csv" \
    --data-binary @"$CSV_PATH" | jq -r '.uploaded // .rows // "uploaded"'
fi

echo "==> 4. Esperar profiling"
for _ in $(seq 1 30); do
  STATUS=$(curl -fsS "$GATEWAY_URL/sources/$SRCID/status" -H "$(wauth)" | jq -r '.maturityStatus // .maturity_status')
  echo "  status=$STATUS"
  [[ "$STATUS" == "profiled" || "$STATUS" == "mapped" || "$STATUS" == "indexed" || "$STATUS" == "validated" || "$STATUS" == "agent_ready" ]] && break
  sleep 5
done

echo "==> 5. Mapping (product genérico CSV/DB)"
PROFILE=$(curl -fsS "$GATEWAY_URL/sources/$SRCID/profile" -H "$(wauth)")
FIELDS=$(echo "$PROFILE" | jq '[.tables[]?.columns[]?.name] | unique')
HAS_SKU=$(echo "$FIELDS" | jq 'index("sku") != null')
HAS_NAME=$(echo "$FIELDS" | jq 'index("name") != null')
HAS_DESC=$(echo "$FIELDS" | jq 'index("description") != null')
HAS_PRICE=$(echo "$FIELDS" | jq 'index("price") != null')
HAS_COLOR=$(echo "$FIELDS" | jq 'index("color") != null')
HAS_AVAIL=$(echo "$FIELDS" | jq 'index("available") != null')

build_field() {
  local col="$1" type="$2" searchable="$3" filterable="$4"
  jq -n --arg col "$col" --arg type "$type" --argjson s "$searchable" --argjson f "$filterable" \
    '{name:$col,sourceColumn:$col,type:$type,description:$col,searchable:$s,filterable:$f,visible:true,sensitive:false}'
}

FIELD_LIST='[]'
if [[ $(echo "$HAS_SKU") == "true" ]]; then FIELD_LIST=$(echo "$FIELD_LIST" | jq --argjson f "$(build_field sku string true true)" '. + [$f]'); fi
if [[ $(echo "$HAS_NAME") == "true" ]]; then FIELD_LIST=$(echo "$FIELD_LIST" | jq --argjson f "$(build_field name string true false)" '. + [$f]'); fi
if [[ $(echo "$HAS_DESC") == "true" ]]; then FIELD_LIST=$(echo "$FIELD_LIST" | jq --argjson f "$(build_field description string true false)" '. + [$f]'); fi
if [[ $(echo "$HAS_PRICE") == "true" ]]; then FIELD_LIST=$(echo "$FIELD_LIST" | jq --argjson f "$(build_field price number false true)" '. + [$f]'); fi
if [[ $(echo "$HAS_COLOR") == "true" ]]; then FIELD_LIST=$(echo "$FIELD_LIST" | jq --argjson f "$(build_field color string false true)" '. + [$f]'); fi
if [[ $(echo "$HAS_AVAIL") == "true" ]]; then FIELD_LIST=$(echo "$FIELD_LIST" | jq --argjson f "$(build_field available boolean false true)" '. + [$f]'); fi

SOURCE_TABLE=$(echo "$PROFILE" | jq -r '.tables[0].table // "csv"')
MAPPING=$(jq -n --argjson fields "$FIELD_LIST" --arg table "$SOURCE_TABLE" \
  '{document:{entities:[{entity:"product",description:"Catalogo",sourceTable:$table,fields:$fields,rules:[],defaultFilters:[],embeddingTextTemplate:"{{name}} {{description}} {{sku}}"}]}}')
curl -fsS -X POST "$GATEWAY_URL/sources/$SRCID/mapping" \
  -H "$(wauth)" -H "Content-Type: application/json" \
  -d "$MAPPING" | jq '{id, version}'

echo "==> 6. Index"
curl -fsS -X POST "$GATEWAY_URL/sources/$SRCID/index" -H "$(wauth)" | jq .
for _ in $(seq 1 40); do
  STATUS=$(curl -fsS "$GATEWAY_URL/sources/$SRCID/status" -H "$(wauth)" | jq -r '.maturityStatus // .maturity_status')
  echo "  status=$STATUS"
  [[ "$STATUS" == "indexed" || "$STATUS" == "validated" || "$STATUS" == "agent_ready" ]] && break
  sleep 5
done

echo "==> 7. Eval set (agrega casos reales del negocio)"
SET=$(curl -fsS -X POST "$GATEWAY_URL/evals/sets" \
  -H "$(wauth)" -H "Content-Type: application/json" \
  -d "{\"name\":\"Onboarding\",\"sourceId\":\"$SRCID\",\"threshold\":$THRESHOLD}")
SETID=$(echo "$SET" | jq -r .id)

SKU_QUERY=$(echo "$PROFILE" | jq -r '.tables[0].columns[]? | select(.name=="sku") | .topValues[0].value // empty')
if [[ -n "$SKU_QUERY" ]]; then
  RECORD_ID=$(curl -fsS -X POST "$GATEWAY_URL/query" \
    -H "$(wauth)" -H "Content-Type: application/json" \
    -d "{\"query\":\"$SKU_QUERY\",\"limit\":1}" | jq -r '.results[0].id // empty')
  if [[ -n "$RECORD_ID" ]]; then
    echo "  eval case query=$SKU_QUERY record_id=$RECORD_ID (ajusta expectedExternalIds manualmente si hace falta)"
    curl -fsS -X POST "$GATEWAY_URL/evals/sets/$SETID/cases" \
      -H "$(wauth)" -H "Content-Type: application/json" \
      -d "{\"query\":\"$SKU_QUERY\",\"expectedExternalIds\":[]}" >/dev/null || true
  fi
fi

RUN=$(curl -fsS -X POST "$GATEWAY_URL/evals/run" \
  -H "$(wauth)" -H "Content-Type: application/json" \
  -d "{\"evalSetId\":\"$SETID\"}")
RUNID=$(echo "$RUN" | jq -r '.runId // .id')
echo "  eval_run_id=$RUNID (espera a que el worker complete)"
for _ in $(seq 1 36); do
  STATUS=$(curl -fsS "$GATEWAY_URL/sources/$SRCID/status" -H "$(wauth)" | jq -r '.maturityStatus // .maturity_status')
  echo "  source_status=$STATUS"
  [[ "$STATUS" == "validated" || "$STATUS" == "agent_ready" ]] && break
  sleep 5
done

echo "==> 8. Activate"
curl -fsS -X POST "$GATEWAY_URL/sources/$SRCID/activate" -H "$(wauth)" | jq .
TOOLS=$(curl -fsS "$GATEWAY_URL/tools" -H "$(wauth)")
echo "$TOOLS" | jq '[.tools[].name]'

echo ""
echo "Listo. Conecta en Whaapy:"
echo "  URL: https://mcp.data.whaapy.com/mcp"
echo "  Auth: bearer $WORKSPACE_KEY"
echo "  workspace_id=$WSID source_id=$SRCID"
