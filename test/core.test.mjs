// Offline unit tests: account registry, pacing math, upload fence, lock staleness. No browser, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "flow-mcp-core-"));
process.env.FLOW_MCP_HOME = HOME;
const { saveAccount, resolveAccount, listAccounts, readRegistry } = await import("../src/config.mjs");
const { escolherConta, marcarSemCredito, marcarUsada, contaAtiva } = await import("../src/contas.mjs");
const { tempoHumano, proximaVaga, RITMO, trajetoria, tempoLeitura } = await import("../src/humano.mjs");
const { resolveUploadPath, UPLOAD_DIR } = await import("../src/upload.mjs");
const { travaVelha } = await import("../src/trava.mjs");
const { ensureHome } = await import("../src/paths.mjs");
ensureHome();

test("no account: resolveAccount explains how to log in", () => {
  assert.throws(() => resolveAccount(), /flow-mcp login/);
});

test("saveAccount allocates distinct ports, first account is default, profile stays inside the data folder", () => {
  const a = saveAccount("main", { projectUrl: "https://flow.google.com/project/abc-123" });
  const b = saveAccount("second", {});
  assert.notEqual(a.cdpPort, b.cdpPort);
  assert.equal(readRegistry().default, "main");
  const r = resolveAccount("main");
  assert.ok(r.profileDir.startsWith(HOME));
  assert.equal(r.projectUrl, "https://flow.google.com/project/abc-123");
  assert.throws(() => resolveAccount("second"), /no Flow project yet/);
  assert.throws(() => resolveAccount("nope"), /unknown account/);
  assert.throws(() => saveAccount("../evil", {}), /invalid account name/);
  assert.equal(listAccounts().length, 2);
});

test("credit fallback follows the order and skips accounts marked out of credits", () => {
  assert.equal(escolherConta(), "main");
  marcarSemCredito("main");
  assert.equal(escolherConta(), "second");
  assert.equal(escolherConta({ excluir: ["second"], agora: () => Date.now() + 25 * 3600e3 }), "main"); // main is tried again after 24 h
  marcarSemCredito("second");
  assert.throws(() => escolherConta(), /out of credits/);
  marcarUsada("second");
  assert.equal(contaAtiva(), "second");
});

test("human timing stays inside its bounds", () => {
  for (let i = 0; i < 500; i++) {
    const t = tempoHumano(100, 400);
    assert.ok(t >= 100 && t <= 640, `out of range: ${t}`);
  }
  assert.ok(tempoLeitura("um dois três") >= 900);
  const pts = trajetoria({ x: 0, y: 0 }, { x: 300, y: 200 });
  assert.deepEqual({ x: Math.round(pts.at(-1).x), y: Math.round(pts.at(-1).y) }, { x: 300, y: 200 });
});

test("pacing: the 10-minute cap opens the next slot when the oldest generation leaves the window", () => {
  const t = 10_000_000;
  const e = { geracoes: Array.from({ length: RITMO.max10min }, (_, i) => ({ t: t - 60_000 * (RITMO.max10min - i) })) };
  assert.ok(proximaVaga(e, t) > t);
  assert.equal(proximaVaga({ geracoes: [] }, t), t);
});

test("upload fence: only the uploads/downloads folders, only media, no escapes", () => {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ok = path.join(UPLOAD_DIR, "ref.png");
  fs.writeFileSync(ok, "x");
  assert.equal(resolveUploadPath(ok).kind, "image");

  const txt = path.join(UPLOAD_DIR, "notes.txt");
  fs.writeFileSync(txt, "x");
  assert.throws(() => resolveUploadPath(txt), /unsupported file type/);

  const outside = path.join(os.tmpdir(), `flow-mcp-outside-${process.pid}.png`);
  fs.writeFileSync(outside, "x");
  assert.throws(() => resolveUploadPath(outside), /must be inside/);
  assert.throws(() => resolveUploadPath(path.join(UPLOAD_DIR, "..", path.basename(outside))), /must be inside|not found/);
  fs.rmSync(outside);

  assert.throws(() => resolveUploadPath("https://example.com/x.png"), /not found/);
  assert.throws(() => resolveUploadPath(path.join(HOME, "accounts.json")), /must be inside/);
});

test("stale lock detection", () => {
  const now = Date.now();
  assert.equal(travaVelha(null), true);
  assert.equal(travaVelha({ pid: 1, desde: now }, { estaVivo: () => true }), false);
  assert.equal(travaVelha({ pid: 1, desde: now }, { estaVivo: () => false }), true);
  assert.equal(travaVelha({ pid: 1, desde: now - 3 * 3600e3 }, { estaVivo: () => true }), true);
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
