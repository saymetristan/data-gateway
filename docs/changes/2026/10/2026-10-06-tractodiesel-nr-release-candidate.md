# Candidato local de entrega N.R. preservando correcciones desplegadas

- Fecha: 2026-10-06 22:29, America/Mexico_City.
- Rama: `F/tractodiesel-nr-release-candidate`.
- Base: `origin/main` en `f474f03b7170f156edd51705809c53a1daf276e9`.
- Alcance: preparar localmente una revisión que preserve dos correcciones
  desplegadas manualmente y reciba la exclusión N.R. validada por separado.
  No autoriza PR, push, merge de main ni acciones de producción.

## Correcciones preservadas

| Corrección | Commit original | Commit en candidato |
| --- | --- | --- |
| CSV bulk ingestion | `5d7dcfc31eaf199a0bfbb3e1c1a676f78e9df70d` | `5f7c588` |
| Numeric filter fragments | `1356bf0f4978383222d877714722667a2876c3de` | `ab27132` |
| Exclusión N.R. para agentes | `4ba2f4a` | `5de9d4a` |

Los tres cherry-picks se aplicaron sin conflictos. `git range-diff` confirma igualdad
de los parches, incluyendo tests y registros originales; no se trasladaron otras
modificaciones de las ramas de origen. El checkout de la exclusión N.R. pertenece
al principal y no fue modificado por esta preparación.

## Validación local

- `pnpm install --frozen-lockfile`, pnpm 9.15.4: pasa, lockfile intacto.
- Pruebas `csv.test.ts`, `extract-filters.test.ts` y
  `extract-filters.resolve.test.ts`: 37 pasan, 3 de CSV DB se omiten.
- Build y typecheck de `@data-gateway/core`: pasan.
- ESLint de `csv.ts`, `raw-records.ts`, `extract-filters.ts`: pasa.
- `git diff --check`: pasa.

Después de incorporar N.R.:

- Suite de query, schema/query y CSV: 119 pruebas pasan; 27 se omiten por fixtures.
- Reejecución dedicada en PostgreSQL temporal local UTF8: 14 pruebas pasan
  (catálogo N.R., compilación ANN y nueve pruebas schema/query, incluida
  normalización del SKU exacto). Las tres pruebas N.R. de PostgreSQL omitidas
  en la suite general quedan verificadas por esta ejecución.
- Build y typecheck completos de los cuatro paquetes: pasan.
- ESLint de los cinco archivos de runtime afectados y schema/query: pasa.
- El PostgreSQL temporal propio se detuvo al terminar.

Las pruebas CSV de base de datos necesitan el esquema completo con pgvector,
ausente en PostgreSQL local. Su omisión no confirma ingesta real en este candidato.
La equivalencia con los commits originales es evidencia del contenido preservado,
no una verificación del runtime desplegado.

## Estado

El candidato combinado queda validado y conservado en commits locales. Pendientes
revisión/CI de entrega, pruebas CSV DB con esquema completo, ANN real con pgvector,
rendimiento/RLS y verificación del runtime que se publique. Sin publicación, PR,
CI, merge ni deploy desde esta rama.
