// Creates a NEW Google Flow project OR continues a previously managed one, and writes/updates the three
// "Instruções para o agente" cards before any generation prompt. Selectors confirmed live against a real pt-BR Chrome.

import { chromium } from "playwright-core";
import { chromeExe, resolveAccount, cdpUrlFor } from "./config.mjs";
import { ensureBrowser, pickFlowPage } from "./generate.mjs";
import { comTrava } from "./trava.mjs";

const preparedByIdempotencyKey = new Map();

function normalizeInstructions(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("instructions must contain exactly 3 items");
  }
  const seenTitles = new Set();
  return value.map((item, index) => {
    const title = String(item?.title || "").trim();
    const description = String(item?.description || "").trim();
    if (!title || title.length > 120) throw new Error(`instructions[${index}].title is invalid`);
    if (description.length < 40 || description.length > 4000) {
      throw new Error(`instructions[${index}].description must have 40-4000 characters`);
    }
    if (seenTitles.has(title)) throw new Error(`duplicate instruction title: ${title}`);
    seenTitles.add(title);
    return { title, description };
  });
}

function projectIdFromUrl(url) {
  return String(url).match(/\/project\/([a-z0-9-]+)/i)?.[1] || null;
}

export function runPrepareProject(opts = {}) {
  return comTrava("prepare_project", () => preparar(opts));
}

async function preparar(opts) {
  const instructions = normalizeInstructions(opts.instructions);
  const action = opts.action === "continue" ? "continue" : "new";
  const existingProject = String(opts.project || "").trim();
  if (action === "continue" && !/^https:\/\/flow\.google\.com\/project\/[a-z0-9-]+/i.test(existingProject)) {
    throw new Error("project must be a valid Flow project URL when action=continue");
  }
  const account = resolveAccount(opts.account);
  const cacheKey = opts.idempotencyKey ? `${account.id}:${action}:${String(opts.idempotencyKey)}` : null;
  if (cacheKey && preparedByIdempotencyKey.has(cacheKey)) {
    return { ...preparedByIdempotencyKey.get(cacheKey), reused: true };
  }

  const cdpUrl = cdpUrlFor(account);
  await ensureBrowser({
    cdpUrl,
    cdpPort: account.cdpPort,
    profileDir: account.profileDir,
    chromeExe: chromeExe(),
    projectUrl: account.projectUrl
  });

  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const page = pickFlowPage(browser);
    if (action === "new") {
      await page.goto("https://flow.google.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.locator("button.new-project-button").waitFor({ state: "visible", timeout: 20000 });
      await page.locator("button.new-project-button").click({ timeout: 10000 });
      await page.waitForURL(/\/project\/[a-z0-9-]+/i, { timeout: 30000 });
    } else {
      await page.goto(existingProject, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForURL(/\/project\/[a-z0-9-]+/i, { timeout: 30000 });
    }
    await page.locator("div.ProseMirror[contenteditable='true']").waitFor({ state: "attached", timeout: 20000 });

    const projectUrl = page.url().split("?")[0];
    const projectId = projectIdFromUrl(projectUrl);
    if (!projectId) throw new Error(`Flow did not expose a valid project URL: ${projectUrl}`);

    await page.getByRole("button", { name: "Instruções para o agente", exact: true }).click({ timeout: 10000 });
    const addButton = page.locator("button.add-instruction-button");
    await addButton.waitFor({ state: "visible", timeout: 10000 });

    const titleInputs = page.locator("input[placeholder='Título da instrução']");
    const descriptionInputs = page.locator("textarea[aria-label='Descrição da instrução']");
    if (action === "continue") {
      const currentTitles = await titleInputs.evaluateAll((elements) => elements.map((element) => element.value));
      const expectedTitles = instructions.map((item) => item.title);
      if (currentTitles.length !== 3 || !expectedTitles.every((title, index) => currentTitles[index] === title)) {
        throw new Error(`existing project instructions are not the ones this tool manages: titles=${JSON.stringify(currentTitles)}`);
      }
    }

    for (let index = 0; index < instructions.length; index++) {
      if (action === "new") await addButton.click({ timeout: 10000 });
      await titleInputs.nth(index).waitFor({ state: "visible", timeout: 10000 });
      await descriptionInputs.nth(index).waitFor({ state: "visible", timeout: 10000 });
      await titleInputs.nth(index).fill(instructions[index].title);
      // O componente Angular só confirma o título com Enter; blur/Tab descarta o valor.
      await titleInputs.nth(index).press("Enter");
      await descriptionInputs.nth(index).fill(instructions[index].description);

      const switches = page.locator("button[role='switch'][aria-label='Ativar/desativar instrução']");
      const currentSwitch = switches.nth(index);
      if ((await currentSwitch.getAttribute("aria-checked")) === "false") {
        await currentSwitch.click({ timeout: 10000 });
      }
    }

    await page.locator("button.done-button").click({ timeout: 10000 });
    await page.waitForTimeout(800);

    // Reabre e lê os valores salvos: só retornar sucesso depois de comprovar os 3 cards.
    await page.getByRole("button", { name: "Instruções para o agente", exact: true }).click({ timeout: 10000 });
    const savedTitles = await page
      .locator("input[placeholder='Título da instrução']")
      .evaluateAll((elements) => elements.map((element) => element.value));
    const savedDescriptions = await page
      .locator("textarea[aria-label='Descrição da instrução']")
      .evaluateAll((elements) => elements.map((element) => element.value));
    const verified = instructions.every((item, index) => savedTitles[index] === item.title && savedDescriptions[index] === item.description);
    if (!verified || savedTitles.length !== 3 || savedDescriptions.length !== 3) {
      throw new Error(`instruction verification failed: titles=${savedTitles.length}, descriptions=${savedDescriptions.length}`);
    }
    await page.locator("button.done-button").click({ timeout: 10000 });

    const result = {
      status: "prepared",
      account: account.id,
      projectId,
      projectUrl,
      instructionsApplied: 3,
      titles: savedTitles,
      action,
      reused: false
    };
    if (cacheKey) preparedByIdempotencyKey.set(cacheKey, result);
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}
