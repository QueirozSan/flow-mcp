// `flow-mcp login` — connects a Google account to Flow.
//
// Flow has no public API and no developer OAuth client, so "connecting" an account means signing in with Google
// inside a Chrome window that THIS tool opens with its own dedicated profile. That sign-in is Google's normal OAuth
// flow, done by you, in the browser: this tool never sees or stores your password, 2FA codes or tokens. The only
// thing that persists is the Chrome profile folder on this computer (the same thing Chrome itself keeps when you
// stay signed in). We only check that the Google session cookie EXISTS (by name) — its value is never read.
//
//   flow-mcp login [--name <id>] [--project <flow project url>] [--new-project] [--timeout <minutes>]

import { chromium } from "playwright-core";
import path from "node:path";
import { chromeExe, cdpUrlFor, resolveAccount, saveAccount, removeAccount, readRegistry, ID_RE } from "./config.mjs";
import { ensureHome } from "./paths.mjs";
import { ensureBrowser } from "./browser.mjs";
import { runHealthcheck } from "./healthcheck.mjs";
import { comTrava } from "./trava.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROJECT_RE = /^https:\/\/flow\.google\.com\/(?:[a-z]{2}(?:-[A-Za-z]{2,4})?\/)?(?:tools\/flow\/)?project\/([a-z0-9-]+)/i;
// Names of Google's session cookies. Only the NAME is checked.
const SESSION_COOKIES = ["SAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID"];

const out = (m = "") => process.stdout.write(m + "\n");

function parseArgs(argv) {
  const o = { timeoutMin: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name" || a === "--account") o.name = argv[++i];
    else if (a === "--project") o.project = argv[++i];
    else if (a === "--new-project") o.newProject = true;
    else if (a === "--timeout") o.timeoutMin = Number(argv[++i]);
  }
  return o;
}

async function signedIn(context) {
  try {
    const cookies = await context.cookies("https://accounts.google.com");
    return cookies.some((c) => SESSION_COOKIES.includes(c.name));
  } catch {
    return false;
  }
}

export async function runLogin(opts = {}) {
  ensureHome();
  const reg = readRegistry();
  const name = opts.name || (Object.keys(reg.accounts).length ? null : "main");
  if (!name) throw new Error(`you already have connected account(s) (${Object.keys(reg.accounts).join(", ")}). To add another one, pass a name: flow-mcp login --name <id>. To sign the existing one in again, pass its name.`);
  if (!ID_RE.test(name)) throw new Error(`invalid account name "${name}" — use letters, digits, "-" or "_"`);
  if (opts.project && !PROJECT_RE.test(opts.project)) throw new Error("--project must be a Flow project URL like https://flow.google.com/project/<id>");
  const exe = chromeExe(); // fails early with an actionable message

  const existed = Boolean(reg.accounts[name]);
  const saved = saveAccount(name, opts.project ? { projectUrl: opts.project.split("?")[0] } : {});
  const account = resolveAccount(name, { needProject: false });
  const cdpUrl = cdpUrlFor(account);

  out(`\nConnecting Google Flow account "${name}"${existed ? " (already registered — signing in again)" : ""}.`);
  out("A Chrome window is opening. In it:");
  out("  1. Sign in with the Google account you use for Flow (Google's own sign-in page — nothing is typed here).");
  out("  2. Accept Flow's terms if it asks.");
  out(opts.project || opts.newProject ? "  3. Wait: the project is picked automatically.\n" : "  3. Open the Flow project you want to use (or click New project). It is detected automatically.\n");

  try {
  await comTrava("login", async () => {
    await ensureBrowser({ cdpUrl, cdpPort: account.cdpPort, profileDir: account.profileDir, chromeExe: exe, projectUrl: "https://flow.google.com/", waitSeconds: 40 });
    const browser = await chromium.connectOverCDP(cdpUrl);
    try {
      const context = browser.contexts()[0];
      const pages = () => context.pages();
      const flowPage = () => pages().find((p) => p.url().startsWith("https://flow.google.com")) ?? pages()[0];
      const deadline = Date.now() + opts.timeoutMin * 60e3;
      let projectUrl = saved.projectUrl ?? null;
      let sawSignIn = false;
      let triedNew = false;
      let signedInAt = 0;
      let nudged = false;

      while (Date.now() < deadline) {
        const ok = await signedIn(context);
        if (ok && !sawSignIn) { sawSignIn = true; signedInAt = Date.now(); out("✓ Google sign-in detected."); }
        const page = flowPage();
        const url = page?.url() ?? "";
        if (ok && page) {
          if (!url.startsWith("https://flow.google.com")) {
            // signed in but still on a Google account page after a few seconds: take the tab to Flow, once
            if (!nudged && Date.now() - signedInAt > 8000 && /^https:\/\/(accounts|myaccount)\.google\.com/.test(url)) {
              nudged = true;
              await page.goto("https://flow.google.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
            }
          } else {
            const m = url.match(PROJECT_RE);
            if (opts.project) { projectUrl = opts.project.split("?")[0]; break; }
            if (m) { projectUrl = url.split("?")[0]; break; }
            if (opts.newProject && !triedNew) {
              const btn = page.locator("button.new-project-button");
              if (await btn.isVisible().catch(() => false)) {
                triedNew = true;
                await btn.click({ timeout: 10000 }).catch(() => {});
                await page.waitForURL(PROJECT_RE, { timeout: 30000 }).catch(() => {});
              }
            }
          }
        }
        await sleep(1500);
      }
      if (!projectUrl) {
        throw new Error(sawSignIn
          ? "Signed in, but no Flow project was opened in time. Run `flow-mcp login` again and open (or create) a project, or use --new-project."
          : "No Google sign-in was detected in time. Run `flow-mcp login` again and complete the sign-in in the Chrome window.");
      }
      if (!PROJECT_RE.test(projectUrl)) throw new Error(`unexpected project URL: ${projectUrl}`);
      saveAccount(name, { projectUrl });
      out(`✓ Flow project: ${projectUrl}`);

      // Let the page finish loading, then verify the UI this tool drives is really there.
      await flowPage()?.goto(projectUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    } finally {
      await browser.close().catch(() => {});
    }
  });
  } catch (err) {
    await closeChrome(cdpUrl); // do not leave a half-finished sign-in window open
    if (!existed && !readRegistry().accounts[name]?.projectUrl) removeAccount(name); // do not keep a half-registered account
    throw err;
  }

  out("\nChecking that Flow's interface matches what this tool drives...");
  const health = await runHealthcheck({ account: name, quiet: true });
  if (health.ok) {
    out(`✓ All ${health.results.length} interface checks passed.`);
  } else {
    out("⚠ The sign-in worked, but Flow's page does not look like the interface this tool supports:");
    if (health.connectionError) out(`  ${health.connectionError}`);
    for (const r of health.results.filter((x) => x.critical && !x.found)) out(`  - missing: ${r.name} (${r.description})`);
    out("  This tool targets the chat-style composer and the Portuguese (pt-BR) interface. See the README, 'Requirements and limits'.");
  }
  await closeChrome(cdpUrl);

  out(`\nAccount "${name}" is connected. Data folder: ${path.dirname(account.profileDir)}`);
  out("Next: register the MCP server in your AI client with `flow-mcp install`, then ask it to generate an image.");
  return { account: name, projectUrl: resolveAccount(name).projectUrl, healthcheckOk: health.ok };
}

/** Closes the Chrome of this account (so the profile is flushed to disk). The server relaunches it on demand. */
export async function closeChrome(cdpUrl) {
  try {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.close").catch(() => {});
  } catch { /* already closed */ }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const r = await runLogin(parseArgs(argv));
    process.exit(r.healthcheckOk ? 0 : 3);
  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
  }
}
