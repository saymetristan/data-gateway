# Exclusión de productos N.R. de Tractodiesel en consultas para agentes

- Fecha: 2026-10-06 22:18, America/Mexico_City.
- Tipo: F. Rama local: `F/tractodiesel-nr-exclusion`, base `f474f03`.
- Objetivo: el workspace con slug `tractodiesel` no devuelve productos cuyo
  `item_name` cumple `/^\s*N\.R(?:\.|\s|$)/i`. No excluye `NR`, `N.RACING`
  ni una marca N.R. ubicada dentro del nombre.

## Implementación

El compilador de consultas incorpora una restricción SQL obligatoria, independiente
de los filtros del cliente, defaults del mapping, preferencias y relajación de
filtros inferidos. Se aplica a búsqueda lexical, ramas, SKU exacto, filtros y
candidatos vectoriales. La regla vectorial precede al límite del probe y vuelve
a aplicarse después del join; el resto de filtros conserva su posición anterior.
El probe de consultas de otros workspaces mantiene su conjunto de candidatos.

Las filas `inventory` se relacionan con `product` mediante workspace, source e
`item_code`: si el producto relacionado está excluido, no aparecen en búsqueda
ni en disponibilidad. El conjunto de SKU se obtiene sin correlación por fila para
permitir un subplan hash; un SKU ausente no se interpreta como producto excluido.
No cambia persistencia, sincronización, embeddings almacenados, mapping, esquema
ni contrato público. La expresión PostgreSQL incluye los espacios Unicode de JS.

## Validación local

- `pnpm install --frozen-lockfile` con pnpm 9.15.4; lockfile sin cambios.
- Sin `.agents/project-profile.json` ni scripts preflight específicos.
- `pnpm build` y `pnpm typecheck`: pasan en los cuatro paquetes. El primer
  typecheck necesitó construir `core` para resolver su export `dist` en apps.
- ESLint de `catalog-visibility.ts` y `retrieval.ts`: pasa.
- Suite de query y query-capabilities: 105 pruebas pasan, 21 se omiten por las
  condiciones de las fixtures existentes.
- Cuatro pruebas nuevas pasan, incluidas tres sobre PostgreSQL 17 temporal local
  UTF8. Verifican prefijos, espacios Unicode, tenants, entidades, sources, búsqueda
  lexical, SKU exacto, filtro estructurado, exclusión antes de límite, inventario,
  SKU ausente, relajación y preferencias. Comprueban que no se borran registros.
- SQL vectorial: prueba del compilador confirma la regla antes del límite del
  probe y en el resultado. No se ejecutó ANN real: el host carece de pgvector.

Para repetir la integración, usar un PostgreSQL local desechable y ejecutar:

```sh
NR_TEST_DATABASE_URL=postgresql://<usuario>@127.0.0.1:<puerto>/<db> pnpm exec vitest run packages/core/src/query/catalog-visibility.test.ts
```

La prueba no usa `DATABASE_URL`, rechaza hosts remotos y elimina su propio schema.

## Entrega y pendientes

Revisión independiente y segunda opinión Claude Code completadas. Una prueba del
schema valida la consulta por lote de Levantia con lista de SKU, normalizada a `in`.
Commit, PR y CI se coordinan por el principal; no hubo merge ni deploy. El candidato
de publicación separado conserva CSV bulk `5d7dcfc` y filtros numéricos `1356bf0`,
correcciones de la publicación manual anterior aún ausentes de main.
Pendientes ejecución ANN con pgvector y
verificación de la revisión desplegada, latencia y resultados reales bajo RLS.
La reversión consiste en retirar el predicado de consulta; no hay migración ni
reconstrucción del catálogo. No se hicieron acciones de producción.
