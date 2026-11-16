// Starts (or reuses) the Chrome that holds one account's Google session, and exposes it over CDP on 127.0.0.1 ONLY.
//
// Security notes:
//  - The debugging port is bound to loopback (Chrome's default). Never publish it: whoever reaches it controls a browser
//    that is signed in to your Google account.
//  - Chrome is started with a dedicated --user-data-dir (never your everyday profile). That folder IS the Google session.
//  - Chrome is launched as a normal browser (not through Playwright's launcher), so Google sign-in works the same as in
//    any Chrome window.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function cdpAlive(cdpUrl) {
  try {
    const resp = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Flow's labels are matched in Portuguese (see selectors.mjs), so a fresh profile is told to prefer pt-BR. */
function seedLanguage(profileDir) {
  const prefs = path.join(profileDir, "Default", "Preferences");
  if (fs.existsSync(prefs)) return;
  fs.mkdirSync(path.dirname(prefs), { recursive: true });
  fs.writeFileSync(prefs, JSON.stringify({ intl: { accept_languages: "pt-BR,pt,en-US,en" } }));
}

/** On POSIX, Chrome leaves Singleton* links behind after a crash; remove them only if the owning process is gone. */
function clearStaleLocks(profileDir) {
  if (process.platform === "win32") return;
  try {
    const target = fs.readlinkSync(path.join(profileDir, "SingletonLock")); // "<host>-<pid>"
    const pid = Number(target.split("-").pop());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; }
    if (alive) return;
  } catch { return; }
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(profileDir, f), { force: true });
}

export function launchChrome({ chromeExe, cdpPort, profileDir, url }) {
  fs.mkdirSync(profileDir, { recursive: true });
  seedLanguage(profileDir);
  clearStaleLocks(profileDir);
  const child = spawn(
    chromeExe,
    [
      `--remote-debugging-port=${cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--lang=pt-BR",
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ],
    { detached: true, stdio: "ignore" }
  );
  child.on("error", () => {});
  child.unref();
}

export async function ensureBrowser({ cdpUrl, cdpPort, profileDir, chromeExe, projectUrl, waitSeconds = 30 }) {
  if (await cdpAlive(cdpUrl)) return; // already running
  console.error(`No Chrome on ${cdpUrl} — launching one with this account's saved profile...`);
  launchChrome({ chromeExe, cdpPort, profileDir, url: projectUrl });
  for (let i = 0; i < waitSeconds; i++) {
    await sleep(1000);
    if (await cdpAlive(cdpUrl)) return;
  }
  throw new Error(
    `Chrome did not open a debugging endpoint on ${cdpUrl} within ${waitSeconds}s. ` +
      `If a Chrome window is already open on the profile ${profileDir}, close it (the profile can only be used by one Chrome) and try again.`
  );
}
