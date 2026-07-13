

# Tsuzuro Data Gateway Workflow Catalog

## Feature Cycle

Normal implementation workflow for features and fixes.

### Use When

- User asks to implement a feature, bug fix or API-adjacent change.

### Required Inputs

- Goal and observable done condition.
- Change type and affected domain.
- Public contract reference when type is P.

### Outputs

- Cohesive implementation.
- Focused tests.
- Updated contracts/docs when needed.
- PR/CI/change-record evidence.

### Gates

- product-boundary
- api-contract
- testing
- pr-ci-main
- deploy

### Stop Conditions

- Public API lacks contract.
- Product boundary is unclear.
- Security, database or platform scope appears without routing to dedicated workflow.
- Production promotion is requested.

### Closeout

- Report change type and gates.
- Report checks run.
- Report branch, PR, CI and merge state.
- Report deploy verify if runtime changed.
- Report change record status.

## Platform Change

Provider, MCP, CI/CD, DNS, environment and deploy workflow.

### Use When

- User changes CI/CD, MCP, cloud providers, DNS, variables or deploy configuration.

### Required Inputs

- Provider, account/project and environment.
- Read/write/destructive scope.
- Rollback plan.
- Health-check for required provider/MCP.

### Outputs

- Versioned config or provider evidence.
- Sanitized MCP/config templates.
- Health-check result.
- Change record.

### Gates

- security
- testing
- pr-ci-main
- deploy
- production

### Stop Conditions

- No plan for platform mutation.
- Token scope is too broad.
- Production is touched without human gate.
- Destructive provider action lacks rollback and confirm.

### Closeout

- Report exact provider action.
- Report dry-run/confirm/human gate status.
- Report no secrets exposed.
- Report config templates updated.
- Report change record.