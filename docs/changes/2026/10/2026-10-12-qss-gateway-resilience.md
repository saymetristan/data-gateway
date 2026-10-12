# Recuperación del proveedor y piloto de concurrencia QSS

Fecha: 2026-10-12 11:29, America/Mexico_City. Tipo: F/P con metadatos aditivos; la activación de configuración es Plat y requiere gate humano de producción.

## Objetivo y evidencia

Permitir validar búsquedas simultáneas de QSS conservando filtros, calidad y presupuestos actuales. El Gateway ya admite concurrencia; los rechazos no demuestran una cola serial. La corrida histórica revisada contiene 20 timeouts de embedding y 13 rechazos por circuito abierto. Las sondas actuales también reprodujeron degradación lexical al agotar 4 segundos; HTTP 200 por sí solo no demuestra una búsqueda aceptable para QSS.

Sondas directas con el mismo modelo Qwen/1024 desde el equipo local mostraron menor latencia en DeepInfra que en Nebius en la muestra inicial. Una muestra posterior con cuatro llamadas y preferencia DeepInfra completó en 1.617–2.381 segundos. No es una medición desde Railway ni prueba de capacidad sostenida. Los vectores de ambos proveedores fueron cercanos, pero no idénticos: requiere validar resultados, no sólo dimensiones. No se modificó el modelo ni se reindexó.

Se reprodujeron dos defectos locales: múltiples solicitudes admitidas durante half-open y Retry-After de 10 segundos truncado a menos de 500 ms. Son independientes de la disponibilidad intermitente del proveedor.

## Cambio y límites

- Circuito: una sola prueba de recuperación en vuelo, con token por intento para ignorar finalizaciones de generaciones anteriores.
- Reintentos: respetar Retry-After completo; si no cabe en el presupuesto, devolver fallo del proveedor sin llamar anticipadamente ni alargar el timeout.
- Separar circuitos por endpoint, credencial, ruta y configuración mediante huella no expuesta. No separar artificialmente por tenant cuando comparte el mismo fallo upstream.
- API: `EMBEDDING_PROVIDER_ORDER_BY_WORKSPACE` acepta un objeto JSON de UUID de workspace a lista ordenada de proveedores. Ausente conserva `sort:latency`; presente usa `order` con fallbacks permitidos. Se selecciona con el workspace autenticado en `/query` y `/tools/:name/invoke`, nunca con parámetros del cliente. El worker conserva su ruta habitual.
- El piloto propuesto configura únicamente QSS con `deepinfra`, luego `nebius`. No hay cambio de filtros, límites de tasa, timeout, confianza ni aceptación de resultados lexicales.

## Contrato de observabilidad

`GET /query-logs` conserva su contrato y aislamiento. En `metadata` se agregan opcionalmente `providerRouting` (`latency` u `ordered`), `effectiveProvider`, `providerRequestId` y `providerRequestShared`. `providerAttempts` y `circuitState` ahora también se conservan en éxito. Los identificadores sólo se incluyen si el upstream los devuelve y superan la validación; no se almacenan cuerpos de error ni credenciales.

En cargas compartidas, `providerRequestShared: true` indica que otra consulta inició la llamada, tanto en éxito como en fallo o timeout: los intentos describen la misma operación y no deben sumarse como llamadas nuevas. Los hits L1/L2 no heredan proveedor ni identificador histórico; `providerMs` es cero. La ausencia de identificador en un timeout no permite inferir proveedor efectivo. Los metadatos de procedencia no se persisten en el cache de vectores.

El cache existente permanece por workspace/modelo/dimensiones/texto y puede reutilizar vectores previos al cambio de ruta. Por eso el piloto debe incluir consultas nuevas, sin borrar caches de producción.

## Validación y entrega

Pruebas enfocadas: recuperación exclusiva, finalizaciones tardías, Retry-After en segundos/fecha, enrutamiento opt-in, metadatos, deduplicación y ausencia de atribución falsa en cache. Preflight: build, tipos, lint y suite local; integración PostgreSQL en CI aislado. Docker no está activo localmente, por lo que las pruebas que requieren PostgreSQL no se consideran ejecutadas localmente.

Preflight final: `pnpm build`, `pnpm typecheck`, `pnpm lint` y `git diff --check` verdes; suite local 266 aprobadas y 81 omitidas por requerir PostgreSQL. Revisión independiente y cruzada con Claude completadas: corregidos timeout al leer cuerpo, atribución compartida en fallos y variable de ruta vacía; sin hallazgos accionables pendientes. No se añadió caducidad artificial al lease de recuperación: las llamadas productivas ya terminan por su timeout; liberar otro probe antes podría duplicarlas.

Estado: rama `codex/qss-gateway-resilience`; pendiente CI y registrar PR. Sin merge ni despliegue de este cambio. No se modificó el checkout QSS ni su paralelismo.

## Piloto de producción y reversión

Tras gate de producción: desplegar revisión aprobada; verificar revisión exacta y readiness. Configurar sólo el workspace QSS en la API. Comparar consultas conocidas y nuevas en serie, luego dos y cuatro simultáneas, correlacionando registros y ejecutando el validador real de QSS. Verificar puerto, versión de catálogo, fuente, ranking y ausencia de warnings rechazados; medir el lote completo, no sólo HTTP o cache caliente. Detener el piloto ante degradación recurrente, circuito abierto, 429, saturación de pool o regresión comercial. Considerar concurrencia total de todos los workers QSS antes de habilitar cuatro búsquedas por documento.

Reversión de ruta: quitar la entrada QSS del mapa y redesplegar API; no requiere migración ni reindexación. Reversión de código: restaurar la revisión anterior `ceb3805cdaa03cdf26d92c7d2083babad50b4202` si hay regresión. Conservar registros del piloto. El cambio no garantiza que un proveedor externo nunca falle.
