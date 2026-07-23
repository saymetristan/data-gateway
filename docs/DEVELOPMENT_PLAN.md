# Development Plan — Tsuzuro Data Gateway

## Propósito y objetivos del proyecto

Construir una capa de infraestructura que convierta fuentes de datos de negocio (bases externas vía database URL —Postgres/MySQL/Supabase—, Shopify, CSV) en herramientas consultables por agentes de IA de forma segura, precisa y auditable.

Objetivos concretos:

1. Conectar fuentes de datos heterogéneas con almacenamiento raw y sincronización.
2. Generar automáticamente embeddings, índices lexicales y todo lo necesario para vectorizar y buscar.
3. Compilar tools tipadas (JSON Schema) para agentes a partir del semantic mapping validado.
4. Exponer manifest de tools + endpoint de invocación para que los clientes construyan sus propios servidores MCP, más un MCP server de referencia.
5. Calidad de búsqueda robusta y determinística que funcione incluso con modelos pequeños: la confiabilidad vive en el retrieval y los schemas, no en el LLM.

## Contexto y antecedentes

- Documento de partida: `data-gateway-punto-de-partida.md` (visión, casos de uso, riesgos). Este plan lo toma como base pero corrige decisiones de ejecución.
- Decisiones clave tomadas en la discusión previa:
  - **Sin schema canónico físico.** Una tabla genérica `records` (JSONB); la "entidad" es metadata definida por el semantic mapping, no schema SQL por entidad. Los domain packs se extraen después de tener 2 casos reales, no se diseñan antes.
  - **Búsqueda híbrida real**: filtros estructurados (determinísticos) + full-text lexical (`tsvector`/`pg_trgm`) + vector search (`pgvector` HNSW) → fusión RRF → reranker opcional (fase posterior). El lexical es obligatorio: embeddings fallan con SKUs, tallas y marcas.
  - **Extracción determinística de filtros antes del LLM**: precios por regex, enums por match contra valores reales del profiling. El LLM solo rellena slots tipados cuando lo determinístico no alcanza.
  - **Tool compiler como producto central**: el mapping validado compila tools con JSON Schema cuyos `enum` salen de los valores reales de la data. La calidad se mueve del prompt al schema.
  - **MCP por exposición, no por construcción**: `GET /workspaces/:id/tools` (manifest) + `POST /tools/:name/invoke` (ejecución con API key scoped). MCP server de referencia como paquete consumible; los clientes que necesiten tools adicionales construyen su propio server sobre el manifest.
  - **Ejecución vertical, no horizontal**: primer slice end-to-end con el conector database URL sobre un catálogo fixture, segundo dominio (Shopify) para validar la abstracción, y solo entonces tool compiler y MCP.
  - **Enriquecimiento IA en ingest, nunca en query-time**: atributos semánticos (ej. atributos de producto derivados de descripciones) se generan una vez y se guardan como data.
  - **Confidence determinístico**: calculado con señales de retrieval (gap de scores, cobertura de filtros, overlap lexical), no inventado por LLM.
- Restricciones del documento original que se mantienen: no SQL libre, permisos por campo desde el inicio, raw storage siempre, evals como gate de activación, estados de madurez de fuente (`connected → profiled → indexed → mapped → validated → agent-ready`), aislamiento por workspace.

## Stack técnico

- **Runtime/API**: Node.js + TypeScript + Hono
- **Base de datos**: Postgres + `pgvector` + `pg_trgm` + `unaccent`; full-text con configuración `spanish`. Local: Docker Compose (imagen `pgvector/pgvector:pg17`). Prod: Supabase proyecto `data-ingest` (Postgres 17.6, pgvector 0.8.0, extensiones ya habilitadas, ref `zrwnxulqnyeuzhajbeju`)
- **ORM/migraciones**: Drizzle
- **Queue/workers**: pg-boss (jobs en Postgres con encolado transaccional junto a las escrituras de datos); migrar a BullMQ + Redis solo si el volumen lo exige
- **Embeddings**: `qwen/qwen3-embedding-8b` vía OpenRouter como baseline (supera a `bge-m3` en MTEB 2026 —70.6 vs 63.2— al mismo precio de $0.01/M; solicitar `dimensions: 1024` vía Matryoshka porque el índice HNSW de pgvector soporta máx. 2000 dims); `baai/bge-m3` disponible en el mismo endpoint para A/B vía evals; proveedor detrás de interfaz y modelo+dims registrados por embedding
- **LLM (solo ingest y fallback de parsing)**: `nvidia/nemotron-3-ultra-550b-a55b:free` vía OpenRouter, detrás de interfaz configurable
- **Validación**: Zod (request/response y configs de mapping)
- **Package manager**: pnpm (workspaces de monorepo)
- **Deployment**: Railway proyecto `data-gateway` (servicios api + worker) + Supabase `data-ingest` como Postgres prod; dominio objetivo `data.whaapy.com`

## Setup ya ejecutado (pre-fase 1)

El workspace ya quedó configurado vía `project-setup` + yuntro; nada de esto se repite en fase 1:

- Repo `saymetristan/data-gateway` (privado) con git inicializado
- MCPs project-scoped: `data-gateway-supabase` (prod DB) y `data-gateway-railway` (con project token); `.cursor/mcp.json` gitignored + `.example` regenerable con `pnpm mcp:example`
- Supabase `data-ingest` verificado limpio; extensiones `vector`/`pg_trgm`/`unaccent` habilitadas vía migración registrada
- Railway proyecto `data-gateway` creado (env production, sin servicios aún)
- `.env` real con `OPENROUTER_API_KEY` y `CREDENTIALS_ENCRYPTION_KEY` generada; `.env.example` como espejo documentado para variables de Railway
- Cursor rules (7 propias + generadas por yuntro), `.agent/operating-model.yaml`, hooks, skills `feature-cycle`/`platform-change`
- CI: `agent-doctor.yml` (yuntro) + `security.yml` (gitleaks); Renovate configurado
- `package.json` raíz con `engines` (node ≥22, pnpm ≥9) y script `mcp:example`; `.nvmrc`, `.editorconfig`
- Branch protection NO disponible (GitHub free + repo privado); mitigación: hook de yuntro bloquea `git push --force` en agentes
- Fase 1 ajustada: el monorepo se construye extendiendo el `package.json` raíz existente

## Tareas de desarrollo

### Fase 1: Fundaciones (repo, schema base, API skeleton) — COMPLETADA

- Inicializar monorepo TypeScript (extendiendo el `package.json` raíz existente con pnpm workspaces)
  - `apps/api` (Hono), `apps/worker` (pg-boss), `packages/core` (dominio compartido), `packages/mcp-server` (stub)
  - Tooling: tsconfig estricto, ESLint, Prettier, Vitest, scripts npm
  - CI `ci.yml`: lint + typecheck + test con Postgres de servicio
- Docker Compose: Postgres con `pgvector`, `pg_trgm` y `unaccent` (`pgvector/pgvector:pg17`)
- Schema inicial con Drizzle + migraciones (11 tablas, extensiones, `es_unaccent`, HNSW/GIN)
- API skeleton: healthcheck, auth admin + workspace API key, `app.onError`, scoping por workspace
- CRUD mínimo: `POST /workspaces`, `POST /workspaces/:id/api-keys`, `POST /sources`
- Worker pg-boss: heartbeat job + graceful shutdown
- Tests unit + integration (13 tests)
- STOP — revisión humana antes de fase 2

### Fase 2: Ingesta e indexación (conector database URL como fuente inicial) — COMPLETADA

- Conector database URL (Postgres + MySQL; Supabase = Postgres)
  - Validación read-only al crear fuente (422 si tiene write)
  - Credenciales cifradas AES-256-GCM (`enc:v1:...`)
  - Introspección schema (information_schema + pg_catalog para PKs)
  - Sync incremental por cursor + full sync; hash idempotente en raw
- Conector CSV (`POST /sources/:id/upload`)
- Profiling sobre raw + `GET /sources/:id/profile` + tabla `source_profiles`
- Mapping Zod (`POST /sources/:id/mapping`) con validación contra perfil, versionado
- Enriquecimiento LLM opcional en ingest + cache `record_enrichments`
- Index pipeline: `source.index` + `embeddings.generate` (OpenRouter + mocks)
  - `records.search_source` → `search_text` generado
  - unique `(record_id, embedding_model, mapping_version)`
- `POST /sources/:id/sync|index`, `GET /sources/:id/status`
- Fixture ecommerce en docker-compose (`fixture-db:5433`, 300 productos, `readonly_user`)
- Tests: 25 passing (unit + integration e2e con fixture)
- STOP — revisión humana antes de fase 3

### Fase 3: Query engine (búsqueda híbrida + API de consulta) — COMPLETADA

- Extractor determinístico de filtros (`packages/core/src/query/extract-filters.ts`)
  - Números/rangos por regex en español (`menos de`, `entre X y Y`, formatos `$1,500` / `1.500`)
  - Enums por match contra `topValues` del profiling (color, talla, categoría)
  - Booleanos (`disponible`, `en stock`, `agotado`)
  - Fallback LLM opcional (`useLlmFallback`) validado con Zod dinámico contra mapping; query-path funciona sin LLM
- Motor híbrido (`retrieval.ts` + `rrf.ts`, k=60)
  - Filtros JSONB parametrizados; default filters del mapping siempre ganan sobre request
  - Lexical: `websearch_to_tsquery('es_unaccent', f_unaccent(...))` + `pg_trgm` para SKUs cortos
  - Vector: HNSW cosine con `embedding_model` + `mapping_version` activos
  - Degradación a `lexical` si no hay embeddings; `filter_only` si no queda texto libre
- Confidence determinístico (`confidence.ts`): blend lineal de gap RRF, cobertura de filtros, overlap lexical, fill ratio
- `POST /query` con scope `query:execute` (legacy keys sin scopes siguen permitidas)
  - Response: `results`, `applied_filters`, `query_type`, `confidence`, `sources_used`, `warnings`
  - Shaping: campos `sensitive` / `visible:false` nunca salen (ni en `applied_filters`)
- Providers de embeddings/LLM en API (`apps/api/src/providers.ts`); env alineado con worker
- Logging en `query_logs` (primer writer): raw, structured, tipo, filtros, latencia, confidence, error
- Tests: 65 passing (unit extractor/RRF/confidence/shaping/LLM + integration E2E fixture + scope API)
- STOP — revisión humana antes de fase 4

### Fase 3b: Robust client filters (contrato público) — COMPLETADA

- `query` opcional: filter-only / preference-only / híbrida
- Validación estricta de filtros estructurados → HTTP 422 (no ignore silencioso)
- `GET /query/capabilities` para campos, operadores y valores sugeridos seguros
- Profiling de valores atómicos en arrays JSON (`collections`, tags, etc.)
- Retrieval policy ampliada: field aliases/behaviors + RRF query-time
- Tool `suggest_filter_values_<entity>` para descubrimiento de valores canónicos
- Change record: `docs/changes/2026/07/2026-07-23-robust-client-filters.md`

### Fase 4: Evals como gate de activación — COMPLETADA

- Schemas Zod (`packages/core/src/schemas/evals.ts`): sets, cases (≥1 assertion), runs, métricas tipadas
- Migración `0003`: `eval_sets.source_id` (gate por fuente) + `source_transitions` (auditoría)
- Máquina de estados auditada (`services/maturity.ts`): `connected → profiled → mapped → indexed → validated → agent_ready`
- Runner in-process (`services/evals.ts`) + job worker `evals.run`; métricas: score, precision@k, filterAccuracy, sensitiveLeaks, latencia p50/p95
- CRUD API: `POST/GET /evals/sets`, `POST /evals/sets/:id/cases`, `POST /evals/run`, `GET /evals/runs/:id` (scopes `evals:read`/`evals:write`)
- `POST /sources/:id/activate`: gate por último eval run completado del set aplicable (específico de fuente o global del workspace)
- Run exitoso (`score >= threshold`) promueve fuentes `indexed` → `validated`; activación explícita → `agent_ready`
- Fixture `fixtures/ecommerce-evals.json` (24 cases: SKU, precio, enums, sensibles, disponibilidad)
- Tests: unit métricas/state machine/schemas + integration E2E (run, gate, re-index invalida, scope API)
- STOP — revisión humana antes de fase 5

### Fase 5: Segundo dominio — conector Shopify (validación de la abstracción) — COMPLETADA

- Conector Shopify (GraphQL Admin API + `MockShopifyClient` determinístico para CI)
  - Auth por access token de custom app; validación al crear fuente
  - Full/incremental sync de productos, variantes y colecciones → `source_records_raw` (`products:{id}`, `variants:{id}`)
  - Variantes denormalizadas con datos del producto padre para query sin joins
- Webhooks `POST /webhooks/shopify` con HMAC + job `shopify.webhook`; topics: create/update/delete product, inventory_levels/update
- Sync programado de respaldo cada 6h (`shopify.sync.scheduled`)
- Mapping fixture `fixtures/shopify-mapping.json` (entidad `variant`, regla `available` compuesta, `cost` sensitive)
- Eval set `fixtures/shopify-evals.json` (18 casos)
- **Checkpoint de abstracción** (`docs/ABSTRACTION_CHECKPOINT.md`): `indexSource({ invalidateMaturity })`, rules `conditions[]`, dispatcher `syncSource()`
- Tests: unit HMAC/transform/dedupe/rules + integration E2E, incremental, webhooks, API HMAC
- STOP — revisión humana antes de fase 6

### Fase 6: Tool compiler + capa MCP

- Tool compiler: mapping validado → definiciones de tools
  - Por entidad: `search_<entity>`, `check_availability_<entity>` (extensible por configuración)
  - JSON Schema de parámetros generado desde campos `filterable`: tipos correctos, `enum` poblados con valores reales del profiling, descripciones desde el mapping
  - Descripción de la tool generada desde la metadata del workspace/entidad
  - Tools versionadas junto al mapping (`mapping_version`)
- `GET /workspaces/:id/tools` — manifest de tools (JSON Schema completo, listo para montar en cualquier framework de agentes o server MCP)
- `POST /tools/:name/invoke` — ejecución vía query engine, con API key scoped, logging en `query_logs`
- Solo fuentes en estado `agent-ready` aparecen en el manifest
- MCP server de referencia (`packages/mcp-server`)
  - Paquete publicable que consume manifest + invoke con una API key
  - Transporte stdio y Streamable HTTP
  - README con ejemplo de extensión (cliente agrega sus propias tools al mismo server)
- Dogfooding: script de agente de prueba con un modelo pequeño vía OpenRouter consumiendo las tools generadas; registrar fricciones (Whaapy se integra después, fuera de este plan)
- Tests: schema generado válido contra los datos reales, invoke respeta permisos y filtros default, manifest excluye fuentes no agent-ready
- Realizar auto-revisión del código; marcar como hecho solo cuando la fase cumpla el 100% de los requisitos
- STOP y esperar revisión humana

### Fase 7: Hardening y operación

- Row-Level Security de Postgres por `workspace_id` (defensa en profundidad además del scoping en app)
- Reindexación incremental por cambio de mapping o de modelo de embeddings (usar `mapping_version`/`embedding_model` ya registrados)
- Rate limiting por API key (in-memory por instancia es suficiente en MVP; sin Redis en el stack)
- `GET /query-logs` con filtros (workspace, fecha, tipo, confidence bajo)
- Métricas operativas mínimas: latencia p50/p95 de `/query`, tamaño de colas, errores de sync
- README del proyecto: arquitectura, setup local, flujo de onboarding de una fuente, cómo consumir el manifest MCP
- Realizar auto-revisión del código; marcar como hecho solo cuando la fase cumpla el 100% de los requisitos
- STOP y esperar revisión humana

## Consideraciones y requisitos importantes

- No sobre-ingeniería: no construir abstracción "domain pack" ni UI de mapping ni mapping assistant en este plan; se extraen después con evidencia de 2 dominios reales
- No código placeholder ni TODOs
- El LLM nunca genera SQL ni decide permisos; solo rellena slots tipados validados contra el mapping
- Campos `sensitive`/`visible: false` jamás salen en ninguna respuesta del Gateway (ni en results, ni en logs expuestos por API)
- Todo embedding registra modelo y versión de mapping para permitir reindexación y A/B
- El query-path debe funcionar sin LLM (filtros determinísticos + híbrida); el LLM es fallback, no dependencia
- Aislamiento estricto por workspace en cada query (app + RLS)
- `indexed` no significa `agent-ready`: el gate de evals es obligatorio
- API request/response validados con Zod en todos los endpoints

## Decisiones técnicas


| Decisión                                                                 | Alternativa descartada                     | Razón                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records` JSONB + mapping como metadata                                  | Schema canónico físico por entidad         | El schema universal nunca aguanta el caso N+1; el mapping versionado es más barato y flexible                                                                                                   |
| pgvector + tsvector + RRF en Postgres                                    | Vector DB dedicada (Qdrant/Pinecone)       | Un solo store transaccional para filtros+lexical+vector; HNSW aguanta millones de vectores; migrar después es trivial si hiciera falta                                                          |
| pg-boss (jobs en Postgres)                                               | BullMQ + Redis                             | Encolado transaccional con las escrituras de datos (sin estados inconsistentes record/job), una pieza menos de infra; migrar a BullMQ es un cambio aislado si el volumen lo exige               |
| TypeScript end-to-end                                                    | Python (FastAPI) para el ecosistema ML     | El query-path no tiene ML local (embeddings/reranker vía API); TS comparte tipos entre API, tools y MCP server, y el ecosistema MCP es TS-first; un reranker local futuro sería sidecar aislado |
| `ts_rank` para lexical en MVP                                            | BM25 (ParadeDB `pg_search`)                | RRF solo consume el orden del ranking; BM25 queda como upgrade documentado si los evals muestran debilidad lexical                                                                              |
| Extracción determinística primero, LLM como fallback                     | LLM interpreta toda la query               | Funciona con modelos pequeños, es auditable, latencia y costo menores                                                                                                                           |
| Tools compiladas desde el mapping con enums reales                       | Tool genérica única `search_business_data` | Schemas tipados con enums reales reducen drásticamente errores del agente; es el diferenciador del producto                                                                                     |
| Exponer manifest + invoke; MCP server de referencia                      | Hostear el MCP de cada cliente             | Los clientes necesitan agregar sus propias tools; el contrato REST es el producto, el server es conveniencia                                                                                    |
| Enriquecimiento IA en ingest                                             | Enriquecimiento en query-time              | Query-path determinístico, costo único, resultados cacheables y auditables                                                                                                                      |
| Confidence por señales de retrieval                                      | Confidence generado por LLM                | Determinístico, reproducible, auditable                                                                                                                                                         |
| Slice vertical (DB externa → Shopify → tools)                            | Core horizontal primero                    | Un caso real exigente evita sobreconstrucción y valida la abstracción antes de generalizarla                                                                                                    |
| Conector database URL como fuente inicial (Postgres/MySQL/Supabase)      | CSV/Sheets primero                         | Es el caso de uso prioritario del negocio; la introspección de schema da el profiling más rico y prueba el flujo completo `connected → agent-ready`                                             |
| Sync incremental por cursor + fallback full programado + hash de payload | Full sync siempre                          | Escala sin requerir columnas especiales; el hash da idempotencia y evita re-embeddear registros sin cambios                                                                                     |
| Qwen3-Embedding-8B vía OpenRouter a 1024 dims                            | bge-m3 (candidato original)                | Supera a bge-m3 en todos los benchmarks 2026 al mismo precio; Matryoshka permite respetar el límite de 2000 dims del índice HNSW de pgvector                                                    |
| pnpm                                                                     | Bun / npm                                  | Workspaces maduros para monorepo, lockfile determinístico, estándar del ecosistema; Bun como runtime aún suma riesgo en workers de larga vida                                                   |


## Estrategia de testing

- Unit tests (Vitest) sin dependencias externas: extractor de filtros, RRF, tool compiler, validación de mappings, fórmula de confidence. Proveedores de LLM/embeddings siempre detrás de interfaces mockeables.
- Integration tests contra Postgres efímero (Docker Compose / testcontainers): introspección y sync del conector DB URL (la base fixture actúa como "fuente externa"), pipeline ingest→index, `/query` end-to-end, RLS, invoke de tools.
- Evals como tests de calidad de producto: los eval sets del fixture ecommerce y de Shopify corren en CI; regresión de precision@k bloquea merge.
- Sin tests E2E de UI (no hay UI en este plan).

## Protocolo de debugging

- **Tests fallan**: analizar la causa raíz y corregirla; no rodear el problema
- **Calidad de búsqueda baja en evals**: revisar en este orden: (1) embedding text template, (2) extracción de filtros, (3) pesos de RRF; nunca "arreglar" con prompts
- **Performance**: perfilar la query SQL híbrida (EXPLAIN ANALYZE) antes de tocar arquitectura
- **Problemas de integración (Shopify, embeddings)**: verificar contratos y payloads raw almacenados antes de tocar el pipeline
- **Requisitos ambiguos**: detenerse y pedir aclaración

## QA Checklist

- Todas las instrucciones del usuario seguidas
- Todos los requisitos implementados y testeados
- Sin warnings críticos de lint/typecheck (`tsc --noEmit` y ESLint limpios)
- Código y documentación en español; identificadores de código en inglés consistente
- Convenciones del proyecto respetadas (Prettier, estructura de monorepo)
- Documentación actualizada (README, formato de mapping, contrato de API)
- Seguridad: campos sensibles nunca expuestos, no SQL libre, RLS activo, API keys hasheadas
- Aislamiento multi-tenant verificado con test de cross-workspace
- Eval sets del fixture ecommerce y de Shopify pasan el umbral configurado
- Credenciales de DBs externas cifradas en reposo y conexiones read-only verificadas
- Manifest de tools válido contra JSON Schema spec y consumible por el MCP server de referencia
- Pipelines idempotentes verificados (re-sync no duplica records ni embeddings)