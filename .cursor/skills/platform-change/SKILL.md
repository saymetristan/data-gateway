---
name: platform-change
description: Execute platform changes with dry-run, confirmations, rollback notes and provider evidence.
---

# Platform Change
Provider, MCP, CI/CD, DNS, environment and deploy workflow.

## Use When
- User changes CI/CD, MCP, cloud providers, DNS, variables or deploy configuration.

## Required Inputs
- Provider, account/project and environment.
- Read/write/destructive scope.
- Rollback plan.
- Health-check for required provider/MCP.

## Outputs
- Versioned config or provider evidence.
- Sanitized MCP/config templates.
- Health-check result.
- Change record.

## Gates
- security
- testing
- pr-ci-main
- deploy
- production

## Stop Conditions
- No plan for platform mutation.
- Token scope is too broad.
- Production is touched without human gate.
- Destructive provider action lacks rollback and confirm.

## Closeout
- Report exact provider action.
- Report dry-run/confirm/human gate status.
- Report no secrets exposed.
- Report config templates updated.
- Report change record.
