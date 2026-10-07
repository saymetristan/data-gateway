# Evitar filtros por fragmentos numéricos de modelos

- Fecha: 2026-09-28T11:25:31-06:00 (America/Mexico_City).
- Clasificación: F; corrección local del extractor, sin cambios de contrato o DB.
- Base: `origin/main` en `f474f03`; rama `F/tractodiesel-query-filters`.

## Causa confirmada

El fixture de `menu3` usa etiqueta y filterLabel `menu3`, aliases vacíos,
cardinality `one` y el suggestedValue `DT408, DT466, DT530 NGD 93-99`.
El mapping por sí solo no produce filtros para `diafragma tipo 30`. La policy
activa v8 de la fuente `1653b6d2-277f-4353-8131-366b76560eca` añade `tipo` como
alias de `menu3`, con `implicitBehavior: search`. `prepareQuery` incorpora ese
alias al mapping antes de extraer; un hint explícito conserva comportamiento
`filter`, por lo que la policy de búsquedas implícitas no evita el filtro.

Con el alias efectivo se reproduce la frase exacta `diafragma tipo 30`: el hint
activa el fallback parcial, que usa `includes` y encuentra `30` dentro de `DT530`.
El span calculado después de normalizar el tail consume el hint y parte del
número, dejando `diafragma 0`. El fixture rojo reprodujo ese residual exacto,
que coincide con el log `707682cd-4486-499e-84db-5c262a0d9dd5` del 26 de septiembre:
filtro `eq` sobre el valor compuesto y cero resultados. La evidencia runtime
fue recuperada por el principal; esta porción no accedió a producción.

La corrección descarta coincidencias parciales que solo contienen números y
puntuación. No genera ningún match para esa frase, por lo que extracción y
resolución conservan íntegro `diafragma tipo 30`, incluidos ambos dígitos.
Se conservan el valor completo y los prefijos numéricos de medidas
procesados por la ruta existente (`ancho 100` → `100cm`, `ancho 1.50` → `1.50m`).
No se modifica la normalización de filtros estructurados, la relajación, tenancy,
SQL, defaults, presets ni el fallback LLM.

## Validación y entrega

- 50 pruebas focales correctas en 6 archivos: extracción, resolución, fallback LLM, relajación, relevancia y
  validación de filtros. Incluyen texto libre original, hint real con fragmentos
  `30`, `530`, `99`, el alias de policy v8 con la frase exacta, valor completo
  explícito/implícito y medidas.
- Build y typecheck del workspace: correctos. El primer typecheck en el worktree
  nuevo falló por faltar `dist` de core; el build seguido del typecheck lo resolvió.
- ESLint del archivo runtime y `git diff --check`: correctos.
- Integración PostgreSQL pendiente: Docker no está disponible y no hay respuesta
  local en puertos 5432/5433. No se usaron bases remotas ni datos de producción.
- Sin commit, push, PR, CI remota, integración o despliegue desde esta porción;
  el principal coordina la entrega y la comprobación runtime.

Riesgo residual: un número suelto con hint ya no selecciona un fragmento numérico
interior de un valor compuesto. Los valores completos siguen disponibles.
Queda pendiente la verificación runtime tras la entrega autorizada del principal;
el fixture confirma la causa y la corrección local, no el resultado desplegado.
