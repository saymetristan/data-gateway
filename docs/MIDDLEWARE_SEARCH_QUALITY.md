# Middleware search quality (Bayon / Whaapy)

Primary relevance fixes live in the Data Gateway (multi-branch lexical retrieval,
synonym OR alternatives, calibrated confidence). Downstream middleware
(`vadai-ia/bayon-middleware`) should still treat MCP envelopes defensively.

## Do not treat HTTP 200 + non-empty results as success

The MCP envelope is authoritative:

| `status` | Meaning | Middleware action |
| --- | --- | --- |
| `success` | Calibrated confidence is acceptable | Present products |
| `needs_more_info` | Empty **or** weak matches (`confidence < 0.45`) | Ask for a distinctive term / SKU; optional retry |
| `failed` | Transport/auth/validation error | Retry if `retryable`, else transfer |

`data.results` may still be present under `needs_more_info` for inspection; do
not auto-offer those products as confirmed matches.

## Recommended retry for long conversational queries

When the first tool call returns `needs_more_info` and the user query is long
(> ~6 tokens) or contains commas / ` o `:

1. Extract distinctive product terms (capitalized tokens, known fabric names:
   `Aida`, `cuadrillé`, `etamina`, `canevá`, `loneta`, …).
2. Retry `search_variant` with the shortest distinctive term (e.g. `Aida`).
3. If the retry returns `success`, use that; else ask the customer or transfer.

Exact-term fallback belongs in middleware **in addition to** Gateway retrieval,
not instead of it.

## Signals available in tool data

- `confidence` — calibrated 0–1 (not absolute RRF score)
- `query_type` — `hybrid_search` | `lexical` | `filter_only`
- `warnings` — embedding timeout, preference fallback, etc.
- `applied_filters` / `applied_preferences`
