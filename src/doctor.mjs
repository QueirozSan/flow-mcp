// `flow-mcp doctor` — checks the local setup without touching Flow: Node, Chrome, data folder, accounts.
// (Use `flow-mcp healthcheck` to check Flow's live page.) Exits 0 only when everything needed is in place.

import fs from "node:fs";
import { findChrome, HOME, UPLOAD_DIR, DOWNLOAD_DIR } from "./paths.mjs";
import { listAccounts } from "./config.mjs";
import { cdpAlive } from "./browser.mjs";

export async function runDoctor() {
  const checks = [];
  const add = (ok, label, hint = "") => checks.push({ ok, label, hint });
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20, `Node.js ${process.versions.node}`, "Node.js 20 or newer is required");
  const chrome = findChrome();
  add(Boolean(chrome), chrome ? `Chrome: ${chrome}` : "Google Chrome not found", "Install Google Chrome, or set FLOW_MCP_CHROME_EXE to its path");
  add(true, `Data folder: ${HOME}${fs.existsSync(HOME) ? "" : " (created on first login)"}`);
  const accounts = listAccounts();
  add(accounts.length > 0, accounts.length ? `Accounts: ${accounts.map((a) => a.id + (a.isDefault ? " (default)" : "")).join(", ")}` : "No account connected", "Run: flow-mcp login");
  for (const a of accounts) {
    add(Boolean(a.projectUrl), `Account "${a.id}": ${a.projectUrl ?? "no Flow project yet"}`, `Run: flow-mcp login --name ${a.id}`);
    add(true, `Account "${a.id}" browser: ${(await cdpAlive(`http://127.0.0.1:${a.cdpPort}`)) ? "running" : "not running (starts on demand)"}`);
  }
  add(true, `Uploads folder: ${UPLOAD_DIR}`);
  add(true, `Downloads folder: ${DOWNLOAD_DIR}`);
  return checks;
}

export async function main() {
  const checks = await runDoctor();
  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.label}${!c.ok && c.hint ? `\n    → ${c.hint}` : ""}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
