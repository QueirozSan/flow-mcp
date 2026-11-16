// The "camada de constância": run this before any real action (generate.mjs
// does this automatically) or on its own, on a schedule, to detect Google
// changing Flow's UI. Every selector generate.mjs depends on is checked live
// against the real page; any drift on a `critical: true` selector is logged
// loudly, written to logs/, and fails fast — the whole point is to notice
// breakage the moment it happens instead of silently getting a confusing
// Playwright timeout three steps into a generation.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { SELECTORS } from "./selectors.mjs";
import { resolveAccount, cdpUrlFor } from "./config.mjs";
import { LOG_DIR } from "./paths.mjs";
import { comTrava } from "./trava.mjs";


function timestamp() {
  return new Date().toISOString();
}

function writeLog(lines) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `healthcheck-${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(file, lines.join("\n") + "\n\n");
  return file;
}

// navega a aba do Flow (volta à home do projeto): com outra chamada em andamento isso estragaria a dela — usa a trava
export function runHealthcheck(opts = {}) {
  return comTrava("healthcheck", () => checar(opts));
}

async function checar({ account: accountId, projectUrl, quiet = false } = {}) {
  const account = resolveAccount(accountId);
  const resolvedProjectUrl = projectUrl || account.projectUrl;
  const results = [];
  let page;
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrlFor(account));
    page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error("no page found on the attached browser");
    // Always land fresh on the project's base composer view — a stale asset
    // detail view (or any other sub-page) would make every selector below
    // look "missing" for a reason that has nothing to do with Flow's UI
    // actually changing, which is exactly the false alarm this must avoid.
    await page.goto(resolvedProjectUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // The ProseMirror prompt box mounts a beat after everything else —
    // measured: fine on an already-warm Chrome, but a COLD-launched one
    // (ensureBrowser() just spawned it) needs real headroom or this reports
    // a false "promptBox missing" alarm before it has even had a chance to
    // render. Wait for it specifically (generously), and don't let that one
    // wait turn into a hard failure — the count check right after still
    // catches a genuine absence.
    await page
      .locator("div.ProseMirror[contenteditable='true']")
      .first()
      .waitFor({ state: "attached", timeout: 15000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
  } catch (err) {
    const msg = `[${timestamp()}] CONNECTION FAILED: ${err.message}`;
    if (!quiet) console.error("\n🚨 healthcheck: could not reach the browser/page —", err.message, "\n");
    writeLog([msg]);
    return { ok: false, results: [], connectionError: err.message };
  }

  for (const [name, def] of Object.entries(SELECTORS)) {
    let count = 0;
    let error = null;
    try {
      count = await page.locator(def.selector).count();
    } catch (err) {
      error = err.message;
    }
    const found = count > 0 && !error;
    results.push({ name, ...def, found, count, error });
  }

  const criticalFailures = results.filter((r) => r.critical && !r.found);
  const ok = criticalFailures.length === 0;

  const lines = [`[${timestamp()}] healthcheck run (account=${account.id}) — ${ok ? "OK" : "DRIFT DETECTED"}`];
  for (const r of results) {
    lines.push(
      `  ${r.found ? "PASS" : "FAIL"}  ${r.name.padEnd(20)} critical=${r.critical}  "${r.selector}"` +
        (r.error ? `  ERROR: ${r.error}` : ` (matches: ${r.count})`)
    );
  }
  const logFile = writeLog(lines);

  if (!quiet) {
    if (ok) {
      console.log(`✅ healthcheck OK — all ${results.length} known selectors still match (log: ${logFile})`);
    } else {
      console.error("\n🚨🚨🚨 SITE CHANGED — SELECTOR DRIFT DETECTED 🚨🚨🚨");
      console.error(`${criticalFailures.length} critical selector(s) stopped matching:`);
      for (const f of criticalFailures) {
        console.error(`  - ${f.name}: "${f.selector}" (${f.description})`);
      }
      console.error(`Full details logged to: ${logFile}`);
      console.error("flow_generate will refuse to run until this is investigated (see the README, 'When the site changes').\n");
    }
  }

  if (browser) await browser.close().catch(() => {});
  return { ok, results, logFile };
}

/** CLI: `flow-mcp healthcheck [--account <id>]` */
export async function main(argv = process.argv.slice(2)) {
  const accountFlagIndex = argv.indexOf("--account");
  const account = accountFlagIndex >= 0 ? argv[accountFlagIndex + 1] : undefined;
  const { ok } = await runHealthcheck({ account });
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === "healthcheck.mjs";
if (isMain) await main();
