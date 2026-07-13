

# Tsuzuro Data Gateway Operating Model

## Project

- Repository: saymetristan/data-gateway
- Default branch: main
- Public docs language: Project default
- Code identifiers: English

## Boundaries

- No free-form SQL: LLM output is a structured representation only; the backend compiles parameterized queries.
- Fields flagged sensitive or visible:false never leave the Gateway in any response or exposed log.
- External client DB connections are read-only; credentials encrypted at rest.
- The query path must work without LLM; LLM is fallback for slot-filling only.
- Production DB operations go through the data-gateway-supabase MCP, never local CLI.
- Never commit .env, .cursor/mcp.json or client credentials.

## Stack

- Package manager: not declared
- Languages: TypeScript
- Frameworks: Hono, Drizzle, pg-boss, Vitest

## Change Types


| Type | Meaning                                                        | Plan | Protected |
| ---- | -------------------------------------------------------------- | ---- | --------- |
| D    | Docs-only change without runtime behaviour.                    | no   | no        |
| F    | Normal app feature or fix.                                     | no   | no        |
| P    | API, SDK, CLI, event or public contract change.                | yes  | no        |
| DB   | Schema, migration, index, backfill or persistent query change. | yes  | no        |
| S    | Auth, tenancy, secrets, permissions or sensitive controls.     | yes  | yes       |
| I    | Production incident, rollback or hotfix.                       | no   | yes       |
| Plat | CI/CD, deploy, provider, MCP, DNS or environment change.       | yes  | yes       |


## Core Rule

Local IDE rules help, but shared enforcement happens through PRs, CI, change records, provider policy and generated docs.