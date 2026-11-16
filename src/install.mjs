// `flow-mcp install [--client claude-code|claude-desktop|print] [--name flow]`
// Registers this MCP server in an AI client so the user does not have to hand-write config.
//   claude-code     runs `claude mcp add --scope user flow -- node <this package>/bin/flow-mcp.mjs serve`
//   claude-desktop  merges an entry into claude_desktop_config.json (a .bak copy is made first)
//   print           prints the JSON snippet for any other MCP client (Cursor, Codex, VS Code, Windsurf, ...)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "flow-mcp.mjs");

export function serverEntry() {
  return { command: process.execPath, args: [BIN, "serve"] };
}

function claudeDesktopConfigPath() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

function hasCommand(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0;
}

export function installClaudeCode(name) {
  if (!hasCommand("claude")) return { ok: false, message: "The `claude` command was not found. Install Claude Code, or use --client print and paste the snippet into your client." };
  const e = serverEntry();
  const win = process.platform === "win32"; // `claude` is a .cmd shim there, which needs a shell: quote every argument
  const q = (a) => (win ? `"${a}"` : a);
  const r = spawnSync("claude", ["mcp", "add", "--scope", "user", name, "--", e.command, ...e.args].map(q), { encoding: "utf8", shell: win });
  const text = `${r.stdout || ""}${r.stderr || ""}`.trim();
  if (r.status === 0) return { ok: true, message: `Registered "${name}" in Claude Code (user scope). Restart Claude Code or run /mcp to see it.` };
  if (/already exists/i.test(text)) return { ok: true, message: `"${name}" is already registered in Claude Code. To re-point it: claude mcp remove ${name} --scope user, then run this command again.` };
  return { ok: false, message: `claude mcp add failed: ${text || `exit ${r.status}`}` };
}

export function installClaudeDesktop(name) {
  const file = claudeDesktopConfigPath();
  let cfg = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8");
    try { cfg = raw.trim() ? JSON.parse(raw) : {}; } catch { return { ok: false, message: `${file} is not valid JSON; fix it (or delete it) and run again. Nothing was changed.` }; }
    fs.copyFileSync(file, `${file}.bak`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: serverEntry() };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return { ok: true, message: `Added "${name}" to ${file}${fs.existsSync(`${file}.bak`) ? " (previous version saved as .bak)" : ""}. Fully quit and reopen Claude Desktop.` };
}

export function printSnippet(name) {
  return { ok: true, message: JSON.stringify({ mcpServers: { [name]: serverEntry() } }, null, 2) };
}

export async function main(argv = process.argv.slice(2)) {
  let client = null, name = "flow";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--client") client = argv[++i];
    else if (argv[i] === "--name") name = argv[++i];
  }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) { console.error("FAILED: --name must be letters, digits, '-' or '_'"); process.exit(1); }
  if (!client) client = hasCommand("claude") ? "claude-code" : "print";
  const run = { "claude-code": installClaudeCode, "claude-desktop": installClaudeDesktop, print: printSnippet }[client];
  if (!run) { console.error(`FAILED: unknown client "${client}" — use claude-code, claude-desktop or print`); process.exit(1); }
  const r = run(name);
  if (client === "print") console.log(`Add this to your MCP client's configuration (the "mcpServers" section):\n\n${r.message}`);
  else console.log(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`);
  process.exit(r.ok ? 0 : 1);
}
