<!-- Generated from .agent/operating-model.yaml. Edit source config instead. -->

# Tsuzuro Data Gateway Agent Instructions

## Read First
- `docs/engineering/OPERATING_MODEL.md`
- `docs/engineering/WORKFLOW_CATALOG.md`
- `docs/engineering/CHANGE_CONTROL.md`
- `docs/engineering/CODEX_OPERATING_MODEL.md`

## Operating Rules
- Classify every change before editing.
- Use the matching workflow and gates.
- Stop on ambiguous product boundary, public contract, database, security, platform or production scope.
- Never read, print, summarize or commit secrets.
- Do not edit generated files directly; edit `.agent/operating-model.yaml` and regenerate.
- Close with checks, branch/PR/CI state, docs/change-record status, deploy status when applicable and residual risks.

## Project Boundary
- No free-form SQL: LLM output is a structured representation only; the backend compiles parameterized queries.
- Fields flagged sensitive or visible:false never leave the Gateway in any response or exposed log.
- External client DB connections are read-only; credentials encrypted at rest.
- The query path must work without LLM; LLM is fallback for slot-filling only.
- Production DB operations go through the data-gateway-supabase MCP, never local CLI.
- Never commit .env, .cursor/mcp.json or client credentials.

## Enabled Runtimes
- cursor: native
- codex: bridge
