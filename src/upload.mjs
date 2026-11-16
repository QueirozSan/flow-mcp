// Uploads a local image/video into the Google Flow project gallery (the header "+" menu -> "Enviar"),
// so it can be used as a REFERENCE in flow_generate (`reference: <name returned here>`).
//
// The caller passes a PATH (an LLM cannot pass a multi-MB video as a tool argument). Security: the path must live
// inside the uploads/ or downloads/ folder of the data folder (or a folder listed in FLOW_MCP_UPLOAD_DIRS) — this tool
// sends the file to Google, so it must never be able to read arbitrary files (e.g. the Chrome profile = Google session). URLs are NOT accepted on purpose: the
// server fetching arbitrary URLs would open SSRF against 127.0.0.1 (the CDP port controls the logged-in Chrome).
//
// CLI usage:
//   flow-mcp upload --path ~/.flow-mcp/uploads/ref.png [--timeout 120] [--account <id>] [--project <id>]
//
// Programmatic usage (what mcp-server.mjs calls):
//   import { runUpload } from "./upload.mjs";
//   await runUpload({ path: "/home/me/.flow-mcp/uploads/ref.png" });

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { chromeExe, resolveAccount, cdpUrlFor } from "./config.mjs";
import { UPLOAD_DIR, DOWNLOAD_DIR } from "./paths.mjs";
import { SELECTORS } from "./selectors.mjs";
import { ensureBrowser, pickFlowPage, ensureProjectHome, newestTileSignature, openTile, dismissOverlays } from "./generate.mjs";
import { contaAtiva, marcarUsada } from "./contas.mjs";
import { aguardarVez, registrarAcao, registrarAtividadeIncomum, ATIVIDADE_INCOMUM, clicar, pausa } from "./humano.mjs";
import { comTrava } from "./trava.mjs";

export { UPLOAD_DIR };

// Exactly what Flow's own file input declares it accepts (read from the live page): .png .jpg .jpeg .webp .gif
// .heif .heic .mp4 .m4v .mov .3gp .avi  (note: NOT .webm).
const TYPES = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".heic": "image", ".heif": "image",
  ".mp4": "video", ".m4v": "video", ".mov": "video", ".3gp": "video", ".avi": "video",
};

function parseArgs(argv) {
  const out = { timeout: 120 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--path") out.path = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--confirm-rights") out.confirmRights = true;
    else if (a === "--account") out.account = argv[++i];
    else if (a === "--project") out.project = argv[++i];
  }
  return out;
}

function within(dir, file) {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Validates the file BEFORE touching the browser. Throws a message that tells the caller what to fix. */
export function resolveUploadPath(p) {
  if (!p || typeof p !== "string") throw new Error("path is required");
  let real;
  try {
    real = fs.realpathSync(p); // resolves symlinks, so a link inside uploads/ cannot point outside
  } catch {
    throw new Error(`file not found: ${p} — put the file in ${UPLOAD_DIR} and pass its full path`);
  }
  const extra = (process.env.FLOW_MCP_UPLOAD_DIRS || "").split(path.delimiter).filter(Boolean);
  const roots = [UPLOAD_DIR, DOWNLOAD_DIR, ...extra].map((d) => {
    try { return fs.realpathSync(d); } catch { return path.resolve(d); }
  });
  if (!roots.some((r) => within(r, real))) {
    throw new Error(`path must be inside ${UPLOAD_DIR} or ${DOWNLOAD_DIR} (this tool sends the file to Google, so it only reads those folders; allow more with FLOW_MCP_UPLOAD_DIRS) — got ${real}`);
  }
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error("path is not a regular file");
  if (st.size === 0) throw new Error("file is empty");
  const ext = path.extname(real).toLowerCase();
  const kind = TYPES[ext];
  if (!kind) throw new Error(`unsupported file type "${ext}" — allowed: ${Object.keys(TYPES).join(", ")}`);
  const maxMb = Number(process.env.FLOW_MCP_UPLOAD_MAX_MB || 100);
  if (st.size > maxMb * 1024 * 1024) throw new Error(`file is ${(st.size / 1048576).toFixed(1)} MB, above the ${maxMb} MB limit (FLOW_MCP_UPLOAD_MAX_MB)`);
  return { real, kind, bytes: st.size, name: path.basename(real) };
}

export function runUpload(opts = {}) {
  const file = resolveUploadPath(opts.path); // valida ANTES de esperar a trava: caminho errado falha na hora
  return comTrava("upload", () => enviar(opts, file));
}

async function enviar(opts, file) {
  // sem conta explícita: a conta ATIVA (onde a última geração aconteceu) — o arquivo gerado está nela
  const account = resolveAccount(opts.account ?? contaAtiva() ?? undefined);
  const projectUrl = opts.project
    ? opts.project.startsWith("http")
      ? opts.project
      : `https://flow.google.com/project/${opts.project}`
    : account.projectUrl;
  const cdpUrl = cdpUrlFor(account);
  const timeout = opts.timeout ?? 120;

  await aguardarVez("upload"); // pausa por "atividade incomum" + folga entre ações
  marcarUsada(account.id);

  await ensureBrowser({ cdpUrl, cdpPort: account.cdpPort, profileDir: account.profileDir, chromeExe: chromeExe(), projectUrl });

  const browser = await chromium.connectOverCDP(cdpUrl);
  const warnings = [];
  try {
    const page = pickFlowPage(browser);
    await ensureProjectHome(page, projectUrl);
    await dismissOverlays(page); // a dialog left open by an earlier failed call would make the "+" unclickable
    const before = await newestTileSignature(page);

    // Header "+" menu -> "Enviar" opens the native file chooser, which Playwright intercepts (works over CDP).
    try {
      await clicar(page, page.locator(SELECTORS.uploadMenuButton.selector).first());
      await pausa(page, 500, 1000);
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10000 }),
        clicar(page, page.getByText("Enviar", { exact: true }).first()),
      ]);
      await pausa(page, 400, 900);
      await chooser.setFiles(file.real);
      registrarAcao("upload");
    } catch (err) {
      await dismissOverlays(page);
      throw new Error(`could not open Flow's upload dialog (${err.message.split("\n")[0]}) — another dialog may be covering the page, or the "+" menu / its "Enviar" item may have changed; see healthcheck (uploadMenuButton)`);
    }

    // The new tile first shows up EMPTY (placeholder, no thumbnail) and only later gets its thumbnail:
    // wait for a non-empty thumbnail that differs from the previous newest tile.
    const deadline = Date.now() + timeout * 1000;
    let landed = null;
    let consentHandled = false;
    while (Date.now() < deadline) {
      await pausa(page, 1800, 2600);
      const texto = await page.locator("body").innerText().catch(() => "");
      const incomum = texto.match(ATIVIDADE_INCOMUM);
      if (incomum) {
        const ate = registrarAtividadeIncomum(texto.slice(Math.max(0, incomum.index - 20), incomum.index + 160));
        return { status: "blocked_unusual_activity", account: account.id, name: file.name, message: `Google Flow mostrou "atividade incomum". O mcp-flow ficou em pausa até ${new Date(ate).toISOString()}.` };
      }

      // For videos Flow asks "Direitos de uso deste vídeo" (confirm you own the rights + Google's Prohibited Use
      // Policy) and the upload does NOT proceed until answered. That is a legal attestation only the account owner can
      // make: click the plain "Concordo" ONLY when the caller passed confirmRights, otherwise cancel and report it.
      // NEVER click "Concordo, não mostrar essa mensagem de novo" — that would silence the prompt permanently.
      if (!consentHandled && (await page.getByText("Direitos de uso", { exact: false }).count())) {
        if (!opts.confirmRights) {
          const dialogText = await page.locator(".cdk-overlay-container").first().innerText().catch(() => "");
          await clicar(page, page.getByText("Cancelar", { exact: true }).last(), { timeout: 5000 }).catch(() => {});
          await dismissOverlays(page);
          return {
            status: "awaiting_consent",
            account: account.id,
            name: file.name,
            kind: file.kind,
            bytes: file.bytes,
            message:
              "Flow asks you to confirm that you have the rights to this file (and to follow Google's Prohibited Use Policy) before it accepts the upload. " +
              "That is a legal confirmation for the account owner to make: nothing was uploaded and the dialog was cancelled. " +
              "If the human confirms they have the rights, call again with confirmRights:true.",
            dialogText: dialogText.replace(/\s+/g, " ").trim().slice(0, 500),
          };
        }
        await pausa(page, 800, 1600);
        await clicar(page, page.getByText("Concordo", { exact: true }).last(), { timeout: 8000 });
        consentHandled = true;
        continue;
      }

      const now = await newestTileSignature(page);
      if (now && now.thumb && now.thumb !== before?.thumb) { landed = now; break; }
    }
    if (!landed) {
      return {
        status: "timeout",
        account: account.id,
        name: file.name,
        kind: file.kind,
        bytes: file.bytes,
        message: `The file was handed to Flow but no new tile with a thumbnail appeared within ${timeout}s. It may still finish uploading: check the gallery, or call flow_download with no assetId later to see the newest asset.`,
      };
    }
    if (landed.kind !== file.kind) warnings.push(`uploaded a ${file.kind} but the newest tile is a ${landed.kind} — another generation may have landed at the same time; verify assetId`);

    let asset = null;
    try {
      asset = await openTile(page, landed.i); // o item que acabou de chegar, não "o 1º da galeria"
    } catch (err) {
      warnings.push(`uploaded, but could not read the assetId (${err.message.split("\n")[0]})`);
    }

    return {
      status: "uploaded",
      account: account.id,
      name: file.name,
      kind: landed.kind,
      bytes: file.bytes,
      assetId: asset?.assetId ?? null,
      // The name Flow shows in the reference picker: images keep the extension ("ref.png"), videos lose it ("ref").
      // Pass this to flow_generate's `reference` (the full file name also works: it falls back to the name without extension).
      reference: landed.kind === "video" ? file.name.replace(/\.[^.]+$/, "") : file.name,
      next: `flow_generate { "reference": "${landed.kind === "video" ? file.name.replace(/\.[^.]+$/, "") : file.name}", ${asset?.assetId ? `"referenceAssetId": "${asset.assetId}", ` : ""}"prompt": "…" }`,
      warnings,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.path) {
    console.error("Usage: flow-mcp upload --path <file inside the uploads folder> [--timeout 120] [--confirm-rights] [--account ID] [--project ID]");
    process.exit(2);
  }
  try {
    const result = await runUpload(args);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "timeout" ? 1 : 0); // uploaded and awaiting_consent both exit 0: read `status`
  } catch (err) {
    console.error("FAILED:", err.message);
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === "upload.mjs";
if (isMain) main();
