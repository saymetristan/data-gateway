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

### Fase 1: Fundaciones (repo, schema base, API skeleton)

- [ ] Inicializar monorepo TypeScript (extendiendo el `package.json` raíz existente con pnpm workspaces)
  - [ ] `apps/api` (Hono), `apps/worker` (pg-boss), `packages/core` (dominio compartido), `packages/mcp-server` (vacío por ahora)
  - [ ] Tooling: tsconfig estricto, ESLint, Prettier, Vitest, scripts npm
  - [ ] CI `ci.yml`: lint + typecheck + test con Postgres de servicio (se suma a `agent-doctor.yml` y `security.yml` ya existentes)
- [ ] Docker Compose: Postgres con `pgvector`, `pg_trgm` y `unaccent` (imagen `pgvector/pgvector:pg17`, paridad con prod 17.6)
- [ ] Schema inicial con Drizzle + migraciones
  - [ ] `workspaces`, `api_keys` (hash, scopes, workspace_id)
  - [ ] `sources` (tipo, config, estado de madurez), `source_records_raw` (payload original, source_record_id, synced_at)
  - [ ] `mappings` (documento JSONB versionado: entidades, campos, flags `visible/searchable/filterable/sensitive`, reglas, embedding text template)
  - [ ] `records` (workspace_id, source_id, entity, external_id, data JSONB, search_text tsvector generado con config `spanish` + `unaccent`, mapping_version)
  - [ ] `record_embeddings` (record_id, embedding vector, embedding_model, mapping_version)
  - [ ] `query_logs`, `eval_sets`, `eval_cases`, `eval_runs`
- [ ] Índices: HNSW sobre embeddings, GIN sobre `search_text` y sobre campos filtrables en `data`
- [ ] API skeleton: healthcheck, auth por API key, middleware de scoping por workspace, manejo de errores estándar
- [ ] CRUD mínimo: `POST /workspaces`, `POST /sources`
- [ ] Tests: auth/scoping, migraciones aplican limpio
- [ ] Realizar auto-revisión del código; marcar como hecho solo cuando la fase cumpla el 100% de los requisitos
- [ ] STOP y esperar revisión humana

### Fase 2: Ingesta e indexación (conector database URL como fuente inicial)

- [ ] Conector por database URL (Postgres, MySQL y Supabase; Supabase es Postgres, solo cambia la documentación de onboarding)
  - [ ] Validación de conexión read-only al crear la fuente; documentar permisos mínimos requeridos (usuario SELECT-only)
  - [ ] Credenciales cifradas en reposo (nunca en texto plano en `sources.config`)
  - [ ] Introspección de schema: tablas, columnas, tipos, PKs, FKs (vía `information_schema`, abstracción común para ambos motores)
  - [ ] Selección de tablas a sincronizar por fuente
  - [ ] Sync a `source_records_raw`: incremental por columna cursor (`updated_at` o equivalente) cuando exista, fallback a full sync programado; detección de cambios por hash del payload para idempotencia y para no reprocesar registros sin cambios
- [ ] Conector CSV (upload) como secundario, mismo pipeline de raw → profiling → mapping
- [ ] Profiling básico de la fuente
  - [ ] Detección de columnas, tipos inferidos, cardinalidad, nulos, valores frecuentes (top-N por columna)
  - [ ] Persistir perfil; expone `GET /sources/:id/profile`
- [ ] Formato de mapping (YAML/JSON validado con Zod, escrito a mano en esta fase)
  - [ ] Entidad, campos con flags, mapeo columna→campo, reglas (`available = stock > 0`), default filters
  - [ ] **Embedding text template** por entidad: qué campos y en qué formato se concatenan para el embedding
  - [ ] `POST /sources/:id/mapping` con validación contra el perfil (columnas existentes, tipos compatibles)
- [ ] Pipeline de enriquecimiento (worker)
  - [ ] Paso opcional por entidad definido en el mapping: LLM genera atributos semánticos desde descripciones una sola vez en ingest; se guardan en `data` como campos más
  - [ ] Cache/idempotencia: no re-enriquecer registros sin cambios (hash del payload)
- [ ] Pipeline de indexación (worker)
  - [ ] raw → aplicar mapping → upsert en `records` → generar `search_text` → encolar embeddings
  - [ ] Worker de embeddings con batching y registro de `embedding_model` + dims + `mapping_version`
  - [ ] `POST /sources/:id/index` y estado de indexación consultable
- [ ] Fixture de desarrollo: base Postgres seedeada en Docker Compose (catálogo ecommerce realista, ~300 registros) conectada vía database URL; valida el slice completo end-to-end (introspección → raw → records → embeddings)
- [ ] Tests: introspección de schema, sync incremental por cursor y fallback full, idempotencia por hash, aplicación de mapping, generación de search_text, encolado de embeddings (con proveedor de embeddings mockeado)
- [ ] Realizar auto-revisión del código; marcar como hecho solo cuando la fase cumpla el 100% de los requisitos
- [ ] STOP y esperar revisión humana

### Fase 3: Query engine (búsqueda híbrida + API de consulta)

- [ ] Extractor determinístico de filtros
  - [ ] Números/rangos por regex ("menos de 1500" → `price_lte: 1500`)
  - [ ] Enums por match contra valores reales del profiling (talla, color, use_case)
  - [ ] Fallback LLM solo para slots no resueltos, con salida validada por Zod contra los campos filtrables del mapping (nunca SQL, nunca campos fuera del mapping)
- [ ] Motor de retrieval
  - [ ] Filtros estructurados sobre `data` JSONB (solo campos `filterable`; default filters del mapping siempre aplicados)
  - [ ] Búsqueda lexical (`tsvector` config `spanish` + `unaccent`, `pg_trgm` para SKUs/typos); nota: `ts_rank` no es BM25, pero RRF solo necesita el orden — si los evals muestran debilidad lexical, el upgrade path es BM25 real (ParadeDB `pg_search`) o reranker
  - [ ] Búsqueda vectorial (pgvector HNSW) restringida por los mismos filtros
  - [ ] Fusión RRF de ambos rankings
- [ ] Confidence determinístico: gap entre top scores, % de filtros solicitados que se aplicaron, overlap lexical; documentar la fórmula
- [ ] `POST /query` según el contrato del documento de partida (sección 24)
  - [ ] Response con `results`, `applied_filters`, `query_type`, `confidence`, `sources_used`, `warnings`
  - [ ] Filtrado de campos `sensitive`/`visible: false` en la respuesta (nunca salen del Gateway)
- [ ] Logging completo por consulta en `query_logs` (query original, filtros extraídos, tipo, latencia, resultados)
- [ ] Tests: extractor de filtros (casos reales en español), RRF, exclusión de campos sensibles, default filters siempre aplicados
- [ ] Realizar auto-revisión del código; marcar como hecho solo cuando la fase cumpla el 100% de los requisitos
- [ ] STOP y esperar revisión humana

### Fase 4: Evals como gate de activación

- [ ] Modelo de eval cases: query → `expected_result_ids` y/o `must_apply_filters` y/o `must_not_contain_fields`
- [ ] Runner de evals (worker): ejecuta el set contra `/query`, persiste `eval_runs` con métricas (precision@k, filtros correctos, sin campos sensibles, latencia)
- [ ] `POST /evals/run` y `GET /evals/runs/:id`
- [ ] Escribir ≥20 eval cases para el workspace del fixture ecommerce (búsqueda, recomendación, disponibilidad, filtros de precio, SKU exacto)
- [ ] Gate de madurez: una fuente solo pasa a `agent-ready` si su último eval run supera el umbral configurado del workspace
- [ ] Transiciones de estado de fuente implementadas y auditadas (`connected → profiled → indexed → mapped → validated → agent-ready`)
- [ ] Tests: runner con resultados mockeados, gate bloquea activación si fallan evals
- [ ] Realizar auto-revisión del código; marcar como hecho solo cuando la fase cumpla el 100% de los requisitos
- [ ] STOP y esperar revisión humana

### Fase 5: Segundo dominio — conector Shopify (validación de la abstracción)

- [ ] Conector Shopify
  - [ ] Auth por access token de custom app (OAuth público queda fuera de alcance inicial)
  - [ ] Full sync de productos, variantes, inventario y colecciones → `source_records_raw`
  - [ ] Webhooks (`products/update`, `inventory_levels/update`) + sync programado de respaldo
- [ ] Mapping de Shopify (producto/variante/inventario) usando el mismo formato de mapping sin cambios al core
- [ ] Reglas default de ecommerce (`available = status active + stock > 0`, ocultar costo interno)
- [ ] Eval set de ecommerce (≥15 casos: búsqueda, disponibilidad por talla, precio)
- [ ] **Checkpoint de abstracción**: documentar qué hacks fueron necesarios para que el core soportara el segundo dominio; si los hay, corregir el core ahora
- [ ] Tests: idempotencia de webhooks, sync incremental, mapping de variantes
- [ ] Realizar auto-revisión del código; marcar como hecho solo cuando la fase cumpla el 100% de los requisitos
- [ ] STOP y esperar revisión humana

### Fase 6: Tool compiler + capa MCP

- [ ] Tool compiler: mapping validado → definiciones de tools
  - [ ] Por entidad: `search_<entity>`, `check_availability_<entity>` (extensible por configuración)
  - [ ] JSON Schema de parámetros generado desde campos `filterable`: tipos correctos, `enum` poblados con valores reales del profiling, descripciones desde el mapping
  - [ ] Descripción de la tool generada desde la metadata del workspace/entidad
  - [ ] Tools versionadas junto al mapping (`mapping_version`)
- [ ] `GET /workspaces/:id/tools` — manifest de tools (JSON Schema completo, listo para montar en cualquier framework de agentes o server MCP)
- [ ] `POST /tools/:name/invoke` — ejecución vía query engine, con API key scoped, logging en `query_logs`
- [ ] Solo fuentes en estado `agent-ready` aparecen en el manifest
- [ ] MCP server de referencia (`packages/mcp-server`)
  - [ ] Paquete publicable que consume manifest + invoke con una API key
  - [ ] Transporte stdio y Streamable HTTP
  - [ ] README con ejemplo de extensión (cliente agrega sus propias tools al mismo server)
- [ ] Dogfooding: script de agente de prueba con un modelo pequeño vía OpenRouter consumiendo las tools generadas; registrar fricciones (Whaapy se integra después, fuera de este plan)
- [ ] Tests: schema generado válido contra los datos reales, invoke respeta permisos y filtros default, manifest excluye fuentes no agent-ready
- [ ] Realizar auto-revisión del código; marcar como hecho solo cuando la fase cumpla el 100% de los requisitos
- [ ] STOP y esperar revisión humana

### Fase 7: Hardening y operación

- [ ] Row-Level Security de Postgres por `workspace_id` (defensa en profundidad además del scoping en app)
- [ ] Reindexación incremental por cambio de mapping o de modelo de embeddings (usar `mapping_version`/`embedding_model` ya registrados)
- [ ] Rate limiting por API key (in-memory por instancia es suficiente en MVP; sin Redis en el stack)
- [ ] `GET /query-logs` con filtros (workspace, fecha, tipo, confidence bajo)
- [ ] Métricas operativas mínimas: latencia p50/p95 de `/query`, tamaño de colas, errores de sync
- [ ] README del proyecto: arquitectura, setup local, flujo de onboarding de una fuente, cómo consumir el manifest MCP
- [ ] Realizar auto-revisión del código; marcar como hecho solo cuando la fase cumpla el 100% de los requisitos
- [ ] STOP y esperar revisión humana

## Consideraciones y requisitos importantes

- [ ] No sobre-ingeniería: no construir abstracción "domain pack" ni UI de mapping ni mapping assistant en este plan; se extraen después con evidencia de 2 dominios reales
- [ ] No código placeholder ni TODOs
- [ ] El LLM nunca genera SQL ni decide permisos; solo rellena slots tipados validados contra el mapping
- [ ] Campos `sensitive`/`visible: false` jamás salen en ninguna respuesta del Gateway (ni en results, ni en logs expuestos por API)
- [ ] Todo embedding registra modelo y versión de mapping para permitir reindexación y A/B
- [ ] El query-path debe funcionar sin LLM (filtros determinísticos + híbrida); el LLM es fallback, no dependencia
- [ ] Aislamiento estricto por workspace en cada query (app + RLS)
- [ ] `indexed` no significa `agent-ready`: el gate de evals es obligatorio
- [ ] API request/response validados con Zod en todos los endpoints

## Decisiones técnicas

| Decisión | Alternativa descartada | Razón |
| --- | --- | --- |
| `records` JSONB + mapping como metadata | Schema canónico físico por entidad | El schema universal nunca aguanta el caso N+1; el mapping versionado es más barato y flexible |
| pgvector + tsvector + RRF en Postgres | Vector DB dedicada (Qdrant/Pinecone) | Un solo store transaccional para filtros+lexical+vector; HNSW aguanta millones de vectores; migrar después es trivial si hiciera falta |
| pg-boss (jobs en Postgres) | BullMQ + Redis | Encolado transaccional con las escrituras de datos (sin estados inconsistentes record/job), una pieza menos de infra; migrar a BullMQ es un cambio aislado si el volumen lo exige |
| TypeScript end-to-end | Python (FastAPI) para el ecosistema ML | El query-path no tiene ML local (embeddings/reranker vía API); TS comparte tipos entre API, tools y MCP server, y el ecosistema MCP es TS-first; un reranker local futuro sería sidecar aislado |
| `ts_rank` para lexical en MVP | BM25 (ParadeDB `pg_search`) | RRF solo consume el orden del ranking; BM25 queda como upgrade documentado si los evals muestran debilidad lexical |
| Extracción determinística primero, LLM como fallback | LLM interpreta toda la query | Funciona con modelos pequeños, es auditable, latencia y costo menores |
| Tools compiladas desde el mapping con enums reales | Tool genérica única `search_business_data` | Schemas tipados con enums reales reducen drásticamente errores del agente; es el diferenciador del producto |
| Exponer manifest + invoke; MCP server de referencia | Hostear el MCP de cada cliente | Los clientes necesitan agregar sus propias tools; el contrato REST es el producto, el server es conveniencia |
| Enriquecimiento IA en ingest | Enriquecimiento en query-time | Query-path determinístico, costo único, resultados cacheables y auditables |
| Confidence por señales de retrieval | Confidence generado por LLM | Determinístico, reproducible, auditable |
| Slice vertical (DB externa → Shopify → tools) | Core horizontal primero | Un caso real exigente evita sobreconstrucción y valida la abstracción antes de generalizarla |
| Conector database URL como fuente inicial (Postgres/MySQL/Supabase) | CSV/Sheets primero | Es el caso de uso prioritario del negocio; la introspección de schema da el profiling más rico y prueba el flujo completo `connected → agent-ready` |
| Sync incremental por cursor + fallback full programado + hash de payload | Full sync siempre | Escala sin requerir columnas especiales; el hash da idempotencia y evita re-embeddear registros sin cambios |
| Qwen3-Embedding-8B vía OpenRouter a 1024 dims | bge-m3 (candidato original) | Supera a bge-m3 en todos los benchmarks 2026 al mismo precio; Matryoshka permite respetar el límite de 2000 dims del índice HNSW de pgvector |
| pnpm | Bun / npm | Workspaces maduros para monorepo, lockfile determinístico, estándar del ecosistema; Bun como runtime aún suma riesgo en workers de larga vida |

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

- [ ] Todas las instrucciones del usuario seguidas
- [ ] Todos los requisitos implementados y testeados
- [ ] Sin warnings críticos de lint/typecheck (`tsc --noEmit` y ESLint limpios)
- [ ] Código y documentación en español; identificadores de código en inglés consistente
- [ ] Convenciones del proyecto respetadas (Prettier, estructura de monorepo)
- [ ] Documentación actualizada (README, formato de mapping, contrato de API)
- [ ] Seguridad: campos sensibles nunca expuestos, no SQL libre, RLS activo, API keys hasheadas
- [ ] Aislamiento multi-tenant verificado con test de cross-workspace
- [ ] Eval sets del fixture ecommerce y de Shopify pasan el umbral configurado
- [ ] Credenciales de DBs externas cifradas en reposo y conexiones read-only verificadas
- [ ] Manifest de tools válido contra JSON Schema spec y consumible por el MCP server de referencia
- [ ] Pipelines idempotentes verificados (re-sync no duplica records ni embeddings)
