# Tsuzuro Data Gateway

## 1. resumen ejecutivo

**Tsuzuro Data Gateway** es una capa de infraestructura para convertir bases de datos, inventarios, catálogos, documentos y fuentes externas en herramientas consultables por agentes de inteligencia artificial.

El objetivo no es crear “otro chatbot” ni depender de que un LLM entienda mágicamente cualquier base de datos. El objetivo es construir un sistema robusto que permita a agentes conversacionales consultar datos reales de negocio de forma segura, precisa y reutilizable.

La tesis principal:

> Los agentes no fallan solo porque el modelo sea malo. Fallan porque no tienen una capa confiable para consultar datos vivos, semánticos y específicos del negocio.

Tsuzuro Data Gateway busca resolver ese problema mediante una arquitectura que combina:

- conectores de datos
- normalización
- introspección de esquemas
- mapeo semántico
- búsqueda híbrida
- reglas de negocio
- permisos
- evaluación de precisión
- una API estándar consumible por agentes

El sistema debe poder servir tanto para casos internos de Whaapy/Tsuzuro como para clientes externos que quieran conectar inventarios, bases de datos, Shopify, CRMs, ERPs, Google Sheets o fuentes similares.

---

## 2. problema

Actualmente, muchos proyectos con agentes requieren que el agente consulte información real:

- productos
- inventarios
- propiedades
- pedidos
- leads
- clientes
- tickets
- políticas
- documentos
- catálogos técnicos
- bases operativas

El patrón se repite en varios proyectos, pero suele resolverse de forma artesanal:

```txt
proyecto nuevo
↓
middleware nuevo
↓
normalización específica
↓
búsqueda híbrida específica
↓
prompt específico
↓
errores específicos
```

Esto provoca varios problemas:

1. cada proyecto tiene distinta calidad de búsqueda.
2. los proyectos “sencillos” nacen débiles porque no heredan la robustez de los proyectos complejos.
3. se duplica lógica de ingesta, búsqueda, filtros, ranking y respuesta.
4. los agentes pueden inventar, ignorar restricciones o consultar datos incorrectos.
5. no existe una forma estándar de medir precisión.
6. no hay una interfaz común para que los agentes consulten datos.
7. cada integración puede convertirse en un caso especial difícil de mantener.

El problema real no es solo técnico. Es de confiabilidad.

Un agente que recomienda productos, propiedades o soluciones usando datos incorrectos puede:

- prometer inventario inexistente
- mostrar precios incorrectos
- recomendar productos no disponibles
- exponer datos internos
- confundir reglas del negocio
- perder ventas
- generar conflictos con clientes

Por eso la solución debe separar claramente tres responsabilidades:

```txt
1. traer datos
2. entender datos
3. permitir que agentes consulten datos
```

---

## 3. visión

La visión es construir una capa común para que cualquier agente pueda consultar datos de negocio sin tener que conocer la fuente original.

```txt
Shopify / SAP / CRM / ERP / Sheets / Postgres / APIs / documentos
        ↓
Connectors & Middleware
        ↓
Raw Storage
        ↓
Canonical / Normalized Postgres
        ↓
Semantic Mapping
        ↓
Hybrid Query Engine
        ↓
Agent Tool API
        ↓
Whaapy / Tsuzuro / agentes externos
```

El agente no debería saber si la información viene de Shopify, SAP, un CRM, un ERP, Google Sheets o una base SQL.

El agente debería consultar una tool estándar:

```txt
search_business_data(query, context, filters)
```

Y el Data Gateway debería encargarse de:

- identificar la entidad relevante
- interpretar filtros
- aplicar reglas de negocio
- combinar SQL + búsqueda vectorial
- respetar permisos
- devolver resultados confiables
- explicar qué fuentes y reglas utilizó

---

## 4. principio central

El principio central del sistema es:

> Cualquier fuente puede conectarse; solo fuentes mapeadas y validadas pueden alimentar agentes en producción.

Esto evita la promesa falsa de:

```txt
conecta cualquier base y la IA la entiende sola
```

Y la reemplaza por una promesa más robusta:

```txt
conecta cualquier fuente
↓
el sistema la analiza
↓
propone entidades, campos y reglas
↓
se valida semánticamente
↓
queda consultable por agentes
```

---

## 5. definición del producto

Tsuzuro Data Gateway es un servicio que convierte datos de negocio en contexto consultable por agentes.

No es solamente:

- un RAG
- una base vectorial
- un text-to-SQL
- un conector de datos
- un chatbot
- un dashboard

Es una combinación de:

```txt
data ingestion
+ semantic mapping
+ hybrid retrieval
+ business rules
+ permissions
+ evaluation
+ agent-ready API
```

Una definición corta:

> Tsuzuro Data Gateway convierte bases, inventarios y catálogos en herramientas seguras y consultables por agentes de IA.

---

## 6. casos de uso iniciales

### 6.1 e-commerce / Shopify

Un agente de WhatsApp puede responder preguntas como:

```txt
¿tienes tenis negros para correr en talla 27 y menos de $1,800?
```

El Gateway debe buscar productos reales, aplicar filtros de precio, talla, stock y disponibilidad, y devolver opciones existentes.

### 6.2 telas / decoración

Un cliente no pregunta por SKU. Pregunta por intención:

```txt
¿qué tela le quedaría bien a mi sillón?
¿qué tela puedo poner en esta pared blanca?
quiero algo elegante pero fácil de limpiar
```

Whaapy interpreta imagen, intención y contexto. El Data Gateway busca productos reales usando atributos como:

- color
- textura
- uso recomendado
- estilo
- resistencia
- facilidad de limpieza
- compatibilidad decorativa
- disponibilidad
- precio

### 6.3 inmobiliaria

Un agente puede responder:

```txt
busco oficina en Polanco, menos de 80 mil pesos, más de 120 m2 y con estacionamiento
```

El Gateway combina filtros estructurados con búsqueda semántica sobre descripciones.

### 6.4 soporte técnico

Un agente puede consultar:

```txt
¿este problema aplica para garantía?
¿qué procedimiento sigue para este equipo?
¿qué casos similares existen?
```

El Gateway consulta tickets, políticas, documentos y bases internas.

### 6.5 CRM / leads

Un agente puede consultar:

```txt
¿este lead ya fue contactado?
¿qué clientes están pendientes?
¿qué oportunidades tienen mayor prioridad?
```

---

## 7. arquitectura conceptual

### 7.1 fuentes externas

Fuentes posibles:

- Shopify
- SAP
- CRMs
- ERPs
- Postgres externo
- MySQL
- Supabase
- Google Sheets
- CSV / XLSX
- APIs REST
- documentos
- catálogos
- PDFs
- bases internas del cliente

### 7.2 capa de conectores

Responsable de extraer y sincronizar datos.

Tipos de sync:

```txt
full sync
incremental sync
webhook sync
manual sync
scheduled sync
```

Ejemplo Shopify:

```txt
primer sync → trae productos, variantes, inventario y colecciones
webhooks → actualizan productos modificados
fallback → sync programado cada cierto tiempo
```

### 7.3 raw storage

Debe guardarse una copia cruda de los datos originales.

Razones:

- auditoría
- reprocesamiento
- debugging
- trazabilidad
- comparación con fuente original
- reconstrucción de índices

Ejemplo:

```json
{
  "source": "shopify",
  "source_record_id": "gid://shopify/Product/123",
  "raw_payload": {},
  "synced_at": "2026-06-09T18:00:00Z"
}
```

### 7.4 canonical layer

Cuando sea posible, los datos deben normalizarse hacia entidades comunes.

Ejemplos de entidades:

```txt
product
variant
inventory_item
collection
order
customer
lead
property
ticket
document
appointment
invoice
```

Ejemplo Shopify:

```txt
Shopify Product → product
Shopify Variant → variant
Shopify InventoryLevel → inventory_item
```

Ejemplo CRM:

```txt
CRM Contact → customer / lead
CRM Deal → opportunity
CRM Activity → interaction
```

### 7.5 semantic mapping layer

Esta capa define qué significan realmente los datos.

Incluye:

- entidades
- tablas
- columnas
- campos visibles
- campos buscables
- campos filtrables
- reglas de negocio
- términos del dominio
- permisos
- defaults
- reglas de disponibilidad
- relaciones entre entidades

Ejemplo:

```yaml
workspace_id: tienda_001

entities:
  product:
    table: products
    primary_key: id
    description: "Productos vendibles al cliente final"

    fields:
      name:
        column: title
        searchable: true
        visible: true

      description:
        column: description
        searchable: true
        visible: true

      price:
        column: price
        filterable: true
        visible: true

      stock:
        column: stock
        filterable: true
        visible: true

      cost:
        column: internal_cost
        visible: false
        sensitive: true

rules:
  available_product:
    expression: "status = 'active' AND stock > 0"

default_filters:
  - available_product
```

### 7.6 indexing layer

Responsable de preparar los datos para búsqueda.

Debe manejar:

- índices SQL
- embeddings
- índices vectoriales
- metadata
- campos de ranking
- timestamps
- estado de indexación

Campos típicos para embeddings:

```txt
name
description
tags
category
attributes
use_cases
technical_specs
```

Campos típicos para filtros SQL:

```txt
price
stock
status
size
color
category
created_at
updated_at
location
availability
```

Regla:

> Los campos de texto enriquecen la búsqueda semántica; los campos exactos deben filtrarse de forma determinística.

### 7.7 query engine

El Query Engine recibe una consulta y decide cómo resolverla.

Tipos de consulta:

```txt
structured
semantic
hybrid
recommendation
comparison
availability
clarification_needed
out_of_scope
```

Ejemplos:

```txt
¿cuántos productos están agotados?
→ structured / SQL

quiero algo elegante para una cena
→ semantic

quiero algo elegante, menos de 1500 y en talla M
→ hybrid

qué tela queda bien con una pared blanca y sillón gris
→ recommendation + semantic + rules
```

### 7.8 agent tool API

Los agentes consumen el Gateway mediante una API estándar.

Endpoint base:

```http
POST /query
```

Ejemplo de request:

```json
{
  "workspace_id": "cliente_001",
  "domain": "ecommerce",
  "entity": "product",
  "task": "recommend",
  "query": "busco algo elegante para una cena, menos de 1500",
  "context": {
    "channel": "whatsapp",
    "user_type": "customer"
  },
  "filters": {
    "available": true
  },
  "limit": 5
}
```

Ejemplo de response:

```json
{
  "answer": "Encontré 4 opciones compatibles.",
  "results": [],
  "applied_filters": {},
  "reasoning_summary": "Se priorizaron productos disponibles, dentro del presupuesto y con alta similitud semántica.",
  "confidence": 0.86,
  "source_status": "validated",
  "warnings": [],
  "sources_used": ["products", "product_embeddings"]
}
```

---

## 8. relación con Whaapy

Whaapy debe encargarse de:

- entender la conversación
- interpretar imágenes
- mantener contexto
- hacer preguntas de aclaración
- decidir cuándo consultar una tool
- redactar respuestas humanas
- manejar el flujo comercial

Tsuzuro Data Gateway debe encargarse de:

- consultar productos reales
- aplicar filtros
- aplicar reglas de negocio
- rankear resultados
- devolver evidencia
- respetar permisos
- evitar invenciones

Flujo ideal:

```txt
cliente
↓
Whaapy entiende conversación + imagen
↓
Whaapy genera query estructurada
↓
Data Gateway busca y filtra datos reales
↓
Data Gateway devuelve candidatos
↓
Whaapy redacta respuesta final
```

Regla importante:

> Whaapy no debe bajar toda la información. Whaapy debe pedir al Gateway la búsqueda exacta que necesita.

---

## 9. ejemplo: agente para tienda de telas

### 9.1 escenario

Cliente manda una foto de una pared blanca y pregunta:

```txt
¿qué tela podría poner en esta pared?
```

Whaapy interpreta:

```json
{
  "room_context": "sala",
  "wall_color": "blanco",
  "intent": "fabric_recommendation",
  "style_detected": "minimalista",
  "image_context": "pared blanca con decoración neutra"
}
```

Whaapy puede preguntar:

```txt
¿la quieres para cortinas, cojines, tapizar un sillón o decoración?
```

Cliente responde:

```txt
para cojines, pero quiero algo que no se ensucie tan fácil
```

Whaapy llama al Gateway:

```json
{
  "workspace_id": "telas_001",
  "domain": "fabrics",
  "entity": "fabric",
  "task": "recommend",
  "semantic_query": "telas para cojines que combinen con pared blanca, estilo minimalista, fácil limpieza",
  "context": {
    "room": "sala",
    "wall_color": "blanco",
    "desired_use": "cojines",
    "customer_need": "fácil limpieza",
    "style": "minimalista"
  },
  "filters": {
    "available": true,
    "use_case": "cojines"
  },
  "limit": 5
}
```

Gateway responde:

```json
{
  "results": [
    {
      "sku": "TELA-042",
      "name": "Chenille Arena Premium",
      "color": "arena",
      "color_family": "neutros cálidos",
      "use_case": ["cojines", "tapicería"],
      "properties": ["resistente", "suave", "fácil limpieza"],
      "price": 280,
      "stock": 34,
      "reason": "Combina con pared blanca sin endurecer el espacio y mantiene una estética cálida."
    }
  ],
  "confidence": 0.88,
  "sources_used": ["fabrics", "fabric_embeddings"],
  "warnings": []
}
```

Whaapy redacta:

```txt
te recomendaría empezar con tonos arena o beige cálido. combinan bien con una pared blanca, no se ven fríos y funcionan muy bien en cojines.

la opción más segura sería Chenille Arena Premium porque es resistente, suave y fácil de limpiar.
```

---

## 10. domain packs

Un domain pack es una plantilla especializada por tipo de negocio.

Incluye:

- entidades esperadas
- campos comunes
- reglas de negocio típicas
- vocabulario del dominio
- atributos semánticos
- reglas de ranking
- prompts de parsing
- tests/evals
- formatos de respuesta
- preguntas de aclaración

### 10.1 ecommerce pack

Entidades:

```txt
product
variant
inventory
collection
order
customer
```

Query types:

```txt
search
recommend
compare
check_availability
```

Reglas típicas:

```txt
available = status active + stock > 0
do not show internal cost
prefer in-stock products
respect price constraints
```

### 10.2 Shopify pack

Incluye mapeo específico de Shopify:

```txt
Shopify Product → product
Shopify Variant → variant
InventoryLevel → inventory
Collection → collection
```

Campos:

```txt
title
body_html
vendor
product_type
tags
status
variants.price
variants.inventory_quantity
images
handle
```

### 10.3 fabrics pack

Extiende ecommerce.

Atributos:

```txt
color
color_family
texture
recommended_uses
style
durability
easy_clean
pet_friendly
interior_exterior
maintenance_level
visual_feel
room_fit
```

Reglas:

```yaml
for_pets:
  prefer:
    - easy_clean = true
    - durability >= 4

for_white_wall:
  prefer_color_families:
    - warm_neutrals
    - earth_tones
    - muted_green
    - deep_blue

for_small_room:
  avoid:
    - dark_heavy_patterns
```

### 10.4 real estate pack

Entidades:

```txt
property
location
amenity
availability
lead_requirement
```

Campos:

```txt
price
m2
location
property_type
parking
rooms
description
status
url
```

Query types:

```txt
search
match_requirement
compare
check_availability
```

---

## 11. estados de madurez de una fuente

Cada fuente debe pasar por estados claros:

```txt
connected
↓
profiled
↓
indexed
↓
mapped
↓
validated
↓
agent-ready
```

### connected

La conexión existe. No significa que pueda ser usada por agentes.

### profiled

El sistema leyó:

- tablas
- columnas
- tipos
- relaciones
- ejemplos
- cardinalidad
- nulos
- valores frecuentes

### indexed

La fuente ya puede buscarse de forma básica. Sirve para exploración, no necesariamente para producción.

### mapped

El sistema sabe qué columnas corresponden a qué entidades y campos.

### validated

Un humano/admin aprobó reglas, permisos y significado.

### agent-ready

La fuente ya puede alimentar respuestas de agentes.

Regla:

> indexed no significa agent-ready.

---

## 12. onboarding de una fuente externa

### paso 1: conectar fuente

Ejemplo:

```txt
Shopify OAuth
Postgres connection string
Google Sheet URL
CSV upload
```

### paso 2: profiling

El sistema analiza estructura y datos.

Debe detectar:

- posibles entidades
- columnas sensibles
- columnas útiles para búsqueda
- columnas útiles para filtros
- relaciones
- inconsistencias
- campos duplicados
- datos obsoletos

### paso 3: mapping assistant

La IA propone mapeos:

```txt
product_name parece ser product.name
available_qty parece ser product.stock
sale_price parece ser product.price
internal_cost parece sensible
```

### paso 4: validación humana

El admin confirma:

- entidades
- campos
- reglas
- visibilidad
- permisos

### paso 5: indexación

El sistema genera:

- SQL indexes
- embeddings
- metadata
- índices por entidad

### paso 6: evals

Se prueban preguntas reales antes de activar.

### paso 7: agent-ready

La fuente queda disponible para agentes.

---

## 13. seguridad y permisos

Desde el inicio, cada campo debe tener flags:

```txt
searchable
filterable
visible
sensitive
internal_only
```

Ejemplo:

```yaml
fields:
  price:
    visible: true
    filterable: true

  cost:
    visible: false
    sensitive: true

  customer_email:
    visible: false
    sensitive: true

  stock:
    visible: true
    filterable: true
```

Principios:

1. no todo lo indexado debe ser visible.
2. no todo lo visible debe ser filtrable.
3. no toda fuente conectada está lista para agentes.
4. el LLM no debe generar SQL libre.
5. toda respuesta debe poder auditarse.
6. cada workspace debe estar aislado.

---

## 14. no SQL libre

El LLM no debe generar consultas SQL arbitrarias contra bases productivas.

En vez de eso, debe generar una representación estructurada:

```json
{
  "intent": "search_products",
  "semantic_query": "tenis negros para correr",
  "filters": {
    "price_lte": 1800,
    "size": "27",
    "available": true
  }
}
```

El backend genera la query segura.

Esto reduce:

- riesgo de SQL injection
- consultas pesadas
- exposición de columnas
- errores de joins
- alucinaciones de schema
- comportamiento impredecible

---

## 15. búsqueda híbrida

El sistema debe combinar:

### SQL / filtros estructurados

Para datos exactos:

```txt
precio
stock
fecha
status
ubicación
talla
color
disponibilidad
```

### vector search

Para intención, similitud y lenguaje natural:

```txt
algo elegante
algo para sala minimalista
algo parecido al lino
producto resistente para mascotas
oficina moderna bien ubicada
```

### reglas de negocio

Para restricciones y criterio experto:

```txt
disponible = activo + stock > 0
para mascotas = fácil limpieza + alta resistencia
cliente moroso = facturas vencidas > 30 días
```

---

## 16. query router

El sistema debe clasificar consultas.

Tipos:

```txt
structured_query
semantic_search
hybrid_search
recommendation
comparison
availability_check
clarification_needed
out_of_scope
```

Ejemplos:

```txt
¿cuántos productos están sin stock?
→ structured_query

quiero algo elegante para una cena
→ semantic_search

quiero algo elegante para una cena, menos de $1,500 y talla M
→ hybrid_search

qué tela queda bien con un sillón gris y una pared blanca
→ recommendation

tienes este producto en talla 27
→ availability_check
```

---

## 17. evaluación

Cada workspace debe tener evals.

Ejemplo:

```json
[
  {
    "query": "busco tenis negros para correr",
    "expected_result_ids": ["prod_123", "prod_456"],
    "must_apply_filters": {
      "category": "running",
      "color": "negro",
      "stock": ">0"
    }
  }
]
```

Métricas:

```txt
aplicó filtros correctos
devolvió resultados relevantes
no inventó datos
no mostró campos sensibles
respetó disponibilidad
pidió aclaración cuando debía
usó fuentes correctas
```

Antes de activar una fuente como agent-ready, debe pasar un set mínimo de pruebas.

---

## 18. logs

Cada consulta debe guardar:

```txt
workspace_id
agent_id
source_id
query original
query estructurada
tipo de query
filtros aplicados
fuentes usadas
resultados devueltos
confidence
warnings
errores
latencia
timestamp
```

Esto permite:

- debugging
- auditoría
- mejora continua
- análisis de fallos
- optimización de prompts/reglas
- monitoreo de calidad

---

## 19. modos de producto

### 19.1 managed mode

Ustedes hacen el setup.

Ideal para primeras ventas.

Flujo:

```txt
cliente conecta fuente
ustedes revisan mapping
ustedes validan reglas
ustedes corren evals
ustedes activan para agentes
```

Ventajas:

- mayor calidad
- menor riesgo
- más control
- ideal para proyectos B2B

### 19.2 self-serve mode

El cliente conecta, el sistema propone, el cliente valida.

Flujo:

```txt
conecta Shopify
detectamos productos, variantes, stock y precios
confirma reglas
activa agente
```

Debe venir después. No empezar por self-serve completo.

---

## 20. MVP recomendado

### alcance inicial

Construir una versión interna robusta sobre Postgres normalizado.

No resolver todavía todos los conectores.

El MVP debe demostrar:

```txt
una base normalizada
↓
semantic config
↓
embeddings
↓
query router
↓
búsqueda híbrida
↓
respuesta estructurada
↓
logs
↓
evals
```

### fuentes iniciales

```txt
Postgres propio
Shopify
Google Sheets / CSV
```

### domain packs iniciales

```txt
ecommerce
shopify
fabrics
real estate
```

### query types iniciales

```txt
search
recommend
compare
check_availability
```

### fuera de alcance inicial

```txt
BI complejo
analytics avanzados
SQL libre
acciones de escritura
automatizaciones financieras sensibles
self-serve universal
soporte para cualquier ERP sin mapping
```

---

## 21. roadmap

### fase 1: core interno

Objetivo:

```txt
todos los proyectos internos usan el mismo Query Engine
```

Entregables:

- workspaces
- sources
- semantic config
- indexer
- query endpoint
- logs básicos
- evals básicos

### fase 2: Shopify pack

Objetivo:

```txt
Shopify → productos consultables por agentes
```

Entregables:

- conector Shopify
- productos
- variantes
- inventario
- colecciones
- reglas default
- embeddings
- búsqueda por producto
- disponibilidad

### fase 3: fabrics pack

Objetivo:

```txt
recomendación experta de telas por contexto visual/intención
```

Entregables:

- atributos semánticos
- enriquecimiento IA
- reglas decorativas
- criterios de uso
- recomendaciones explicables

### fase 4: real estate pack

Objetivo:

```txt
inventario inmobiliario consultable por agentes
```

Entregables:

- propiedades
- filtros estructurados
- búsqueda semántica en descripciones
- matching contra requerimientos del lead

### fase 5: external DB beta

Objetivo:

```txt
conecta tu Postgres → proponemos entidades → validas → activas
```

Entregables:

- schema profiler
- mapping assistant
- permisos por campo
- validación humana
- estado agent-ready

### fase 6: self-serve limitado

Objetivo:

```txt
clientes pueden activar fuentes conocidas sin intervención fuerte
```

Fuentes soportadas:

- Shopify
- Google Sheets inventario
- Postgres simple
- CSV estructurado

---

## 22. modelo de datos inicial

Tablas sugeridas:

```txt
workspaces
sources
source_connections
source_records_raw
entities
entity_fields
semantic_mappings
business_rules
records
record_embeddings
query_logs
eval_sets
eval_cases
eval_runs
permissions
domain_packs
```

### workspaces

Representa cliente/proyecto.

### sources

Representa una fuente conectada.

### source_records_raw

Guarda payloads originales.

### entities

Representa entidades consultables.

Ejemplo:

```txt
product
fabric
property
lead
ticket
```

### entity_fields

Define campos visibles, buscables y filtrables.

### semantic_mappings

Mapea columnas reales a campos canónicos.

### business_rules

Define reglas como disponibilidad, elegibilidad o prioridad.

### records

Guarda entidades normalizadas.

### record_embeddings

Guarda embeddings por record o por chunk.

### query_logs

Audita cada consulta.

### evals

Mide calidad.

---

## 23. API inicial

### crear workspace

```http
POST /workspaces
```

### crear fuente

```http
POST /sources
```

### correr sync

```http
POST /sources/:id/sync
```

### obtener perfil de schema

```http
GET /sources/:id/profile
```

### guardar mapping

```http
POST /sources/:id/mapping
```

### indexar

```http
POST /sources/:id/index
```

### consultar

```http
POST /query
```

### ver logs

```http
GET /query-logs
```

### correr evals

```http
POST /evals/run
```

---

## 24. contrato de consulta

Request:

```json
{
  "workspace_id": "cliente_001",
  "domain": "ecommerce",
  "entity": "product",
  "task": "recommend",
  "query": "busco algo elegante para una cena, menos de 1500",
  "context": {
    "channel": "whatsapp",
    "customer_id": "wa_521444..."
  },
  "filters": {
    "available": true
  },
  "limit": 5
}
```

Response:

```json
{
  "answer": "Encontré 4 opciones compatibles.",
  "results": [
    {
      "id": "prod_123",
      "title": "Camisa Oxford Blanca",
      "price": 899,
      "stock": 12,
      "url": "https://...",
      "reason": "Tiene alta similitud con la intención de prenda elegante y está dentro del presupuesto."
    }
  ],
  "applied_filters": {
    "price_lte": 1500,
    "available": true
  },
  "query_type": "hybrid_search",
  "confidence": 0.86,
  "sources_used": ["products", "product_embeddings"],
  "warnings": []
}
```

---

## 25. decisiones técnicas iniciales

### base de datos

Usar Postgres.

Razones:

- ya es parte del stack
- soporta datos relacionales
- puede usar pgvector
- reduce complejidad inicial
- facilita filtros estructurados + vector search

### vector search

Empezar con pgvector.

Migrar a Pinecone/Qdrant/Weaviate solo si volumen o performance lo exige.

### LLM

Usar LLM para:

- interpretar intención
- extraer filtros
- generar query estructurada
- proponer mapeos
- enriquecer atributos
- redactar summaries internos

No usar LLM para:

- SQL libre
- decidir permisos finales
- activar fuentes sin validación
- mostrar campos sensibles
- modificar datos productivos

### workers

Usar workers para:

- sync
- indexación
- embeddings
- profiling
- evals

### queue

Usar Redis/BullMQ o equivalente.

---

## 26. antiobjetivos

El proyecto no debe intentar ser de inicio:

- un BI completo
- un reemplazo de data warehouse
- una solución mágica para cualquier ERP
- una herramienta que permite SQL libre
- un sistema sin validación humana
- un SaaS self-serve universal desde el día uno
- un chatbot
- una simple base vectorial

---

## 27. riesgos principales

### riesgo 1: prometer universalidad excesiva

Mitigación:

```txt
cualquier fuente se puede conectar, pero no toda fuente queda agent-ready sin mapping.
```

### riesgo 2: mala calidad de datos

Mitigación:

- profiling
- warnings
- validación
- raw storage
- sync logs
- evals

### riesgo 3: exposición de información sensible

Mitigación:

- permisos por campo
- visible/searchable/filterable/sensitive
- no SQL libre
- logs
- redacción controlada

### riesgo 4: recomendaciones incorrectas

Mitigación:

- reglas de negocio
- domain packs
- evals
- confidence
- warnings
- pedir aclaración

### riesgo 5: sobreconstrucción

Mitigación:

- empezar con Postgres normalizado
- 2 o 3 fuentes
- 2 o 3 domain packs
- no self-serve universal al inicio

---

## 28. principios de diseño

1. **Generic first, reliable after mapping.**
2. **Raw data is never agent-ready.**
3. **The agent converses; the Gateway retrieves.**
4. **No SQL libre.**
5. **Todo resultado debe ser auditable.**
6. **Motor común, semántica configurable.**
7. **Conectar no significa activar.**
8. **Los domain packs crean robustez.**
9. **Los evals convierten búsqueda en infraestructura.**
10. **Whaapy no debe bajar todo; debe pedir lo necesario.**

---

## 29. definición de éxito del MVP

El MVP es exitoso si:

1. al menos 2 proyectos internos usan el mismo Query Engine.
2. se reduce la lógica custom por proyecto.
3. el sistema puede consultar productos/inventario con filtros y búsqueda semántica.
4. las respuestas tienen fuentes, filtros aplicados y confidence.
5. existen logs por consulta.
6. existen evals básicos por workspace.
7. una fuente puede pasar por estados: connected → profiled → mapped → validated → agent-ready.
8. Whaapy puede consumir el Gateway como tool.

---

## 30. síntesis final

Tsuzuro Data Gateway debe construirse como una infraestructura común para agentes.

La apuesta no es construir el mejor text-to-SQL.

La apuesta es construir una capa que convierta datos de negocio en contexto seguro, semántico y accionable.

La fórmula:

```txt
core genérico
+ mapping semántico
+ domain packs
+ búsqueda híbrida
+ permisos
+ evals
+ API para agentes
```

Primera versión:

```txt
Postgres normalizado
+ pgvector
+ semantic config
+ query router
+ hybrid search
+ logs
+ evals
+ integración con Whaapy
```

Regla central:

> cualquier fuente puede conectarse; solo fuentes mapeadas y validadas pueden alimentar agentes.

Ese es el equilibrio correcto entre robustez y generalidad.