# Robust client filters and query capabilities

- Change type: P (public query contract)
- Related: retrieval policies, tool compiler, profiling

## Summary

- `POST /query` accepts filter-only and preference-only requests (`query` optional when criteria exist).
- Client-supplied structured filters/preferences are validated strictly (HTTP 422) instead of being ignored with warnings.
- Added `GET /query/capabilities` to discover safe filter fields, operators, and suggested values.
- Profile now extracts atomic members for JSON array columns (e.g. collections).
- Retrieval policies may declare per-field aliases/behaviors and query-time RRF overrides.
- Tools gain `suggest_filter_values_<entity>` for canonical value discovery.
- Mintlify includes client configuration and REST contract guides for capabilities, filters, preferences, multivalue operators, and 422 errors.

## Compatibility

- Legacy `{ "field": value }` filters remain accepted.
- Existing free-text queries remain valid.
- Invalid structured filters that previously degraded with warnings now return 422.

## Verification

- Unit tests for query schema, filter validation, capabilities helpers, retrieval policy fields.
- Integration coverage for filter-only queries and 422 on unsafe fields.
- Shopify eval fixtures aligned to `contains` / preference semantics for collections.
- Mintlify broken-link check passed; OpenAPI 3.1 contract validated successfully.
- Production deploy: merged PR #6 to `main` (`7c03016`); Railway `api`/`worker` SUCCESS; `GET https://data.whaapy.com/health` → 200 `{"status":"ok","db":"connected"}`. No new DB migrations.
