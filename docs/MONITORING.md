# Monitoreo en producción

## Health checks (UptimeRobot / Better Stack)

Crea dos monitores HTTP(s) con intervalo **5 min** y alerta por email:


| Nombre           | URL                                  | OK si                             |
| ---------------- | ------------------------------------ | --------------------------------- |
| data-gateway-api | `https://data.whaapy.com/health`     | HTTP 200 y JSON `db: "connected"` |
| data-gateway-mcp | `https://mcp.data.whaapy.com/health` | HTTP 200 y JSON `ok: true`        |


Configuración sugerida UptimeRobot:

- Monitor Type: HTTP(s)
- Interval: 5 minutes
- Alert contacts: tu email
- Keyword monitoring (opcional API): `connected`

## Railway

- Proyecto `data-gateway` → Settings → Notifications: activar **Deploy failed**
- Healthchecks configurados: `api` y `mcp` en `/health`
- `watchPatterns` por servicio para evitar redeploys cruzados

## Métricas operativas (manual)

```bash
curl -s https://data.whaapy.com/metrics \
  -H "Authorization: Bearer $ADMIN_API_KEY" | jq .
```

Incluye latencias p50/p95, colas pg-boss y errores de sync.

## Supabase Pro

- Backups diarios automáticos (plan Pro)
- Revisar retention en Dashboard → Database → Backups

## npm publish (requiere 2FA)

```bash
cd packages/mcp-server
pnpm build
npm publish --access public --otp=TU_CODIGO_2FA
```

Paquete: `@whaapy/data-gateway-mcp@0.1.0`