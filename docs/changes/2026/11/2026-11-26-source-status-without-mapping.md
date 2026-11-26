# Restaurar el estado de fuentes sin mapping activo

El 26 de noviembre de 2026 se corrigió una regresión de onboarding. `GET /sources/:id/status` devolvía HTTP 409 antes de que existiera un mapping activo, aunque el estado de la fuente ya se podía consultar.

Una llave con `sources:read` vuelve a recibir HTTP 200 para su fuente, con el estado de madurez, los conteos de registros y `counts.embeddings: 0` cuando falta un mapping activo. Con mapping, el conteo conserva los filtros por fuente, versión activa y modelo. Las rutas de indexación y consulta conservan la validación de mapping.

La entrega autorizada es por GitHub a `main`, con despliegue automático a Railway. No hay migraciones. Ante una regresión se puede revertir el commit de este cambio y verificar la nueva revisión desplegada.
