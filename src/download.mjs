// Saves a generated asset from Google Flow to disk, using Flow's own
// "Baixar mídia" menu. Chrome downloads the file itself (we only tell it
// where to put it via CDP Browser.setDownloadBehavior), so this works on a
// Chrome attached over CDP — the case Playwright's own download event misses.
//
// CLI usage:
//   node download.mjs [--asset <id>] [--quality "720p"] [--account <id>] [--project <id>]
//   (no --asset = the newest asset in the project gallery)
//
// Programmatic usage (what mcp-server.mjs calls):
//   import { runDownload } from "./download.mjs";
//   await runDownload({ assetId, quality });
//
// Safety: by default it picks the "Tamanho original" entry, which is the file
// Flow already produced. The "Aprimorada" entries (1080p/4K) are upscales and
// may spend credits, so they are only chosen if you ask for them by name.

import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
import { chromeExe, resolveAccount, cdpUrlFor, projectFromInput } from "./config.mjs";
import { DOWNLOAD_DIR } from "./paths.mjs";
import { ensureBrowser, pickFlowPage, ensureProjectHome, openNewestTile } from "./generate.mjs";
import { contaAtiva, marcarUsada } from "./contas.mjs";
import { aguardarVez, registrarAcao, registrarAtividadeIncomum, ATIVIDADE_INCOMUM, clicar, pausa } from "./humano.mjs";
import { comTrava } from "./trava.mjs";

export { DOWNLOAD_DIR };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--asset") out.assetId = argv[++i];
    else if (a === "--quality") out.quality = argv[++i];
    else if (a === "--account") out.account = argv[++i];
    else if (a === "--project") out.project = argv[++i];
  }
  return out;
}

export function runDownload(opts = {}) {
  return comTrava("download", () => baixar(opts));
}

async function baixar(opts) {
  // sem conta explícita: a conta ATIVA (onde a última geração aconteceu) — o arquivo gerado está nela
  const account = resolveAccount(opts.account ?? contaAtiva() ?? undefined);
  const projectUrl = opts.project ? projectFromInput(opts.project) : account.projectUrl;
  const cdpUrl = cdpUrlFor(account);

  await aguardarVez("download"); // pausa por "atividade incomum" + folga entre ações
  marcarUsada(account.id);

  await ensureBrowser({ cdpUrl, cdpPort: account.cdpPort, profileDir: account.profileDir, chromeExe: chromeExe(), projectUrl });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const browser = await chromium.connectOverCDP(cdpUrl);
  let session;
  try {
    const page = pickFlowPage(browser);

    let assetId = opts.assetId;
    if (assetId) {
      await page.goto(`${projectUrl.split("?")[0].replace(/\/$/, "")}/edit/${assetId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await pausa(page, 2200, 3600);
    } else {
      await ensureProjectHome(page, projectUrl);
      ({ assetId } = await openNewestTile(page));
    }

    session = await browser.newBrowserCDPSession();
    await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_DIR, eventsEnabled: true });
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    session.on("Browser.downloadProgress", (e) => {
      if (e.state === "completed" || e.state === "canceled") done(e);
    });

    const pagina = await page.locator("body").innerText().catch(() => "");
    const incomum = pagina.match(ATIVIDADE_INCOMUM);
    if (incomum) {
      const ate = registrarAtividadeIncomum(pagina.slice(Math.max(0, incomum.index - 20), incomum.index + 160));
      throw new Error(`Google Flow mostrou "atividade incomum": mcp-flow em pausa até ${new Date(ate).toISOString()}`);
    }
    await clicar(page, page.locator("button[aria-label='Baixar mídia']").first(), { timeout: 15000 });
    await pausa(page, 1000, 1800);

    const options = await page.evaluate(() =>
      [...document.querySelectorAll("[role='menuitem'], .cdk-overlay-container button, .cdk-overlay-container li")]
        .filter((e) => e.checkVisibility && e.checkVisibility())
        .map((e) => (e.textContent || "").trim().replace(/\s+/g, " "))
        .filter(Boolean)
    );
    const uniq = [...new Set(options)];
    const wanted = opts.quality
      ? uniq.find((t) => t.toLowerCase().includes(String(opts.quality).toLowerCase()))
      : uniq.find((t) => /original/i.test(t));
    if (!wanted) {
      await page.keyboard.press("Escape");
      throw new Error(`no download option matches ${opts.quality ? `"${opts.quality}"` : '"original"'} — available: ${JSON.stringify(uniq)}`);
    }
    await clicar(page, page.getByText(wanted, { exact: true }).first());
    registrarAcao("download");

    let timer;
    const result = await Promise.race([
      finished,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("download did not finish within 120s")), 120000); }),
    ]).finally(() => clearTimeout(timer));
    if (result.state !== "completed") throw new Error(`download ${result.state}`);

    const filePath = result.filePath || null;
    return {
      assetId,
      option: wanted,
      path: filePath,
      filename: filePath ? path.basename(filePath) : null,
      bytes: result.receivedBytes,
      availableOptions: uniq,
    };
  } finally {
    await session?.detach().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runDownload(parseArgs(argv));
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("FAILED:", err.message);
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === "download.mjs";
if (isMain) main();
