# flow-mcp — guide for agents

Generates **images and videos in Google Flow** and saves the finished file on the user's computer. This is the full manual;
the server also serves it as the MCP resource `flow://guide`.

## Rules (read first)

1. **Images are free. Videos cost credits.** `flow_generate` only spends credits if you pass `maxCredits` **>=** the cost
   Flow shows. Without `maxCredits`, a request that costs something is **rejected without spending** and returns
   `status: "awaiting_approval"` with the `cost`. "Always approve" is never used.
2. **Do not trust "success". Read `status` and `warnings` of every result.** `finished` = done, `awaiting_approval` = nothing
   was spent (decide), `no_credits` = nothing spent, `blocked_unusual_activity` = Google flagged automation (stop, do not
   retry), `timeout` = error.
3. **One thing at a time.** There is one Chrome tab per account. Calls are serialized by a lock; a call made while another
   runs waits (up to 20 min) and then fails with "Flow ocupado".
4. **Calls block.** Image ~40 s, video 1–3 min (sometimes more: there is a queue). Pass `timeout: 300` for video. Your MCP
   client's per-call timeout matters: Claude Code's default is huge, but the TypeScript MCP SDK assumes 60 s and would
   drop a video; raise it to 10+ minutes.
5. **Do not try to fix sign-in or site changes yourself.** If a call fails for that reason, stop and tell the human (see "Errors").
6. **No account connected?** `flow_list_accounts` returns nothing / other tools say so: the human must run `flow-mcp login`
   in a terminal (it opens Chrome so they sign in with Google). You cannot do this for them.

## Standard flow

```
flow_healthcheck                                    → {ok:true}? otherwise stop.
[copy file → uploads folder ; flow_upload {path}]   → reference (only to use the user's own file as a reference)
flow_generate {prompt, mode, maxCredits, ...}       → status "finished" → asset.assetId
flow_download {assetId}                             → file saved on this computer; result has the full path
```

Video in two steps, no cost surprise:

```jsonc
// 1) find the cost (spends nothing)
flow_generate { "prompt": "a knight in the mist at dawn", "mode": "video", "model": "Veo 3.1 - Lite", "timeout": 120 }
//   → { "status": "awaiting_approval", "cost": 10 }
// 2) approve up to that value (only what the human authorized)
flow_generate { "prompt": "a knight in the mist at dawn", "mode": "video", "model": "Veo 3.1 - Lite", "maxCredits": 10, "timeout": 300 }
//   → { "status": "finished", "cost": 10, "asset": { "assetId": "…", "kind": "video" } }
// 3) download
flow_download { "assetId": "…" }
//   → { "path": "C:\\Users\\me\\.flow-mcp\\downloads\\….mp4", "bytes": 3790863 }
```

## Tools

### `flow_list_accounts` — no parameters
Lists connected accounts (`id`, `label`, `isDefault`, `projectUrl`, order, out-of-credits state) and the server-wide healthy
generation limits with the time the next slot opens. All other tools accept `account` (default: the default account).

### `flow_healthcheck` — `{ account? }`
Live-checks that every selector the tool depends on still exists on the page. Returns `{ ok, results[] }`; `isError` = `!ok`.
If `ok:false`, the site changed or the sign-in expired: **stop**. `flow_generate` runs this itself before acting.

### `flow_generate`
| parameter | type | notes |
|---|---|---|
| `prompt` | string, required | What to generate. See "How Flow decides" below. |
| `mode` | `image` \| `video` | Default `image`. With `video` the tool prefixes "Generate a video: …" if you did not. |
| `model` | string | Video only, e.g. `"Veo 3.1 - Lite"`. Goes inside the request text ("Using the Veo 3.1 Lite model, …"). |
| `maxCredits` | integer >= 0 | Credit ceiling **you authorize for this call**. Omitted = authorizes nothing. |
| `aspect` | string | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`. Best effort; for video **check the downloaded file's dimensions**. |
| `timeout` | 10–1800 s | Default 180. Use 300 for video. |
| `reference` | string | Name of an asset **already in the project** to use as a reference. For the user's own file: `flow_upload` it and pass the `reference` it returns. Several references: separate names with `\|`. |
| `referenceAssetId` | string | The `assetId` `flow_upload` returned. Pass it when **editing** the user's file: Flow saves the edit as a **new version** of that asset; the result comes back in `asset.assetId` (`newVersion: true`). |
| `account`, `project` | string | Account / project id or URL. Default: the account's configured ones. |
| `count` | 1–4 | Image panel only. |

**Result** (fields that matter): `status` (`finished` \| `awaiting_approval` \| `no_credits` \| `blocked_unusual_activity` \| `failed` \| `timeout`),
`cost` (credits charged / that would be charged; `null` = free image), `message`, `promptSent`, `asset` (`{ assetId, kind }` of the
newest file), `warnings` (settings that did **not** apply — always read), `selectedModel`, `agentMessage` (only on `timeout` without
progress: what Flow's own agent answered instead of generating — the real reason), `contasTentadas` (accounts tried).

One request can create **several images**; `asset` is only the newest. The others are in the gallery.

### `flow_download` — `{ assetId?, quality?, account?, project? }`
Saves through Flow's own "Baixar mídia" menu and returns `{ assetId, option, path, filename, bytes, availableOptions }`.
- No `assetId` = the newest asset in the gallery.
- Default = the **"Tamanho original"** option (free): video `720p`, image `1K`.
- **"Aprimorada"** options (1080p/2K/4K) are upscales and **may spend credits**: only used if you name them in `quality`.
  `quality: "270p"` downloads the video's GIF. If nothing matches, the error lists `availableOptions`.
- `path` is on **this computer**, in the downloads folder (`~/.flow-mcp/downloads` unless `FLOW_MCP_DOWNLOAD_DIR` is set).
  Move/copy it where the user wants it.

### `flow_upload` — `{ path, timeout?, confirmRights?, account?, project? }`
Sends a local file to the project gallery (Flow's own "+" → "Enviar") so it can be a **reference**. Free.
1. Put the file in the uploads folder (`~/.flow-mcp/uploads`) with a **distinctive name** (references are matched by name; newest wins).
2. `flow_upload {"path":"<full path>"}` → `{status:"uploaded", reference, assetId, kind}` (image ~15 s; video ~30 s).
3. `flow_generate {..., "reference": "<reference returned>"}`.

- **Only reads the uploads and downloads folders** (real path resolved: `..` and symlinks that escape are refused; the human
  can allow more folders with `FLOW_MCP_UPLOAD_DIRS`). **URLs are not accepted.** Formats: png, jpg, jpeg, webp, gif, heic, heif, mp4, m4v, mov, 3gp, avi (**not** webm). Up to 100 MB.
- **Video requires a rights confirmation.** Flow opens "Direitos de uso deste vídeo" (the account owner confirms they have the rights
  and follows Google's Prohibited Use Policy). Without `confirmRights:true` the tool **cancels**, uploads nothing and returns
  `status:"awaiting_consent"`. Pass `confirmRights:true` **only after the human confirmed**. The tool clicks only the plain
  "Concordo" of this call — **never** "Concordo, não mostrar essa mensagem de novo".
- `status`: `uploaded` · `awaiting_consent` (nothing sent; decide) · `timeout` (`isError`).

### `flow_prepare_project` — `{ action?, project?, instructions[3], idempotencyKey?, account? }`
Creates a new Flow project (or continues one this tool managed) and writes exactly three "Instruções para o agente" cards,
verifying they persisted. Returns `projectUrl`. Optional; call it once before generating when you want project-level instructions.

## How Flow decides (why the tool behaves this way)

The composer is a **chat agent**, not a classic panel. The agent decides what to generate from the **text** of the request:
"camera push-in" becomes a video; "a calm lake" becomes an image. Therefore:

- For images, **do not use motion words** (camera, animation, video). With `maxCredits: 0` this is safe: if the agent proposes
  a paid video, you get `awaiting_approval` and nothing is spent.
- The video model is chosen by the text. Observed: asking for "Veo 3.1 Lite" → Flow charged **10 credits**; naming no model → **15**.
- Every call opens a **fresh chat session**, so a late reply is never mistaken for another request's.
- Flow's chat text can lag (it once said "video queued" with the file already available). **Trust `status`/`asset`, not the chat text.**
- **Image reference + edit request** ("turn the attached image into…"): Flow creates a **new version of the same asset**
  (same `assetId`); `flow_download` fetches the new version.
- **Video references depend on the model.** `Veo 3.1 - Lite` refuses a video reference; `Omni 1.1 Flash` accepts it.
  Uploaded videos cannot be "extended" (only Veo-generated clips can).

## Observed costs

| request | credits |
|---|---|
| image | 0 |
| video, default model | 15 |
| video, "Veo 3.1 Lite" | 10 |
| video → video, `Omni 1.1 Flash`, uploaded video as reference | 20 (quote only) |
| upload / download "Tamanho original" | 0 |

Prices change. **The `cost` returned is what counts**, not this table.

## Pacing (built in, to look like a person and avoid Google's "unusual activity" warning)

The tool clicks with real mouse events along human-like paths, waits human-like times and enforces healthy limits across all
accounts: a minimum gap between generations (~45 s) and at most 5 per 10 min, 10 per hour, 20 per day (tunable with
`FLOW_MCP_MAX_10MIN`, `FLOW_MCP_MAX_POR_HORA`, `FLOW_MCP_MAX_POR_DIA`, `FLOW_MCP_INTERVALO_MIN_S`). Above the limit it waits a short
time or refuses and says when the next slot opens. If Google shows "unusual activity" the tool pauses itself for hours
(`FLOW_MCP_PAUSA_INCOMUM_H`, default 6): **do not retry in the meantime.**

## Errors and what to do

| symptom | probable cause | action |
|---|---|---|
| "no Google Flow account is connected yet" | `flow-mcp login` never ran | Tell the human to run `flow-mcp login` in a terminal. |
| `flow_healthcheck` `ok:false` / "site drift detected" | Google changed the page, or Chrome/Flow is not in Portuguese (pt-BR), or the account does not have the chat-style composer | Stop. Tell a human. Selectors live in `src/selectors.mjs`. |
| healthcheck fails and the page shows a sign-in screen | Google session expired | Human only: `flow-mcp login --name <account>` again. |
| `awaiting_approval` | paid request without enough `maxCredits` | Decide; repeat with `maxCredits >= cost`. Nothing was spent. |
| `no_credits` | the account is out of credits (next account in the order is tried automatically) | Tell the human; nothing was spent. |
| `blocked_unusual_activity` | Google flagged automation | Stop. Do not retry for hours. |
| `timeout` and `lastProgress: null` | the request never started (silent agent, no approval) | Retry once; if it persists, tell the human. Nothing is spent without approval. |
| `timeout` and `lastProgress` is a number | slow generation / queue | It may finish later: call `flow_download` (no `assetId`) afterwards. |
| `timeout` with `agentMessage` | Flow's agent answered in text (model cannot do what was asked) | Read `agentMessage`; e.g. video reference with Veo Lite → use `Omni 1.1 Flash`. |
| `asset` missing + warning "no new tile" | the file has not appeared in the gallery yet | Wait; call `flow_download` without `assetId`. |
| "Chrome did not open a debugging endpoint" | another Chrome window already uses that profile | Close Chrome windows opened on `~/.flow-mcp/profiles/<account>`, retry. |
| `flow_upload` → `awaiting_consent` | Flow asks for a rights confirmation (video) | Ask the human; only on "yes" repeat with `confirmRights:true`. |
| `flow_upload` → "path must be inside…" | file outside the allowed folders | Copy it into the uploads folder. |
| `flow_generate` → "reference … not found in the asset picker" | file not uploaded / different name | Run `flow_upload` and use the `reference` it returns. |

## Known limits

- Requires the Portuguese (pt-BR) Flow interface and an account that shows Flow's chat-style composer (the labels are matched in
  Portuguese). The tool starts Chrome with pt-BR for its own profile.
- `aspect` and `count` for video were not verified; generate one video per call.
- Flow can **fail** a generation ("Falha — Algo deu errado", no charge) and the tool only notices as a `timeout`.
- Only free paths were exercised end to end by the tool itself; paid approval is the same code path validated by hand.
