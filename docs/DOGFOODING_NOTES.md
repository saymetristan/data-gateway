# Dogfooding notes

Script manual: `pnpm dogfood`

Requiere:

- `GATEWAY_URL`
- `GATEWAY_API_KEY` con scopes `tools:read` y `tools:invoke`
- `OPENROUTER_API_KEY`
- Al menos una fuente `agent_ready` en el workspace

Dry-run local sin credenciales:

```bash
DOGFOOD_DRY_RUN=true pnpm dogfood
```

Las ejecuciones del script appendean observaciones debajo con timestamp.


## Run 2026-06-10T03:44:22.209Z

- Modo: dry-run determinístico
- OK: "¿Hay variantes rojas disponibles?" → search_variant
- OK: "Busca SKU que contenga SHOP-SKU-0001" → check_availability_variant
- OK: "¿Está disponible la variante con SKU SHOP-SKU-0001-1?" → check_availability_variant
