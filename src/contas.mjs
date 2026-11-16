// Several Flow accounts, ONE AT A TIME, switching to the next one ONLY when the current one runs out of credits.
// Pacing limits and the "unusual activity" pause (humano.mjs) are global to the whole server: accounts are never
// rotated to dodge a usage limit or a warning — they share the same machine and IP.
//
// The order comes from accounts.json ("ordem": ["main", "second"]); without it, the default account first and then the
// others. State (which accounts are out of credits, which account was used last) is kept in the data folder.

import fs from "node:fs";
import path from "node:path";
import { ACCOUNTS_FILE, STATE_DIR } from "./paths.mjs";

const ARQ_ESTADO = () => process.env.FLOW_MCP_CONTAS_FILE || path.join(STATE_DIR, "accounts-state.json");
const n = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
const SEM_CREDITO_H = n(process.env.FLOW_MCP_SEM_CREDITO_H, 24);

/** Flow's phrases for "out of credits" (Portuguese UI + English). */
export const SEM_CREDITO = /cr[eé]ditos? insuficientes|n[aã]o (tem|h[aá]|possui) cr[eé]ditos( suficientes)?|sem cr[eé]ditos|(seus|os) cr[eé]ditos (acabaram|terminaram|se esgotaram)|saldo (de cr[eé]ditos )?insuficiente|out of credits|not enough credits|insufficient credits/i;

const lerJson = (f, padrao) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return padrao; } };
const lerEstado = () => lerJson(ARQ_ESTADO(), { semCreditoAte: {} });
function salvarEstado(e) {
  fs.mkdirSync(path.dirname(ARQ_ESTADO()), { recursive: true });
  fs.writeFileSync(ARQ_ESTADO(), JSON.stringify(e, null, 1));
}

/** The order of use: `ordem` from accounts.json; without it, the default first and then the rest. */
export function ordemContas() {
  const reg = lerJson(ACCOUNTS_FILE(), null);
  const todas = Object.keys(reg?.accounts ?? {});
  if (!todas.length) throw new Error("no Google Flow account is connected yet — run `flow-mcp login` first.");
  const ordem = (reg.ordem ?? [reg.default, ...todas]).filter((c, i, a) => todas.includes(c) && a.indexOf(c) === i);
  return ordem.length ? ordem : todas;
}

/** The first account in the order not marked "out of credits" (and not already tried in this call). */
export function escolherConta({ excluir = [], agora = Date.now } = {}) {
  const e = lerEstado();
  const t = agora();
  const livres = ordemContas().filter((c) => !excluir.includes(c) && !((e.semCreditoAte?.[c] ?? 0) > t));
  if (!livres.length) {
    const volta = Math.min(...ordemContas().map((c) => e.semCreditoAte?.[c] ?? Infinity));
    throw new Error(`all Flow accounts are out of credits${Number.isFinite(volta) ? ` (the first one is tried again at ${new Date(volta).toISOString()})` : ""}.`);
  }
  return livres[0];
}

/** The account ran out of credits: skip it for a few hours (it is tested again afterwards). */
export function marcarSemCredito(conta, { agora = Date.now, horas = SEM_CREDITO_H } = {}) {
  const e = lerEstado();
  e.semCreditoAte = { ...(e.semCreditoAte ?? {}), [conta]: agora() + horas * 3600e3 };
  salvarEstado(e);
  return e.semCreditoAte[conta];
}

/** Remembers which account the last action used, so a following download/upload goes to the same account. */
export function marcarUsada(conta) {
  const e = lerEstado();
  if (e.ultima === conta) return;
  e.ultima = conta;
  salvarEstado(e);
}

export function contaAtiva() {
  const ultima = lerEstado().ultima ?? null;
  try { return ordemContas().includes(ultima) ? ultima : null; } catch { return null; }
}

export function estadoContas({ agora = Date.now } = {}) {
  const e = lerEstado();
  const t = agora();
  const ativa = contaAtiva();
  return ordemContas().map((c) => ({ conta: c, semCreditoAte: (e.semCreditoAte?.[c] ?? 0) > t ? new Date(e.semCreditoAte[c]).toISOString() : null, ativa: ativa === c }));
}
