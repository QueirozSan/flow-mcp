// Account registry. Each account has its OWN Chrome profile directory and its OWN debugging port, so several accounts
// can coexist without profile locks or port clashes. The registry is a small JSON file in the data folder (see
// paths.mjs); it is created by `flow-mcp login` and holds no credentials — the Google session lives in the Chrome
// profile on this computer.
//
//   { "default": "main", "ordem": ["main", "second"], "accounts": { "<id>": { label, profileDir, cdpPort, projectUrl } } }
//
// `profileDir` may be relative to the data folder or absolute. FLOW_MCP_PROFILE_DIR / FLOW_MCP_CDP_PORT /
// FLOW_MCP_PROJECT_URL override the resolved values for whichever account is picked.

import fs from "node:fs";
import path from "node:path";
import { HOME, ACCOUNTS_FILE, PROFILES_DIR, ensureHome, findChrome } from "./paths.mjs";

/** Chrome executable (resolved at call time, so a Chrome installed later is picked up without a restart). */
export function chromeExe() {
  const exe = findChrome();
  if (!exe) throw new Error("Google Chrome was not found. Install Chrome, or set FLOW_MCP_CHROME_EXE to its executable path.");
  return exe;
}

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/i;
export const FIRST_CDP_PORT = 9340; // away from 9222, which other tools commonly use

export function readRegistry() {
  try {
    const reg = JSON.parse(fs.readFileSync(ACCOUNTS_FILE(), "utf8"));
    return { default: reg.default ?? null, ordem: reg.ordem, accounts: reg.accounts ?? {} };
  } catch {
    return { default: null, accounts: {} };
  }
}

export function writeRegistry(reg) {
  ensureHome();
  const file = ACCOUNTS_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Adds or updates one account (used by `flow-mcp login`). The first account becomes the default. */
export function saveAccount(id, patch) {
  if (!ID_RE.test(id)) throw new Error(`invalid account name "${id}" — use letters, digits, "-" or "_" (max 31 characters)`);
  const reg = readRegistry();
  const prev = reg.accounts[id] ?? {};
  const used = new Set(Object.values(reg.accounts).map((a) => a.cdpPort));
  let port = prev.cdpPort;
  if (!port) { port = FIRST_CDP_PORT; while (used.has(port)) port++; }
  reg.accounts[id] = { label: id, profileDir: path.join("profiles", id), ...prev, ...patch, cdpPort: port };
  if (!reg.default || !reg.accounts[reg.default]) reg.default = id;
  writeRegistry(reg);
  return reg.accounts[id];
}

/** Removes an account from the registry (used to roll back a login that never completed). Profile files are kept. */
export function removeAccount(id) {
  const reg = readRegistry();
  if (!reg.accounts[id]) return;
  delete reg.accounts[id];
  if (reg.ordem) reg.ordem = reg.ordem.filter((x) => x !== id);
  if (reg.default === id) reg.default = Object.keys(reg.accounts)[0] ?? null;
  writeRegistry(reg);
}

/**
 * Resolves one account's settings by id (default: the registry's "default"). Throws an actionable error when no
 * account is registered yet or the account has no Flow project yet.
 */
export function resolveAccount(accountId, { needProject = true } = {}) {
  const reg = readRegistry();
  const known = Object.keys(reg.accounts);
  if (!known.length) throw new Error("no Google Flow account is connected yet — run `flow-mcp login` in a terminal (it opens Chrome so you can sign in with Google), then try again.");
  const id = accountId || process.env.FLOW_MCP_ACCOUNT || reg.default || known[0];
  const entry = reg.accounts[id];
  if (!entry) throw new Error(`unknown account "${id}" — connected accounts: ${known.join(", ")} (add one with \`flow-mcp login --name <id>\`)`);
  const projectUrl = process.env.FLOW_MCP_PROJECT_URL || entry.projectUrl;
  if (needProject && !projectUrl) throw new Error(`account "${id}" has no Flow project yet — run \`flow-mcp login --name ${id}\` again to pick or create one.`);
  const profile = process.env.FLOW_MCP_PROFILE_DIR || entry.profileDir || path.join("profiles", id);
  return {
    id,
    label: entry.label || id,
    profileDir: path.isAbsolute(profile) ? profile : path.join(HOME, profile),
    cdpPort: Number(process.env.FLOW_MCP_CDP_PORT || entry.cdpPort),
    projectUrl,
  };
}

export function listAccounts() {
  const reg = readRegistry();
  return Object.entries(reg.accounts).map(([id, entry]) => ({
    id,
    label: entry.label || id,
    isDefault: id === reg.default,
    cdpPort: entry.cdpPort,
    projectUrl: entry.projectUrl ?? null,
  }));
}

/**
 * Turns a user/agent-supplied `project` (bare id or URL) into a Flow project URL. Anything that is not an https URL on
 * flow.google.com is refused: this value is navigated to in a browser that is signed in to the user's Google account.
 */
export function projectFromInput(value) {
  const s = String(value ?? "").trim();
  if (/^[a-z0-9-]{8,}$/i.test(s)) return `https://flow.google.com/project/${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error(`invalid project "${s}" — pass a Flow project id or a https://flow.google.com/project/<id> URL`); }
  if (u.protocol !== "https:" || u.hostname !== "flow.google.com" || u.username || u.password || !/^\/(?:[^/]+\/)*project\/[a-z0-9-]+\/?$/i.test(u.pathname)) {
    throw new Error(`invalid project "${s}" — only https://flow.google.com/project/<id> URLs are accepted`);
  }
  return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
}

export function cdpUrlFor(account) {
  return `http://127.0.0.1:${account.cdpPort}`;
}

export { PROFILES_DIR };
