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

Tris autorizó integrar y publicar el 2026-10-06, después de revisar las PR #23 y
Levantia #138. El candidato se incorporó a la rama de #23 antes del merge, de modo
que el autodeploy de main conserve CSV bulk y filtros numéricos desde su primera
revisión. Se vuelve a ejecutar CI completo sobre esta combinación.

Pendientes
revisión/CI de entrega, pruebas CSV DB con esquema completo, ANN real con pgvector,
rendimiento/RLS y verificación del runtime que se publique. Destino Railway:
proyecto `be49c553-4d7d-445d-935e-f8a603e15c2d`, production
`57adb1ff-0cb9-4241-a282-e6a9efb5cd5a`, API
`f3dd7666-671c-4393-8de9-f8e1f4495c59` y worker
`3e28e97a-41e6-4d4b-a197-19a63093203c` por autodeploy.
El MCP `a6d59390-6ad9-45d1-91b9-e9c65168faf4` usa una publicación manual.
Rollback API: deployment `64beeb83-17bf-464a-9fec-f0db13182f16`;
worker: `f120ba80-ac20-4818-816c-f20e866fe7f7`;
MCP: `c3c8d78a-98eb-4bed-872c-ecf91dd6b28d`. Sin cambios de datos o variables.
