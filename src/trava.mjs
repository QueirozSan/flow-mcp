// Trava do servidor: UMA ação no Flow por vez, entre TODOS os processos (um servidor MCP por agente, mais a CLI).
//
// Por quê: dois agentes usaram a mesma conta ao mesmo tempo e os dois processos dirigiam a MESMA aba do Chrome: um abriu
// uma sessão de chat nova no meio da geração do outro, o "item mais novo" da galeria passou a ser o vídeo errado (ainda
// na fila, sem miniatura) e a geração paga voltou sem asset. Esta trava impede isso.
//
// Como funciona: arquivo <data folder>/state/flow.lock criado com O_EXCL (atômico). Quem chega depois ESPERA (com variação, como uma
// pessoa que volta para conferir) até FLOW_MCP_TRAVA_ESPERA_S (padrão 1200 s) e então recusa dizendo quem ocupa.
// Trava velha (processo morto ou mais de FLOW_MCP_TRAVA_MAX_MIN, padrão 45 min) é descartada. Dentro da mesma chamada
// (geração que reenvia a referência, healthcheck dentro da geração) a trava é reentrante via AsyncLocalStorage — duas
// chamadas SIMULTÂNEAS no mesmo processo continuam se excluindo.

import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { STATE_DIR } from "./paths.mjs";

const n = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
const arquivo = () => process.env.FLOW_MCP_TRAVA_FILE || path.join(STATE_DIR, "flow.lock");
const dentro = new AsyncLocalStorage();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function lerTrava() {
  try { return JSON.parse(fs.readFileSync(arquivo(), "utf8")); } catch { return null; }
}

function vivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Trava abandonada: dono morto, idade acima do teto ou arquivo ilegível. Exportado para teste. */
export function travaVelha(info, { agora = Date.now(), maxMin = n(process.env.FLOW_MCP_TRAVA_MAX_MIN, 45), estaVivo = vivo } = {}) {
  if (!info || !Number.isFinite(info.desde)) return true;
  if (agora - info.desde > maxMin * 60e3) return true;
  return Number.isFinite(info.pid) && !estaVivo(info.pid);
}

function tentarPegar(acao) {
  fs.mkdirSync(path.dirname(arquivo()), { recursive: true });
  try {
    const fd = fs.openSync(arquivo(), "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, acao, desde: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return false;
  }
}

/** Roda `fn` com a trava do servidor. `acao` só aparece na mensagem para quem estiver esperando. */
export async function comTrava(acao, fn, { esperaMaxS = n(process.env.FLOW_MCP_TRAVA_ESPERA_S, 1200) } = {}) {
  if (dentro.getStore()) return fn(); // reentrante: já estamos dentro desta mesma chamada
  const inicio = Date.now();
  while (!tentarPegar(acao)) {
    const info = lerTrava();
    if (travaVelha(info)) { fs.rmSync(arquivo(), { force: true }); continue; }
    if (Date.now() - inicio > esperaMaxS * 1000) {
      throw new Error(`Flow ocupado: outra chamada (${info.acao}, pid ${info.pid}) usa o navegador desde ${new Date(info.desde).toISOString()}. Esperei ${esperaMaxS} s; tente de novo mais tarde.`);
    }
    await dormir(4000 + Math.random() * 7000);
  }
  try {
    return await dentro.run(true, fn);
  } finally {
    const info = lerTrava();
    if (info?.pid === process.pid) fs.rmSync(arquivo(), { force: true });
  }
}
