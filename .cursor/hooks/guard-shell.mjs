#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const policyPath = resolve(process.cwd(), ".cursor/hooks/policy.generated.json");
const policy = JSON.parse(await readFile(policyPath, "utf8"));

let payload;
try {
  payload = JSON.parse(await readStdin());
} catch {
  payload = {};
}

const command = payload.command ?? payload.input ?? "";

for (const pattern of policy.shell?.deny ?? []) {
  if (new RegExp(pattern).test(command)) {
    process.stdout.write(JSON.stringify({ allow: false, reason: `Shell blocked: ${pattern}` }));
    process.exit(2);
  }
}
for (const pattern of policy.shell?.ask ?? []) {
  if (new RegExp(pattern).test(command)) {
    process.stdout.write(JSON.stringify({ allow: true, ask: true, reason: `Shell needs confirmation: ${pattern}` }));
    process.exit(0);
  }
}

process.stdout.write(JSON.stringify({ allow: true }));

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
