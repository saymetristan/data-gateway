# CSV upload request timeout

- Recorded: 2026-09-26T05:09:00-06:00
- Change type: I (production hotfix), explicitly authorized by Tris.
- Scope: API request timeout only; no database, permissions, worker, or infrastructure changes.

The QSS CSV upload returned HTTP 504 after 25 seconds while synchronous ingestion
continued. The observed upload completed after approximately 253 seconds. Give only
`POST /sources/:id/upload` a 540-second application timeout; every other method and
path retains 25 seconds. The response and ingestion contracts remain unchanged.

Railway's public edge documents a five-minute timeout without data transfer and up
to fifteen minutes when data continues transferring. Therefore this application
limit does not guarantee nine minutes through the edge, nor completion for every
100,000-row CSV. Timeouts still require reconciliation before any retry. QSS is
coordinating a 570-second client timeout within its existing 600-second job lease.
Source: https://docs.railway.com/networking/public-networking/specs-and-limits

## Validation

- Core build; API typecheck and build.
- API app ESLint.
- Seven isolated fake-timer tests through the actual application timeout middleware:
  successful 253-second upload, 540-second upper bound, and unchanged 25-second
  limits for other methods and neighboring paths. Auth, database, and source work
  are substituted locally; no production requests or integration database is used.
- No full test suite or CI run. Pull requests are optional under CHANGE_CONTROL.md.

## Delivery

- Branch: `fix/csv-upload-timeout`, based on `985ef43` (`origin/main`).
- Target: Railway project `be49c553-4d7d-445d-935e-f8a603e15c2d`, production,
  service `api` / `f3dd7666-671c-4393-8de9-f8e1f4495c59`, `https://data.whaapy.com`.
- Deploy and production verification are pending coordination by the principal
  agent. Worker and MCP services do not need this code change.
- Rollback: redeploy the prior API revision; preserve QSS's no-retry reconciliation
  behavior because a timeout does not prove that ingestion stopped.
