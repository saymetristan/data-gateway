#!/usr/bin/env bash
# Onboarding de un cliente en Data Gateway (prod o local).
# Uso rápido:
#   ADMIN_API_KEY=dgw_admin_... GATEWAY_URL=https://data.whaapy.com ./scripts/onboard-client.sh \
#     --name "Cliente X" --slug cliente-x --type database_url \
#     --connection-url "postgresql://readonly:...@host/db" --tables products
#
# Shopify (preferir secrets por env para no dejarlos en shell history):
#   ADMIN_API_KEY=... SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... SHOPIFY_WEBHOOK_SECRET=... \
#     ./scripts/onboard-client.sh --name "Bayon" --slug bayon --type shopify \
#     --shop-domain bayon.myshopify.com --evals ./bayon-evals.json --activate

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-https://data.whaapy.com}"
ADMIN_API_KEY="${ADMIN_API_KEY:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NAME=""
SLUG=""
TYPE=""
CONNECTION_URL=""
TABLES=""
CSV_PATH=""
THRESHOLD="0.8"
SHOP_DOMAIN="${SHOPIFY_SHOP_DOMAIN:-}"
SHOPIFY_ACCESS_TOKEN="${SHOPIFY_ACCESS_TOKEN:-}"
SHOPIFY_CLIENT_ID="${SHOPIFY_CLIENT_ID:-}"
SHOPIFY_CLIENT_SECRET="${SHOPIFY_CLIENT_SECRET:-}"
SHOPIFY_WEBHOOK_SECRET="${SHOPIFY_WEBHOOK_SECRET:-}"
SHOPIFY_API_VERSION="${SHOPIFY_API_VERSION:-}"
EVALS_PATH=""
ACTIVATE="false"
PRINT_SECRETS="${PRINT_SECRETS:-false}"

usage() {
  sed -n '2,11p' "$0"
  cat <<'EOF'

Args:
  --name NAME --slug slug --type database_url|csv|shopify
  --connection-url URL --tables table1,table2      database_url
  --csv /path/file.csv                             csv
  --shop-domain tienda.myshopify.com               shopify
  --shopify-access-token shpat_...                 shopify legacy
  --shopify-client-id id                           shopify client credentials
  --shopify-client-secret secret                   shopify client credentials (mejor env)
  --webhook-secret whsec_...                       shopify opcional
  --api-version 2025-01                            shopify opcional
  --evals /path/evals.json                         casos reales; schema tipo fixtures/shopify-evals.json
  --activate                                       activar solo si el eval deja la fuente validated
  --print-secrets                                  imprime workspace key completa; úsalo solo para guardar en password manager
EOF
  exit "${1:-1}"
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
    --shop-domain) SHOP_DOMAIN="$2"; shift 2 ;;
    --shopify-access-token) SHOPIFY_ACCESS_TOKEN="$2"; shift 2 ;;
    --shopify-client-id) SHOPIFY_CLIENT_ID="$2"; shift 2 ;;
    --shopify-client-secret) SHOPIFY_CLIENT_SECRET="$2"; shift 2 ;;
    --webhook-secret) SHOPIFY_WEBHOOK_SECRET="$2"; shift 2 ;;
    --api-version) SHOPIFY_API_VERSION="$2"; shift 2 ;;
    --evals) EVALS_PATH="$2"; shift 2 ;;
    --activate) ACTIVATE="true"; shift ;;
    --print-secrets) PRINT_SECRETS="true"; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Argumento desconocido: $1"; usage ;;
  esac
done

[[ -n "$NAME" && -n "$SLUG" && -n "$TYPE" ]] || usage
[[ -n "$ADMIN_API_KEY" ]] || { echo "ADMIN_API_KEY requerida"; exit 1; }

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
elif [[ "$TYPE" == "shopify" ]]; then
  [[ -n "$SHOP_DOMAIN" ]] || {
    echo "shopify requiere --shop-domain"
    exit 1
  }
  [[ -n "$SHOPIFY_ACCESS_TOKEN" || ( -n "$SHOPIFY_CLIENT_ID" && -n "$SHOPIFY_CLIENT_SECRET" ) ]] || {
    echo "shopify requiere SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET, o SHOPIFY_ACCESS_TOKEN legacy"
    exit 1
  }
  SRC_BODY=$(jq -n \
    --arg domain "$SHOP_DOMAIN" \
    --arg token "$SHOPIFY_ACCESS_TOKEN" \
    --arg clientId "$SHOPIFY_CLIENT_ID" \
    --arg clientSecret "$SHOPIFY_CLIENT_SECRET" \
    --arg webhook "$SHOPIFY_WEBHOOK_SECRET" \
    --arg api "$SHOPIFY_API_VERSION" \
    '{
      type:"shopify",
      name:"Shopify",
      config:{shopDomain:$domain}
    }
    | if $token != "" then .config.accessToken = $token else . end
    | if $clientId != "" then .config.clientId = $clientId else . end
    | if $clientSecret != "" then .config.clientSecret = $clientSecret else . end
    | if $webhook != "" then .config.webhookSecret = $webhook else . end
    | if $api != "" then .config.apiVersion = $api else . end')
else
  echo "type soportados: database_url, csv, shopify"
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

echo "==> 5. Mapping"
PROFILE=$(curl -fsS "$GATEWAY_URL/sources/$SRCID/profile" -H "$(wauth)")
if [[ "$TYPE" == "shopify" ]]; then
  MAPPING=$(jq -n --slurpfile document "$REPO_ROOT/fixtures/shopify-mapping.json" \
    '{document:$document[0]}')
else
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
fi
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

echo "==> 7. Evals"
if [[ -n "$EVALS_PATH" ]]; then
  [[ -f "$EVALS_PATH" ]] || { echo "--evals no existe: $EVALS_PATH"; exit 1; }
  EVAL_NAME=$(jq -r '.name // "Onboarding"' "$EVALS_PATH")
  EVAL_DESCRIPTION=$(jq -r '.description // empty' "$EVALS_PATH")
  EVAL_THRESHOLD=$(jq -r ".threshold // $THRESHOLD" "$EVALS_PATH")
  SET_BODY=$(jq -n \
    --arg name "$EVAL_NAME" \
    --arg description "$EVAL_DESCRIPTION" \
    --arg sourceId "$SRCID" \
    --argjson threshold "$EVAL_THRESHOLD" \
    '{name:$name,sourceId:$sourceId,threshold:$threshold}
    | if $description != "" then .description = $description else . end')
  SET=$(curl -fsS -X POST "$GATEWAY_URL/evals/sets" \
    -H "$(wauth)" -H "Content-Type: application/json" \
    -d "$SET_BODY")
  SETID=$(echo "$SET" | jq -r .id)
  echo "  eval_set_id=$SETID"

  while IFS= read -r CASE; do
    curl -fsS -X POST "$GATEWAY_URL/evals/sets/$SETID/cases" \
      -H "$(wauth)" -H "Content-Type: application/json" \
      -d "$CASE" >/dev/null
  done < <(jq -c '.cases[]' "$EVALS_PATH")

  RUN=$(curl -fsS -X POST "$GATEWAY_URL/evals/run" \
    -H "$(wauth)" -H "Content-Type: application/json" \
    -d "{\"evalSetId\":\"$SETID\"}")
  RUNID=$(echo "$RUN" | jq -r '.runId // .id')
  echo "  eval_run_id=$RUNID"
  for _ in $(seq 1 36); do
    STATUS=$(curl -fsS "$GATEWAY_URL/sources/$SRCID/status" -H "$(wauth)" | jq -r '.maturityStatus // .maturity_status')
    echo "  source_status=$STATUS"
    [[ "$STATUS" == "validated" || "$STATUS" == "agent_ready" ]] && break
    sleep 5
  done
else
  echo "  sin --evals; omito eval run y activate automático"
fi

echo "==> 8. Activate"
STATUS=$(curl -fsS "$GATEWAY_URL/sources/$SRCID/status" -H "$(wauth)" | jq -r '.maturityStatus // .maturity_status')
if [[ "$ACTIVATE" == "true" ]]; then
  if [[ "$STATUS" != "validated" && "$STATUS" != "agent_ready" ]]; then
    echo "  no activo: source_status=$STATUS (requiere validated)"
    exit 1
  fi
  curl -fsS -X POST "$GATEWAY_URL/sources/$SRCID/activate" -H "$(wauth)" | jq .
  TOOLS=$(curl -fsS "$GATEWAY_URL/tools" -H "$(wauth)")
  echo "$TOOLS" | jq '[.tools[].name]'
else
  echo "  omitido; usa --activate después de pasar evals reales"
fi

echo ""
echo "Listo. Conecta en Whaapy:"
echo "  URL: https://mcp.data.whaapy.com/mcp"
if [[ "$PRINT_SECRETS" == "true" ]]; then
  echo "  Auth: bearer $WORKSPACE_KEY"
else
  echo "  Auth: bearer <WORKSPACE_KEY> (prefix ${WORKSPACE_KEY:0:12}...)"
fi
echo "  workspace_id=$WSID source_id=$SRCID"
