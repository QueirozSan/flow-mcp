// The MCP server (stdio). It exposes this package's browser-automation capability to any MCP client (Claude Code,
// Claude Desktop, Cursor, Codex, ...). It imports the exact same functions the CLI uses — there is only one
// implementation of the logic; this is just a second way to call it.
//
// Register it with `flow-mcp install` (see the README). NOTHING may be written to stdout here: stdout is the protocol.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runGenerate } from "./generate.mjs";
import { runPrepareProject } from "./project.mjs";
import { runDownload } from "./download.mjs";
import { runUpload } from "./upload.mjs";
import { runHealthcheck } from "./healthcheck.mjs";
import { listAccounts } from "./config.mjs";
import { UPLOAD_DIR } from "./paths.mjs";
import { estadoContas, ordemContas } from "./contas.mjs";
import { lerEstado as lerRitmo, proximaVaga, RITMO } from "./humano.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
const GUIDE_PATH = path.join(__dirname, "..", "docs", "GUIDE.md");

// Shown to every agent that connects, before it calls anything. Keep it short:
// the full manual is the `flow://guide` resource (AGENT_GUIDE.md).
const INSTRUCTIONS =
  "Google Flow image/video generator. Typical order: flow_healthcheck -> flow_generate -> flow_download. " +
  "IMAGES ARE FREE, VIDEOS COST CREDITS. flow_generate never spends credits unless you pass maxCredits >= the cost: " +
  "without it a video request returns status 'awaiting_approval' with the cost and nothing is spent. Read `status` " +
  "(finished | awaiting_approval | timeout) and `warnings` in every result; do not assume success. " +
  "Calls block until done (a video takes ~1-3 min): if your MCP client has a short per-call timeout (the TypeScript " +
  "SDK defaults to 60 s) raise it to at least 10 minutes. The server runs ONE browser action at a time (a server-wide lock): a call made while " +
  "another is running waits up to 20 min, then fails with 'Flow ocupado'. When you EDIT your own uploaded file, pass " +
  "flow_upload's assetId as referenceAssetId: Flow saves such edits as a new version of that asset. " +
  "To use YOUR OWN image/video as a reference: put the file in the uploads folder (see flow_upload), call flow_upload " +
  "{path} (free), then flow_generate {reference: <name returned>}. " +
  "FILES: flow_download saves into the downloads folder on THIS computer and returns the full path. " +
  "Read the resource flow://guide for the full manual.";

const server = new McpServer({ name: "flow-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerResource(
  "agent-guide",
  "flow://guide",
  {
    title: "flow-mcp agent guide",
    description: "Complete manual: every tool, parameters, results, costs, errors and the generate->download->publish flow.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: fs.readFileSync(GUIDE_PATH, "utf8") }],
  })
);

server.registerTool(
  "flow_list_accounts",
  {
    title: "List configured Google Flow accounts",
    description:
      "Lists the connected Flow accounts (added with `flow-mcp login`) with their place in the usage ORDER, whether it is the " +
      "one used last and whether it is marked out of credits (skipped until semCreditoAte). Also shows the " +
      "healthy generation limits and when the next generation slot opens. If it returns no accounts, the human must run " +
      "`flow-mcp login` in a terminal first.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const estado = Object.fromEntries(estadoContas().map((x) => [x.conta, x]));
    const ordem = ordemContas();
    const contas = listAccounts().map((a) => ({ ...a, ordem: ordem.indexOf(a.id) + 1 || null, ativa: estado[a.id]?.ativa ?? false, semCreditoAte: estado[a.id]?.semCreditoAte ?? null }));
    const r = lerRitmo();
    const agora = Date.now();
    const ritmo = { limites: { por10min: RITMO.max10min, porHora: RITMO.maxPorHora, porDia: RITMO.maxPorDia }, proximaVaga: new Date(Math.max(agora, proximaVaga(r, agora))).toISOString(), pausadoAte: r.bloqueadoAte > agora ? new Date(r.bloqueadoAte).toISOString() : null };
    return { content: [{ type: "text", text: JSON.stringify({ contas, ritmo }, null, 2) }] };
  }
);

server.registerTool(
  "flow_healthcheck",
  {
    title: "Check whether Google Flow's UI still matches what this tool expects",
    description:
      "Live-checks every selector this tool depends on against the real page. Run this before trusting flow_generate " +
      "not to fail confusingly, or on a schedule to get alerted the same day Google changes something.",
    inputSchema: { account: z.string().optional().describe("Account id from flow_list_accounts. Defaults to the configured default account.") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ account }) => {
    const result = await runHealthcheck({ account, quiet: true });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: !result.ok,
    };
  }
);

server.registerTool(
  "flow_prepare_project",
  {
    title: "Prepare a new or existing Flow project with three agent instructions",
    description:
      "Creates a NEW Google Flow project or CONTINUES a previously managed one, writes exactly three enabled " +
      "'Instruções para o agente' cards, verifies their persisted title/content, and returns projectUrl. " +
      "Call exactly once before flow_generate; reuse the returned " +
      "projectUrl in quote, approval and download. idempotencyKey prevents duplicate projects while this MCP process lives.",
    inputSchema: {
      action: z.enum(["new", "continue"]).optional().describe("Defaults to new. continue requires project."),
      project: z.string().url().optional().describe("Existing https://flow.google.com/project/... URL required for action=continue."),
      instructions: z.array(z.object({
        title: z.string().min(1).max(120),
        description: z.string().min(40).max(4000)
      })).length(3),
      idempotencyKey: z.string().min(1).optional(),
      account: z.string().optional().describe("Account id from flow_list_accounts. Defaults to the configured default account.")
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await runPrepareProject(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `FAILED: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "flow_generate",
  {
    title: "Generate an image or video via Google Flow",
    description:
      "Drives Google Flow's chat-style composer directly (works even on accounts stuck in the 'agent-only' composer " +
      "cohort, where Flow exposes no classic settings panel — see README.md). Runs a healthcheck first and refuses " +
      "to proceed if the site has drifted. Video generation spends real Flow credits; image generation is free. " +
      "Blocks until the generation finishes or times out — there is no separate poll step in this version. " +
      "CREDITS: Flow asks for approval before spending. This tool approves ONLY if the shown cost <= maxCredits; " +
      "without maxCredits it rejects the request, spends nothing and returns status 'awaiting_approval' with the cost " +
      "so you (or a human) can decide. It never uses Flow's 'always approve'. " +
      "RESULT: check `status` — 'finished' (asset.assetId identifies the new file; pass it to flow_download), " +
      "'awaiting_approval' (nothing spent), 'no_credits' (every account in the order is out of credits; nothing spent), " +
      "'blocked_unusual_activity' (Google flagged automation: the server pauses for hours — do NOT retry) or 'timeout' (isError). " +
      "Generations follow server-wide healthy limits (see flow_list_accounts); above them the call waits briefly or refuses with the next slot. " +
      "Always read `warnings`, `selectedModel` and `contasTentadas`.",
    inputSchema: {
      prompt: z.string().min(1).describe("What to generate."),
      account: z.string().optional().describe("Account id from flow_list_accounts. Omit to use the ORDER: first account with credits; if Flow says it has no credits, the next one is used (only then — never to dodge limits)."),
      mode: z.enum(["image", "video"]).optional().describe("Defaults to image (free)."),
      model: z.string().optional().describe('e.g. "Veo 3.1 - Lite" (cheapest video model), "Veo 3.1 - Fast", "Veo 3.1 - Quality", "Omni 1.1 Flash".'),
      aspect: z.string().optional().describe("e.g. 16:9, 9:16, 1:1, 4:3, 3:4 — only the ratios Flow currently offers for the selected mode."),
      count: z.number().int().min(1).max(4).optional(),
      reference: z.string().optional().describe("Name of an existing asset already in the project to attach as a reference (as shown in the Flow project gallery). For your own file, upload it first with flow_upload and pass the `reference` name it returns (the file name, e.g. \"ref.png\")."),
      referenceAssetId: z.string().optional().describe("The assetId flow_upload returned for `reference`. Pass it when EDITING your own file (e.g. Omni editing an uploaded video): Flow saves such edits as a NEW VERSION of the reference asset instead of a new gallery tile, and this id is then returned as asset.assetId (flow_download takes the newest version)."),
      project: z.string().optional().describe("Flow project id or full URL. Defaults to the account's configured project."),
      timeout: z.number().int().min(10).max(1800).optional().describe("Seconds to wait for completion. Default 180. Videos usually need 60-200s; use 300 to be safe."),
      maxCredits: z.number().int().min(0).optional().describe("Highest credit cost you authorize for THIS call. Omit to authorize nothing (video requests then return awaiting_approval). Images cost 0."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await runGenerate({ ...args, quiet: true });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result.status === "timeout" };
    } catch (err) {
      return { content: [{ type: "text", text: `FAILED: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "flow_download",
  {
    title: "Save a generated Flow asset to a file",
    description:
      "Downloads an asset from the Flow project via Flow's own 'Baixar mídia' menu and returns the full file path ON THIS COMPUTER " +
      "(the downloads folder), with size. Without assetId it takes the newest asset in the gallery. " +
      "Default quality is the 'Tamanho original' file (free). 'Aprimorada' entries (1080p/4K) are upscales that may spend " +
      "credits and are only used if you name them in `quality`. If nothing matches, the error lists the available options. " +
      "Free: does not spend credits by default.",
    inputSchema: {
      assetId: z.string().optional().describe("asset.assetId from a finished flow_generate result. Omit for the newest asset."),
      quality: z.string().optional().describe('Substring of a menu entry, e.g. "720p" (video original), "270p" (GIF). Omit for the original file.'),
      account: z.string().optional().describe("Account id from flow_list_accounts. Defaults to the configured default account."),
      project: z.string().optional().describe("Flow project id or full URL. Defaults to the account's configured project."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await runDownload(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `FAILED: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "flow_upload",
  {
    title: "Upload a local image/video into the Flow project (to use as a reference)",
    description:
      "Sends a local file to the Flow project gallery via Flow's own 'Enviar' upload, so it can be used as a reference. " +
      "Free: uploading does not spend credits. The file must be inside the uploads folder (" + UPLOAD_DIR.split(path.sep).join("/") + ") or the " +
      "downloads folder — any other path is refused (this tool sends the file to Google); the human can allow more folders with " +
      "FLOW_MCP_UPLOAD_DIRS. Allowed (what Flow's own picker accepts): png, jpg, jpeg, webp, gif, " +
      "heic, heif, mp4, m4v, mov, 3gp, avi; up to 100 MB. URLs are not accepted. Returns `reference` (the name Flow shows for " +
      "it — pass it to flow_generate's `reference`) and `assetId`. Use a distinctive file name: references are matched by " +
      "name and the newest match wins. " +
      "RIGHTS: for videos Flow asks the account owner to confirm they have the rights to the file. This tool never confirms " +
      "that on its own: without confirmRights it cancels and returns status 'awaiting_consent' (nothing uploaded); pass " +
      "confirmRights:true ONLY after a human confirmed. " +
      "status: uploaded | awaiting_consent | timeout (isError).",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path of the file, inside the uploads folder (or the downloads folder)."),
      timeout: z.number().int().min(10).max(600).optional().describe("Seconds to wait for the upload to finish. Default 120; use 300 for large videos."),
      confirmRights: z.boolean().optional().describe("Set true ONLY after a human confirmed they have the rights to this file: Flow asks for that confirmation on video uploads. Never set it on your own."),
      account: z.string().optional().describe("Account id from flow_list_accounts. Defaults to the configured default account."),
      project: z.string().optional().describe("Flow project id or full URL. Defaults to the account's configured project."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await runUpload(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result.status === "timeout" };
    } catch (err) {
      return { content: [{ type: "text", text: `FAILED: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
