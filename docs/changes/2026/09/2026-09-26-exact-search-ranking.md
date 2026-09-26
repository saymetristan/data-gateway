# Preserve literal search matches through ranking

- Classification: I (operational retrieval defect) + DB (persistent read query change).
- Local implementation authorized; production deployment is not authorized by this task.
- Base: `988e6c4`, branch `fix/exact-search-ranking`.
- Observed defect: the frozen 100-case history corpus retrieved 94 expected identities.
  Two inspected missing identities have correct indexed text and current embeddings.

## Plan before implementation

1. Compare the complete input query with existing `search_source` inside the scoped
   lexical SELECT. Prefer identical text, then equality after case/accent/whitespace
   normalization. Preserve punctuation, word order, numbers, and additional words.
2. Carry this internal ranking signal before the lexical 50-candidate cut, the
   branch/final fusion cuts, and the final response limit. Preserve identifier
   priority, existing scores, relevance thresholds, filters, tenant/entity/source
   restrictions, and response shaping. A non-exact query keeps current behavior.
3. Verify the observed food-description cases, case-sensitive literal tie breaks,
   crowded candidate lists, non-exact searches, and parameterized/scoped SQL.
   Run focused tests, affected typechecks/builds, and lint on changed runtime files.

No API fields, mapping settings, schemas, indexes, migrations, providers, corpus
changes, or production writes are planned. Equality is an ORDER BY signal over
the existing FTS candidates; it does not add an OR predicate or bypass query
syntax and needs no reindex. Runtime read-query changes can affect latency and
ranking for other clients; local tests do not prove production recall or latency.
The final review must consider those risks before any deployment.

## Validation and delivery

2026-09-26 13:26 UTC: local patch ready for independent review. No commit, PR,
CI, merge, deploy, or production query/data change performed.

- 24 focused tests passed across `retrieval.branches.test.ts` (16),
  `retrieval.ann.test.ts` (1), `retrieval.fallback.test.ts` (3), and
  `relevance.test.ts` (4). The final branch-only run revalidated the SQL plan check.
- Real PostgreSQL 17 fixtures use existing `unaccent`, `pg_trgm`, and
  `es_unaccent`, without pgvector or application migrations. Enable with
  `EXACT_SEARCH_TEST_DATABASE_URL` pointing to a disposable local database;
  the tests create only a session-local records table. Remote hosts are rejected.
- Each of the six reported descriptions is tested with 60 stronger FTS variants.
  The former ordering excludes the literal before LIMIT 50; the new ordering
  keeps it first through lexical retrieval and top-five fusion. Case/accent/space
  normalization, original-case precedence, complete-query branch matching,
  unchanged non-exact ordering, exact identifier precedence, and unchanged RRF
  scores for identical input rankings are covered.
- SQL fixtures exclude exact matches from another workspace, source, entity,
  port, or catalog version. EXPLAIN with sequential scans disabled confirms the
  existing GIN predicate remains eligible for full-text queries. Short-query
  trigram predicates are unchanged; this check is not a production benchmark.
- Core and API `typecheck` and `build` passed. ESLint passed on both changed
  runtime files; test files are excluded by the existing lint configuration.
  `git diff --check` passed. Dependencies installed with the unchanged frozen
  lockfile; no node_modules symlink is used.

The final response comparator was reviewed with unchanged relevance pruning and
response shaping; the existing identifier priority remains first. Exact literal
priority can change the first result for other clients when the complete stored
search text matches. It does not broaden eligibility or boost score formulas.
Normalization adds per-candidate sorting work; production latency and the frozen
100-case recall remain to be measured only after an authorized deployment.
