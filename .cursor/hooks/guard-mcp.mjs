#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const policy = JSON.parse(await readFile(resolve(process.cwd(), ".cursor/hooks/policy.generated.json"), "utf8"));
const payload = await readJson();
const tool = payload.tool ?? payload.name ?? "";
const server = payload.server ?? payload.serverName ?? "";
const env = payload.environment ?? "preview";

const sensitiveRe = new RegExp(policy.mcp?.sensitivePayloadPattern ?? "", "i");
if (sensitiveRe.source && sensitiveRe.test(JSON.stringify(payload))) {
  process.stdout.write(JSON.stringify({ allow: false, reason: "MCP payload contains sensitive data." }));
  process.exit(2);
}

const writeRe = new RegExp(policy.mcp?.writeToolPattern ?? "");
if (!writeRe.test(tool)) {
  process.stdout.write(JSON.stringify({ allow: true }));
  process.exit(0);
}

const providerEntry = Object.entries(policy.mcp?.providers ?? {}).find(([, cfg]) => (cfg.serverNames ?? []).includes(server));
if (!providerEntry) {
  process.stdout.write(JSON.stringify({ allow: true, ask: true, reason: "Unknown MCP server; ask before write." }));
  process.exit(0);
}

const writes = providerEntry[1].writes ?? {};
const decision = env === "production" ? writes.production ?? "human-gate" : writes.default ?? "dry-run";
if (decision === "deny") {
  process.stdout.write(JSON.stringify({ allow: false, reason: "MCP write denied by provider policy." }));
  process.exit(2);
}
if (decision === "human-gate" || decision === "confirm") {
  process.stdout.write(JSON.stringify({ allow: true, ask: true, reason: `MCP write requires ${decision}.` }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ allow: true }));

async function readJson() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data || "{}");
  } catch {
    return {};
  }
}
