// Where flow-mcp keeps its data. Everything lives under ONE folder in the user's home, never inside the package:
//   <HOME>/accounts.json      registered Flow accounts (no secrets: only ids, ports, project URLs)
//   <HOME>/profiles/<id>/     one Chrome profile per account — this IS the Google session, keep it private
//   <HOME>/downloads/         files saved by flow_download
//   <HOME>/uploads/           files you want to send with flow_upload
//   <HOME>/logs/, <HOME>/state/   healthcheck logs, pacing state, lock file
// Override the root with FLOW_MCP_HOME.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const HOME = path.resolve(process.env.FLOW_MCP_HOME || path.join(os.homedir(), ".flow-mcp"));

export const ACCOUNTS_FILE = () => process.env.FLOW_MCP_ACCOUNTS_FILE || path.join(HOME, "accounts.json");
export const PROFILES_DIR = path.join(HOME, "profiles");
export const DOWNLOAD_DIR = path.resolve(process.env.FLOW_MCP_DOWNLOAD_DIR || path.join(HOME, "downloads"));
export const UPLOAD_DIR = path.resolve(process.env.FLOW_MCP_UPLOAD_DIR || path.join(HOME, "uploads"));
export const LOG_DIR = path.join(HOME, "logs");
export const STATE_DIR = path.join(HOME, "state");

/** Creates the data folders. On POSIX the root is made private (0700): it holds a logged-in Chrome profile. */
export function ensureHome() {
  for (const d of [HOME, PROFILES_DIR, DOWNLOAD_DIR, UPLOAD_DIR, LOG_DIR, STATE_DIR]) fs.mkdirSync(d, { recursive: true });
  if (process.platform !== "win32") {
    try { fs.chmodSync(HOME, 0o700); } catch { /* not ours to change */ }
  }
}

/** Finds an installed Google Chrome (or Chromium). FLOW_MCP_CHROME_EXE wins. Returns null when none is found. */
export function findChrome() {
  const env = process.env.FLOW_MCP_CHROME_EXE;
  if (env) return env;
  const candidates = [];
  if (process.platform === "win32") {
    for (const base of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      for (const bin of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) candidates.push(path.join(dir, bin));
    }
  }
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) ?? null;
}
