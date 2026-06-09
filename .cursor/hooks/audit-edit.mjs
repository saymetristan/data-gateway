#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const policy = JSON.parse(await readFile(resolve(process.cwd(), ".cursor/hooks/policy.generated.json"), "utf8"));
const payload = await readJson();
const path = payload.path ?? "";
const preview = payload.previewText ?? payload.content ?? "";

for (const sensitive of policy.sensitivePaths ?? []) {
  if (matches(sensitive, path)) {
    process.stdout.write(JSON.stringify({ allow: false, reason: `Edit blocked on sensitive path: ${sensitive}` }));
    process.exit(2);
  }
}

const sensitiveRe = new RegExp(policy.mcp?.sensitivePayloadPattern ?? "", "i");
if (sensitiveRe.source && sensitiveRe.test(preview)) {
  process.stdout.write(JSON.stringify({ allow: false, reason: "Edit contains sensitive data." }));
  process.exit(2);
}

process.stdout.write(JSON.stringify({ allow: true }));

function matches(glob, value) {
  if (!glob.includes("*")) return value === glob || value.endsWith(`/${glob}`) || value.includes(glob);
  const regex = new RegExp(
    "^" +
      glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") +
      "$"
  );
  return regex.test(value);
}

async function readJson() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data || "{}");
  } catch {
    return {};
  }
}
