

# Tsuzuro Data Gateway Agent Portability

## Runtime Strategy


| Runtime | Mode   | Capabilities                        |
| ------- | ------ | ----------------------------------- |
| cursor  | native | rules, skills, commands, mcp, hooks |
| codex   | bridge | rules, skills, mcp                  |


## Degradation Rule

- `native`: use runtime-specific rules, skills, hooks or MCP.
- `bridge`: render the same policy as markdown and instructions.
- `docs-only`: rely on docs, PRs, CI and doctor checks for enforcement.

## Rulepacks

- No extra rulepacks declared.