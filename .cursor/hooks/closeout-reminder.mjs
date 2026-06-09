#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const policy = JSON.parse(await readFile(resolve(process.cwd(), ".cursor/hooks/policy.generated.json"), "utf8"));
const evidence = policy.closeout?.requiredEvidence ?? [];

process.stdout.write(
  JSON.stringify({
    allow: true,
    reason: `Remember closeout evidence: ${evidence.join(", ") || "n/a"}`
  })
);
