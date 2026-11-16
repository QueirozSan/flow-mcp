// Reusable Google Flow generator for the agent-only composer cohort.
// Not built on gflow-cli / google-flow-mcp — those don't drive this UI
// variant at all (see README.md). This talks to a real, already-open
// Chrome via CDP and drives the chat-style composer directly.
//
// CLI usage:
//   node generate.mjs --prompt "..." [--account <id>] [--mode image|video]
//                      [--model "Veo 3.1 - Lite"] [--aspect 16:9] [--count 1]
//                      [--reference "Hot air balloon over Tokyo"]
//                      [--project <id>] [--timeout 180] [--max-credits 15]
//
// Programmatic usage (what mcp-server.mjs calls):
//   import { runGenerate } from "./generate.mjs";
//   await runGenerate({ prompt: "...", mode: "video", maxCredits: 15 });
//
// Always runs healthcheck.mjs first and refuses to touch the browser if the
// site has drifted — see README.md "Quando o site muda".
//
// Credits: in the agent-only composer Flow asks "Quer que eu inicie essa N
// geração ..., que custa X créditos?" (Aprovar / Sempre aprovar / Rejeitar)
// before spending. This tool NEVER clicks "Sempre aprovar" and only clicks
// "Aprovar" when X <= maxCredits. Without maxCredits it rejects the request
// (nothing is spent) and returns status "awaiting_approval" with the cost.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { chromeExe, resolveAccount, cdpUrlFor, projectFromInput } from "./config.mjs";
import { ensureBrowser } from "./browser.mjs";
import { UPLOAD_DIR } from "./paths.mjs";
import { runHealthcheck } from "./healthcheck.mjs";
import { aguardarVez, registrarAcao, registrarAtividadeIncomum, ATIVIDADE_INCOMUM, clicar, clicarPorIndice, escrever, pausa, afastarCursor, olharATela, lerComCalma } from "./humano.mjs";
import { SEM_CREDITO, escolherConta, marcarSemCredito, marcarUsada } from "./contas.mjs";
import { runUpload } from "./upload.mjs";
import { comTrava } from "./trava.mjs";

function parseArgs(argv) {
  const out = { mode: "image", aspect: null, count: null, model: null, reference: null, timeout: 180, account: undefined, project: undefined, maxCredits: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt") out.prompt = argv[++i];
    else if (a === "--account") out.account = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--aspect") out.aspect = argv[++i];
    else if (a === "--count") out.count = argv[++i];
    else if (a === "--reference") out.reference = argv[++i];
    else if (a === "--reference-asset") out.referenceAssetId = argv[++i];
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--max-credits") out.maxCredits = Number(argv[++i]);
  }
  return out;
}

export { ensureBrowser };

async function jsClick(page, evaluator, arg) {
  return page.evaluate(evaluator, arg); // só LEITURA: nada é escrito na página
}

// Achado 2026-09-29: os botões do Flow (Angular Material) ignoram element.click() sintético disparado de dentro da
// página; só eventos REAIS de mouse funcionam. Até 2026-10-09 o alvo era MARCADO com um atributo no HTML e depois
// clicado; isso modificava a página (o Google passou a mostrar "atividade incomum ... extensões que modificam a
// página"). Agora o alvo é localizado só lendo a página (índice) e clicado com o mouse — ver humano.mjs.

/** The Flow tab — never assume pages()[0] (Chrome may also have a sign-in popup open). */
export function pickFlowPage(browser) {
  const pages = browser.contexts().flatMap((c) => c.pages());
  return pages.find((p) => p.url().startsWith("https://flow.google.com")) || pages[0];
}

/** Go to the project's home (gallery + composer) unless we are exactly there already. */
export async function ensureProjectHome(page, projectUrl) {
  const norm = (u) => u.split("?")[0].replace(/\/$/, "");
  if (norm(page.url()) !== norm(projectUrl)) {
    await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pausa(page, 2200, 3600);
  }
}

const TILE = ".tiles-container flow-grid-tile-container";

/**
 * Retrato dos primeiros itens da galeria (o mais novo é o 1º). Achados de 2026-10-26:
 * - com o cursor PARADO sobre um vídeo, o Flow troca a <img> da miniatura por uma prévia <video> — por isso o cursor
 *   sai de cima antes de ler (afastarCursor) e a identidade aceita o poster/src do vídeo;
 * - um vídeo ainda na fila aparece no topo SEM mídia nenhuma (temMidia:false) — não é o resultado de ninguém ainda;
 * - edição com referência (ex.: Omni editando um vídeo enviado) NÃO cria item novo: vira uma versão nova do item da
 *   referência (ícone "stacks"), que muda de miniatura.
 */
export async function tileSnapshot(page, max = 12) {
  await afastarCursor(page);
  return page.evaluate(({ sel, max }) => [...document.querySelectorAll(sel)].slice(0, max).map((t, i) => {
    const img = t.querySelector("img"), vid = t.querySelector("video");
    const thumb = img?.getAttribute("src") || vid?.getAttribute("poster") || vid?.getAttribute("src") || null;
    return { i, thumb, temMidia: Boolean(thumb), kind: t.querySelector("flow-video-tile") ? "video" : "image", versoes: (t.innerText || "").includes("stacks") };
  }), { sel: TILE, max });
}

/** Identity of the newest gallery tile that already has media (its thumbnail URL). */
export async function newestTileSignature(page) {
  const s = await tileSnapshot(page);
  return s.find((t) => t.temMidia) ?? null;
}

/** Abre o item de índice `i` da galeria (clicando no item inteiro, não na <img>, que some no hover). */
export async function openTile(page, i) {
  const snap = await tileSnapshot(page);
  await clicar(page, page.locator(TILE).nth(i));
  await page.waitForURL(/\/edit\//, { timeout: 15000 });
  return { assetId: page.url().split("?")[0].split("/edit/")[1], kind: snap.find((t) => t.i === i)?.kind ?? null };
}

/** Opens the newest tile that already has media (skips videos still in the queue) and returns its asset id. */
export async function openNewestTile(page) {
  const alvo = await newestTileSignature(page);
  if (!alvo) throw new Error("no gallery tile with media yet (newest items may still be in the queue)");
  return openTile(page, alvo.i);
}

/**
 * Depois de uma geração: o item cuja miniatura NÃO existia antes (item novo ou versão nova de um item antigo).
 * Exportado para teste.
 */
export function acharMudanca(antes, agora) {
  const vistos = new Set(antes.map((t) => t.thumb).filter(Boolean));
  return agora.find((t) => t.temMidia && !vistos.has(t.thumb)) ?? null;
}

async function openSettingsAndConfigure(page, { mode, model, aspect, count, targetKind }) {
  const warnings = [];
  if (!mode && !model && !aspect && !count) return { warnings, selectedModel: null };
  // O Flow atual expõe o botão visível como "Configurações" e ainda
  // mantém um gatilho legado oculto no DOM. Nunca marque/click o oculto.
  const settingsTrigger = page
    .locator("button[aria-label='Configurações']:visible, button[aria-label='Gatilho de configurações']:visible")
    .first();
  if ((await settingsTrigger.count()) === 0) throw new Error("visible settings trigger not found — see healthcheck");
  await clicar(page, settingsTrigger);
  await pausa(page, 800, 1500);

  if (mode) {
    const label = mode === "video" ? "Vídeo" : "Imagem";
    const modeClicked = await clicarPorIndice(page, "button, [role='radio']", ({ seletor, l }) =>
      Array.from(document.querySelectorAll(seletor)).findIndex((b) => (b.textContent || "").includes(l) && !(b.textContent || "").includes(l + "s")), { l: label });
    if (!modeClicked) warnings.push(`mode "${mode}" toggle not found in the settings panel — in this composer the Flow agent decides image vs video from the prompt text (see promptSent)`);
    await pausa(page, 600, 1100);
  }

  if (model) {
    const modelPickerLabel = targetKind === "video"
      ? "Modelo padrão de geração de vídeo"
      : "Modelo padrão de geração de imagens";
    const modelPicker = page.locator(`button[aria-label='${modelPickerLabel}']:visible`).first();
    if (await modelPicker.count()) {
      await clicar(page, modelPicker);
      await pausa(page, 600, 1100);
      const normalizeModel = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const requestedModel = normalizeModel(model);
      const menuItems = await page.getByRole("menuitem").all();
      let selectedItem = null;
      for (const item of menuItems) {
        const label = (await item.innerText()).trim();
        if (normalizeModel(label) === requestedModel) {
          selectedItem = { item, label };
          break;
        }
      }
      if (selectedItem) {
        await clicar(page, selectedItem.item);
        await pausa(page, 600, 1100);
      } else {
        warnings.push(`model "${model}" not found in the video/image model menu — the previous/default model stays selected`);
      }
    } else {
      warnings.push(`model picker "${modelPickerLabel}" not found — model not applied`);
    }
  }

  if (aspect) {
    // The toggle's text is "<icon-name><ratio>" (e.g. "crop_9_169:16"), so match the END of the text.
    const aspectClicked = await clicarPorIndice(page, "button, [role='radio']", ({ seletor, asp, targetKind }) => {
      const els = Array.from(document.querySelectorAll(seletor));
      const idx = els.map((b, i) => ((b.textContent || "").trim().endsWith(asp) ? i : -1)).filter((i) => i >= 0);
      return idx.length ? (targetKind === "video" ? idx.at(-1) : idx[0]) : -1;
    }, { asp: aspect, targetKind });
    if (!aspectClicked) warnings.push(`aspect "${aspect}" not offered for the selected mode/model — default aspect stays`);
    await pausa(page, 400, 900);
  }

  if (count) {
    const countClicked = await clicarPorIndice(page, "button, [role='radio']", ({ seletor, c }) =>
      Array.from(document.querySelectorAll(seletor)).findIndex((b) => (b.textContent || "").trim() === `x${c}`), { c: count });
    if (!countClicked) warnings.push(`count x${count} not offered — default count stays`);
    await pausa(page, 400, 900);
  }

  // What is really selected now (so the caller can verify instead of trusting the request).
  // Read-only — no click involved, so the raw evaluate is fine here.
  const selectedModel = await jsClick(page, (kind) => {
    const preferredLabel = kind === "video" ? "Modelo padrão de geração de vídeo" : "Modelo padrão de geração de imagens";
    const t = document.querySelector(`button[aria-label='${preferredLabel}']`)
      || Array.from(document.querySelectorAll("button, [role='button']")).find((b) => (b.textContent || "").includes("arrow_drop_down"));
    return t ? (t.textContent || "").replace("arrow_drop_down", "").trim() : null;
  }, targetKind);
  const normalizeModel = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (model && selectedModel && !normalizeModel(selectedModel).includes(normalizeModel(model))) {
    warnings.push(`requested model "${model}" but the menu shows "${selectedModel}"`);
  }

  const saveButton = page.locator("button.settings-save-button:visible").first();
  if ((await saveButton.count()) > 0) await clicar(page, saveButton);
  else await page.keyboard.press("Escape");
  await pausa(page, 400, 900);
  return { warnings, selectedModel };
}

async function attachReference(page, referenceName) {
  // Achado 2026-10-07: o Flow mantém um botão "Adicionar elementos à caixa de comando" OCULTO antes do visível
  // (mesmo padrão do gatilho de Configurações). Clique só o visível.
  const addBtn = page.locator("button[aria-label='Adicionar elementos à caixa de comando']:visible").first();
  if ((await addBtn.count()) === 0) throw new Error("visible add-reference button not found — see healthcheck");
  await clicar(page, addBtn);
  await pausa(page, 1000, 1800);
  // Flow shows an uploaded IMAGE with its extension ("ref.png") but an uploaded VIDEO without it ("ref"), so try the
  // exact name first (what always worked) and then the name without its extension.
  const candidates = [...new Set([referenceName, referenceName.replace(/\.[A-Za-z0-9]{2,5}$/, "")])];
  const picked = await clicarPorIndice(page, "button, [role='button'], li, div[tabindex]", ({ seletor, names }) => {
    // só elementos VISÍVEIS (o Flow deixa cópias ocultas no DOM; o clique real do Playwright espera por elas e expira)
    const visivel = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
    const els = Array.from(document.querySelectorAll(seletor)).map((el, i) => ({ el, i })).filter((x) => visivel(x.el));
    for (const name of names) {
      // The picker's item button has the SHORTEST text that contains the name; a wrapper containing the whole list
      // also matches, and clicking it does nothing.
      const matches = els.filter((x) => (x.el.textContent || "").includes(name)).sort((a, b) => a.el.textContent.length - b.el.textContent.length);
      if (matches[0]) return matches[0].i;
    }
    return -1;
  }, { names: candidates });
  if (!picked) {
    await dismissOverlays(page); // never leave the picker dialog open: it would block the NEXT call
    throw new Error(`reference "${referenceName}" not found in the asset picker — upload it first with flow_upload (references are matched by file name)`);
  }
  await pausa(page, 600, 1100);
  // The picker is a dialog: clicking an item only PREVIEWS it. "Incluir no comando" is what attaches it to the
  // prompt (and closes the dialog). Without this click the request goes out with NO reference.
  const include = page.getByText("Incluir no comando", { exact: true });
  if (await include.count()) {
    await clicar(page, include.first(), { timeout: 8000 });
    await pausa(page, 800, 1500);
  }
}

/** Closes a leftover menu/dialog (e.g. the reference picker after a failed run) so it cannot block the next call. */
export async function dismissOverlays(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  // Some dialogs ignore Escape (e.g. the "Direitos de uso" upload consent). If anything is still in the overlay layer,
  // reload the page: that discards any dialog, and every caller starts from the project home anyway.
  const stuck = await page
    .evaluate(() => (document.querySelector(".cdk-overlay-container")?.innerText || "").trim().length > 0)
    .catch(() => false);
  if (stuck) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
}

const COST_RE = /custa\s+(\d+)\s+cr[eé]dit/gi;

/**
 * Every generation gets a FRESH chat session. The agent may answer late, and an old
 * approval prompt sitting in a reused chat could be mistaken for the current request's.
 * The header's "new session" control is an icon-only button whose text is "edit_square".
 */
async function startNewSession(page) {
  const found = await clicarPorIndice(page, "button", ({ seletor }) =>
    Array.from(document.querySelectorAll(seletor)).findIndex((x) => (x.textContent || "").trim() === "edit_square"));
  await pausa(page, 1200, 2200);
  return found;
}

async function submitAndWait(page, prompt, timeoutSeconds, { maxCredits, conta } = {}) {
  // Old approval prompts stay in the chat; only a NEW "Aprovar" row belongs to this request.
  const approveRowsBefore = await page.getByText("Aprovar", { exact: true }).count();

  const box = page.locator("div.ProseMirror[contenteditable='true']").first();
  if ((await box.count()) === 0) throw new Error("prompt box not found — see healthcheck");
  await clicar(page, box);
  await escrever(page, prompt); // como quem cola o prompt (antes: 12 ms por letra, ritmo impossível para uma pessoa)

  const submit = page.locator("button[aria-label='Iniciar geração']").first();
  if ((await submit.count()) === 0) throw new Error(`submit button was "not_found" — see healthcheck`);
  if (await submit.isDisabled()) throw new Error(`submit button was "disabled" — see healthcheck`);
  await clicar(page, submit);
  registrarAcao("generate", { conta });
  await afastarCursor(page); // esperar com o cursor fora da galeria (vídeo sob o cursor vira prévia e some a miniatura)

  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastProgress = null;
  let approval = null; // { cost }
  while (Date.now() < deadline) {
    await pausa(page, 2400, 4200); // quem acompanha olha de tempos em tempos, não a cada 3000 ms exatos
    const bodyText = await page.locator("body").innerText();

    // O Google desconfiou da automação: PARA aqui e pausa o Flow (insistir só piora)
    const incomum = bodyText.match(ATIVIDADE_INCOMUM);
    if (incomum) {
      const ate = registrarAtividadeIncomum(bodyText.slice(Math.max(0, incomum.index - 20), incomum.index + 160));
      return {
        status: "blocked_unusual_activity",
        finished: false,
        lastProgress,
        cost: approval?.cost ?? null,
        message: `Google Flow mostrou "atividade incomum". O mcp-flow ficou em pausa até ${new Date(ate).toISOString()} — não tente de novo antes disso.`,
      };
    }

    // a conta ficou sem créditos (antes de aprovar = nada foi gasto): runGenerate passa para a próxima conta da ordem
    const semCredito = !approval && bodyText.match(SEM_CREDITO);
    if (semCredito) {
      return {
        status: "no_credits",
        finished: false,
        lastProgress,
        cost: null,
        message: "Flow disse que a conta não tem créditos suficientes. Nada foi gasto.",
        agentMessage: bodyText.slice(Math.max(0, semCredito.index - 60), semCredito.index + 160).replace(/\s+/g, " ").trim(),
      };
    }

    const knownGenerationFailure = bodyText.match(/Falha ao gerar áudio\. Tente usar outro comando ou envie feedback\./i);
    if (knownGenerationFailure) {
      return {
        status: "failed",
        finished: false,
        lastProgress,
        cost: approval?.cost ?? null,
        message: "Flow reported an audio-generation failure; its UI confirmed no charge for this attempt.",
        agentMessage: knownGenerationFailure[0]
      };
    }

    if (!approval && (await page.getByText("Aprovar", { exact: true }).count()) > approveRowsBefore) {
      const costs = [...bodyText.matchAll(COST_RE)];
      const cost = costs.length ? Number(costs[costs.length - 1][1]) : null;
      const allowed = Number.isFinite(maxCredits) && cost !== null && cost <= maxCredits;
      if (!allowed) {
        // Nothing was spent: reject the pending request so the chat is left clean.
        await clicar(page, page.getByText("Rejeitar", { exact: true }).last()).catch(() => {});
        return {
          status: "awaiting_approval",
          finished: false,
          lastProgress: null,
          cost,
          maxCredits: Number.isFinite(maxCredits) ? maxCredits : null,
          message:
            cost === null
              ? "Flow asked for approval but the cost could not be read, and this tool never approves an unknown cost. Nothing was spent."
              : `Flow needs approval to spend ${cost} credits. Nothing was spent. Call again with maxCredits >= ${cost} to approve.`,
        };
      }
      // uma pessoa LÊ a mensagem do custo antes de aprovar (tempo proporcional ao texto)
      const pergunta = [...bodyText.matchAll(/[^\n]*custa\s+\d+\s+cr[eé]dit[^\n]*/gi)].at(-1)?.[0] ?? "";
      await lerComCalma(page, pergunta);
      await clicar(page, page.getByText("Aprovar", { exact: true }).last());
      await afastarCursor(page);
      approval = { cost };
      continue;
    }

    const m = bodyText.match(/(\d{1,3})%/);
    if (m) {
      lastProgress = m[1];
    } else if (lastProgress !== null) {
      return { status: "finished", finished: true, lastProgress, cost: approval?.cost ?? null };
    }
  }
  // If the Flow agent ANSWERED WITH TEXT instead of starting (e.g. "this model cannot use a video as a reference"),
  // that text is the real reason for the timeout — surface it.
  const agentMessage = lastProgress === null ? await readAgentReply(page, prompt) : null;
  if (agentMessage && SEM_CREDITO.test(agentMessage)) {
    return { status: "no_credits", finished: false, lastProgress, cost: null, message: "Flow disse (no chat) que a conta não tem créditos suficientes. Nada foi gasto.", agentMessage };
  }
  return {
    status: "timeout",
    finished: false,
    lastProgress,
    cost: approval?.cost ?? null,
    message: agentMessage
      ? "Flow's agent replied in text instead of generating — read agentMessage (nothing was spent). Typical causes: the chosen model cannot do what was asked (e.g. Veo Lite cannot use a video as a reference), or it needs a decision from you."
      : lastProgress === null
        ? "Timed out without ever seeing generation progress — the request may not have started (check the Flow UI for a pending approval)."
        : `Timed out while generating (last progress ${lastProgress}%). It may still finish; check the gallery or call flow_download later.`,
    ...(agentMessage ? { agentMessage } : {}),
  };
}

/** The text the Flow agent wrote in reply to our prompt (chat lines after it, up to the feedback icons), or null. */
async function readAgentReply(page, prompt) {
  try {
    const lines = (await page.locator("body").innerText()).split("\n").map((s) => s.trim()).filter(Boolean);
    const key = prompt.slice(0, 40);
    let i = -1;
    for (let k = lines.length - 1; k >= 0; k--) if (lines[k].includes(key)) { i = k; break; }
    if (i < 0) return null;
    const out = [];
    for (const l of lines.slice(i + 1)) {
      if (/^(thumb_up|thumb_down|content_copy|flag)$/.test(l)) break;
      if (/^(Mostrar raciocínio|arrow_forward_ios)$/.test(l)) continue;
      out.push(l);
    }
    const text = out.join(" ").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 700) : null;
  } catch {
    return null;
  }
}

/**
 * The core tool, callable from the CLI (main() below) or from any other
 * integration — mcp-server.mjs calls this directly instead of shelling out,
 * so the CLI and the plugin can never drift apart into two implementations
 * of the same generation logic.
 */
/**
 * Gera na conta escolhida e, SÓ se ela estiver sem créditos, passa para a próxima da ordem (accounts.json "ordem").
 * Com `account` explícito não troca. A referência é reenviada para a conta nova (se o arquivo ainda estiver em uploads/).
 */
export function runGenerate(opts) {
  if (!opts.prompt) throw new Error("prompt is required");
  return comTrava("generate", () => gerarComTroca(opts));
}

async function gerarComTroca(opts) {
  const explicita = Boolean(opts.account);
  const tentadas = [];
  let conta = explicita ? opts.account : escolherConta();
  let referencia = opts.reference;
  for (;;) {
    tentadas.push(conta);
    const r = await gerarNaConta({ ...opts, account: conta, reference: referencia });
    if (r.status !== "no_credits" || explicita) return { ...r, contasTentadas: tentadas };
    marcarSemCredito(conta);
    let proxima;
    try { proxima = escolherConta({ excluir: tentadas }); } catch (e) { return { ...r, contasTentadas: tentadas, message: `${r.message} ${e.message}` }; }
    if (referencia) {
      const arquivo = path.join(UPLOAD_DIR, referencia);
      const comExt = fs.existsSync(arquivo) ? arquivo : (fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : []).map((f) => path.join(UPLOAD_DIR, f)).find((f) => path.basename(f).replace(/\.[^.]+$/, "") === referencia);
      if (!comExt) return { ...r, contasTentadas: tentadas, message: `${r.message} A próxima conta (${proxima}) não tem a referência "${referencia}" e o arquivo já saiu de uploads/: envie de novo com flow_upload (account "${proxima}") e repita.` };
      const up = await runUpload({ path: comExt, account: proxima });
      if (up.status !== "uploaded") return { ...r, contasTentadas: tentadas, message: `${r.message} Falhou ao reenviar a referência para ${proxima}: ${up.status}.` };
      referencia = up.reference;
    }
    conta = proxima;
  }
}

async function gerarNaConta(opts) {
  const account = resolveAccount(opts.account);
  const projectUrl = opts.project ? projectFromInput(opts.project) : account.projectUrl;
  const cdpUrl = cdpUrlFor(account);

  // ritmo: pausa por "atividade incomum", limites saudáveis do servidor e intervalo mínimo (espera o que faltar)
  await aguardarVez("generate");
  marcarUsada(account.id); // a download/upload that follows goes to the same account

  await ensureBrowser({ cdpUrl, cdpPort: account.cdpPort, profileDir: account.profileDir, chromeExe: chromeExe(), projectUrl });

  const health = await runHealthcheck({ account: account.id, projectUrl, quiet: opts.quiet });
  if (!health.ok) {
    throw new Error(`site drift detected for account "${account.id}" — see ${health.logFile || "logs/"}`);
  }

  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const page = pickFlowPage(browser);
    await ensureProjectHome(page, projectUrl);
    await dismissOverlays(page);
    await olharATela(page);

    const freshSession = await startNewSession(page);

    // The composer is a chat agent: it picks image vs video AND the video model from the WORDS of the
    // request (verified: naming "Veo 3.1 Lite" makes Flow quote 10 credits instead of the default 15).
    // The settings panel only lists image models and has no reachable video toggle, so for video the
    // mode/model/count go into the prompt instead of the panel.
    const isVideo = opts.mode === "video";
    // vídeo: o modelo vai SÓ no texto (o painel não tem seletor de modelo de vídeo — tentar gerava o aviso falso
    // "model picker … not found" em toda chamada de vídeo, inclusive quando o Omni foi usado de fato)
    const panelOpts = isVideo
      ? { aspect: opts.aspect, targetKind: "video" }
      : { ...opts, mode: undefined, targetKind: "image" }; // mode is decided by the prompt, not the panel
    const { warnings, selectedModel } = await openSettingsAndConfigure(page, panelOpts);
    if (!freshSession) warnings.push("could not open a fresh chat session — old chat messages remain; approvals are matched by count");
    // várias referências: nomes separados por "|" (ex.: vídeo de movimento + ícones que têm de aparecer fiéis)
    if (opts.reference) for (const nome of String(opts.reference).split("|").map((s) => s.trim()).filter(Boolean)) await attachReference(page, nome);

    let prompt = opts.prompt;
    if (isVideo) {
      const model = opts.model ? String(opts.model).replace(/\s*-\s*/g, " ").trim() : null;
      const already = /\b(v[ií]deo|video|clip)\b/i.test(prompt);
      prompt = `${already ? "" : "Generate a video: "}${model ? `Using the ${model} model, ` : ""}${prompt}`;
    }

    const before = await tileSnapshot(page);
    const result = await submitAndWait(page, prompt, opts.timeout ?? 180, { maxCredits: opts.maxCredits, conta: account.id });

    let asset = null;
    if (result.status === "finished") {
      // o resultado = o item cuja miniatura não existia antes (item novo OU versão nova do item da referência)
      let mudou = null;
      for (let i = 0; i < 20 && !mudou; i++) {
        mudou = acharMudanca(before, await tileSnapshot(page));
        if (!mudou) await pausa(page, 2500, 4500);
      }
      if (mudou) {
        asset = await openTile(page, mudou.i).catch((e) => ({ error: e.message }));
        if (asset && mudou.versoes) asset.newVersion = true; // a edição entrou como versão nova: flow_download baixa a mais recente
      } else if (opts.referenceAssetId) {
        asset = { assetId: opts.referenceAssetId, kind: null, newVersion: true, inferred: true };
        warnings.push("no new tile appeared: with a reference, Flow usually saves the edit as a NEW VERSION of the reference asset — returning referenceAssetId (flow_download takes its newest version); verify the file");
      } else {
        warnings.push(opts.reference
          ? "generation finished but no new tile appeared — with a reference, Flow may have saved it as a new VERSION of the reference asset: call flow_download with the assetId flow_upload returned"
          : "generation finished but no new tile appeared in the gallery yet — call flow_download later");
      }
    }

    return { account: account.id, projectUrl, promptSent: prompt, ...result, selectedModel, warnings, asset };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.prompt) {
    console.error(
      'Usage: node generate.mjs --prompt "..." [--account ID] [--mode image|video] [--model NAME] [--aspect 16:9] [--count 1] [--reference NAME] [--project ID] [--timeout SECONDS] [--max-credits N]'
    );
    process.exit(2);
  }
  console.log("Running healthcheck before touching anything...");
  try {
    const result = await runGenerate(args);
    console.log("\nResult:", JSON.stringify(result, null, 2));
    if (result.status === "finished") console.log("Save the file with: flow-mcp download [--asset <id>]");
    process.exit(result.status === "timeout" ? 1 : 0);
  } catch (err) {
    console.error("\nFAILED:", err.message);
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === "generate.mjs";
if (isMain) main();
