---
name: feature-cycle
description: Execute feature work from classification through implementation, tests, docs and closeout.
---

# Feature Cycle
Normal implementation workflow for features and fixes.

## Use When
- User asks to implement a feature, bug fix or API-adjacent change.

## Required Inputs
- Goal and observable done condition.
- Change type and affected domain.
- Public contract reference when type is P.

## Outputs
- Cohesive implementation.
- Focused tests.
- Updated contracts/docs when needed.
- PR/CI/change-record evidence.

## Gates
- product-boundary
- api-contract
- testing
- pr-ci-main
- deploy

## Stop Conditions
- Public API lacks contract.
- Product boundary is unclear.
- Security, database or platform scope appears without routing to dedicated workflow.
- Production promotion is requested.

## Closeout
- Report change type and gates.
- Report checks run.
- Report branch, PR, CI and merge state.
- Report deploy verify if runtime changed.
- Report change record status.
