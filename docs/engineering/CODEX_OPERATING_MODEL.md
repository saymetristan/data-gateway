<!-- Generated from .agent/operating-model.yaml. Edit source config instead. -->

# Tsuzuro Data Gateway Codex Operating Model

Codex runs without local hooks. Enforcement here is documentary plus PR/CI gates.

## Required Checks
- Not declared.

## Stop Conditions
- Production / destructive provider actions need human gate.
- DB migrations require change record before merge.
- Public surface changes require contract update.
