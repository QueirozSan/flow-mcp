// Ritmo e interação "de pessoa" para o mcp-flow.
//
// Por quê (2026-10-09): o Google passou a mostrar "Notamos uma atividade incomum. As extensões do navegador que
// modificam a página podem causar problemas." depois de uma sequência de chamadas seguidas. O código antigo
// (1) ESCREVIA no HTML da página (atributo data-flow-click-target para marcar o que clicar) e disparava click()/focus()
// sintéticos de dentro da página; (2) usava esperas fixas, digitava o prompt a 12 ms por letra e "teleportava" o
// cursor; (3) não tinha limite de frequência. Este módulo corrige isso SEM disfarçar o navegador: nada de falsificar
// impressão digital nem esconder a automação — só deixar de mexer na página e usar um ritmo de pessoa.
//
// Fórmulas ("menos bot, mais humano"):
//   • Tempos: distribuição LOG-NORMAL (tempo de reação humano é assimétrico: quase sempre perto da mediana, às vezes
//     bem mais longo), em vez de uniforme. tempoHumano(min, max): mediana = √(min·max), 90% caem em [min, max] e ~3%
//     vão até 1,6·max ("hesitação"). Nunca abaixo de min.
//   • Movimento do mouse: curva de Bézier cúbica a partir de onde o cursor ESTAVA (não de 0,0), pontos de controle
//     deslocados para o lado (arco de 4–18% da distância), velocidade em sino (minimum-jerk: s = 10t³ − 15t⁴ + 6t⁵),
//     tremor de ±0,5 px, e em ~12% das vezes passa do alvo 3–9 px e corrige. Duração pela Lei de Fitts:
//     T = 180 + 110·log2(1 + D/L) ms (D = distância, L = largura do alvo).
//   • Leitura: antes de aprovar um custo, lê a mensagem a ~230 palavras/min (0,26 s por palavra), entre 0,9 e 5 s.
//   • Digitação: prompt curto (≤ 60 caracteres) é digitado letra a letra (60–170 ms, pausa maior depois de espaço);
//     prompt longo é COLADO (é o que uma pessoa faz com um texto pronto).
//   • Depois de cada clique o cursor "descansa" fora da galeria (sem isso o Flow troca a miniatura de um vídeo pela
//     prévia em <video> e a leitura da galeria falhava — bug de 2026-10-25).
//
// Ajustes por variável de ambiente:
//   FLOW_MCP_INTERVALO_MIN_S (45)  intervalo mínimo entre GERAÇÕES (+ variação log-normal de até FLOW_MCP_JITTER_S, 30)
//   Limite SAUDÁVEL do servidor (todas as contas somadas — elas usam a mesma máquina), medido no uso real:
//   20 gerações em ~6 h, com rajadas de 8 em 32 min e 3 em 1,5 min, e o aviso veio no dia seguinte.
//   FLOW_MCP_MAX_10MIN (5) · FLOW_MCP_MAX_POR_HORA (10) · FLOW_MCP_MAX_POR_DIA (20)  
//   Passou do limite: ESPERA a vaga se for em até FLOW_MCP_ESPERA_MAX_S (240 s); senão recusa dizendo quando volta.
//   FLOW_MCP_PAUSA_INCOMUM_H (6)   pausa automática depois do aviso de atividade incomum
//   FLOW_MCP_RITMO_FILE            onde guardar o estado (padrão <data folder>/state/pacing.json)

import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./paths.mjs";

const n = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
export const RITMO = {
  intervaloMinS: n(process.env.FLOW_MCP_INTERVALO_MIN_S, 45),
  jitterS: n(process.env.FLOW_MCP_JITTER_S, 30),
  max10min: n(process.env.FLOW_MCP_MAX_10MIN, 5),
  maxPorHora: n(process.env.FLOW_MCP_MAX_POR_HORA, 10),
  maxPorDia: n(process.env.FLOW_MCP_MAX_POR_DIA, 20),
  esperaMaxS: n(process.env.FLOW_MCP_ESPERA_MAX_S, 240),
  pausaIncomumH: n(process.env.FLOW_MCP_PAUSA_INCOMUM_H, 6),
  entreAcoesS: [8, 20], // upload/download/geração: folga mínima entre quaisquer duas ações
};
const arquivoEstado = () => process.env.FLOW_MCP_RITMO_FILE || path.join(STATE_DIR, "pacing.json");

export const ATIVIDADE_INCOMUM = /atividade incomum|unusual activity|unusual traffic/i;

const aleatorio = (a, b) => a + Math.random() * (b - a);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normal padrão (Box–Muller). */
function normal(rand = Math.random) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Tempo "de pessoa" entre min e max: log-normal com mediana √(min·max) e σ tal que 90% caiam em [min, max];
 * a cauda longa vai até 1,6·max. Exportado para teste.
 */
export function tempoHumano(minMs, maxMs = minMs * 1.5, rand = Math.random) {
  const lo = Math.max(1, minMs), hi = Math.max(lo + 1, maxMs);
  const mediana = Math.sqrt(lo * hi);
  const sigma = Math.log(hi / lo) / (2 * 1.645);
  const v = mediana * Math.exp(sigma * normal(rand));
  return Math.round(Math.min(Math.max(v, lo), hi * 1.6));
}

/** Espera de duração humana (substitui as esperas fixas). */
export const pausa = (page, minMs, maxMs) => page.waitForTimeout(tempoHumano(minMs, maxMs));

export function lerEstado() {
  try { return JSON.parse(fs.readFileSync(arquivoEstado(), "utf8")); } catch { return { geracoes: [], ultimaAcao: 0, bloqueadoAte: 0 }; }
}

function salvarEstado(e) {
  fs.mkdirSync(path.dirname(arquivoEstado()), { recursive: true });
  fs.writeFileSync(arquivoEstado(), JSON.stringify(e, null, 1));
}

/**
 * Antes de tocar no navegador: respeita a pausa por "atividade incomum", o limite por hora e o intervalo mínimo
 * (ESPERA o que faltar, em vez de falhar). `tipo`: "generate" | "upload" | "download".
 */
export async function aguardarVez(tipo, { agora = Date.now, esperar = dormir } = {}) {
  const e = lerEstado();
  const t = agora();
  if (e.bloqueadoAte && t < e.bloqueadoAte) {
    throw new Error(`Flow em PAUSA até ${new Date(e.bloqueadoAte).toISOString()}: o Google mostrou "atividade incomum" (${e.motivoBloqueio ?? "sem detalhe"}). Não insista agora — espere ou use outro provedor.`);
  }
  // folga entre quaisquer duas ações; para geração, também o intervalo mínimo desde a última geração
  let falta = tempoHumano(RITMO.entreAcoesS[0] * 1000, RITMO.entreAcoesS[1] * 1000) - (t - (e.ultimaAcao ?? 0));
  if (tipo === "generate") {
    const vaga = proximaVaga(e, t);
    if (vaga > t) {
      if (vaga - t > RITMO.esperaMaxS * 1000) {
        throw new Error(`limite saudável de geração do Flow atingido (${RITMO.max10min}/10 min, ${RITMO.maxPorHora}/h, ${RITMO.maxPorDia}/dia no servidor); próxima vaga às ${new Date(vaga).toISOString()}.`);
      }
      falta = Math.max(falta, vaga - t);
    }
    const ultima = Math.max(0, ...instantes(e));
    const jitter = RITMO.jitterS > 0 ? tempoHumano(1000, RITMO.jitterS * 1000) : 0;
    falta = Math.max(falta, RITMO.intervaloMinS * 1000 + jitter - (t - ultima));
  }
  if (falta > 0) await esperar(falta);
  return { esperouMs: Math.max(0, Math.round(falta)) };
}

// gerações guardadas como { t, conta } (formato antigo: só o número) — aceita os dois
const instantes = (e) => (e.geracoes ?? []).map((g) => (typeof g === "number" ? g : g.t));

/** Quando abre a próxima vaga dentro dos limites saudáveis (agora, se já há vaga). Exportado para teste. */
export function proximaVaga(e, t) {
  const ts = instantes(e).sort((a, b) => a - b);
  let vaga = t;
  for (const [janela, max] of [[600e3, RITMO.max10min], [3600e3, RITMO.maxPorHora], [24 * 3600e3, RITMO.maxPorDia]]) {
    const dentro = ts.filter((x) => t - x < janela);
    if (dentro.length >= max) vaga = Math.max(vaga, dentro[dentro.length - max] + janela); // quando a mais antiga que estoura sai da janela
  }
  return vaga;
}

/** Marca que uma ação aconteceu (e, se for geração, entra nos limites — com a conta usada, para o histórico). */
export function registrarAcao(tipo, { agora = Date.now, conta = null } = {}) {
  const e = lerEstado();
  const t = agora();
  e.ultimaAcao = t;
  if (tipo === "generate") e.geracoes = [...(e.geracoes ?? []).filter((g) => t - (typeof g === "number" ? g : g.t) < 24 * 3600e3), { t, conta }];
  salvarEstado(e);
}

/** O Google avisou "atividade incomum": pausa o Flow por algumas horas (todas as chamadas recusam até lá). */
export function registrarAtividadeIncomum(texto, { agora = Date.now } = {}) {
  const e = lerEstado();
  e.bloqueadoAte = agora() + RITMO.pausaIncomumH * 3600e3;
  e.motivoBloqueio = String(texto ?? "").replace(/\s+/g, " ").slice(0, 200);
  salvarEstado(e);
  return e.bloqueadoAte;
}

// ---------- mouse ----------

const posicao = new WeakMap(); // page → último ponto do cursor (o CDP não informa)

async function tamanhoTela(page) {
  const v = page.viewportSize();
  if (v) return v;
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => ({ width: 1440, height: 812 }));
}

/** Duração de um movimento pela Lei de Fitts (ms). Exportado para teste. */
export function duracaoFitts(distancia, largura) {
  return 180 + 110 * Math.log2(1 + distancia / Math.max(8, largura));
}

/**
 * Pontos de um movimento "de mão": Bézier cúbica com arco lateral, velocidade minimum-jerk e tremor leve.
 * Exportado para teste.
 */
export function trajetoria(de, ate, { largura = 40, rand = Math.random } = {}) {
  const dx = ate.x - de.x, dy = ate.y - de.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return [ate];
  const nx = -dy / dist, ny = dx / dist; // perpendicular
  const arco = dist * (0.04 + rand() * 0.14) * (rand() < 0.5 ? -1 : 1);
  const c1 = { x: de.x + dx * 0.3 + nx * arco, y: de.y + dy * 0.3 + ny * arco };
  const c2 = { x: de.x + dx * 0.75 + nx * arco * 0.4, y: de.y + dy * 0.75 + ny * arco * 0.4 };
  const passos = Math.max(8, Math.min(60, Math.round(duracaoFitts(dist, largura) / 16)));
  const pts = [];
  for (let k = 1; k <= passos; k++) {
    const t = k / passos;
    const s = 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5; // minimum-jerk
    const u = 1 - s;
    const x = u ** 3 * de.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s ** 3 * ate.x;
    const y = u ** 3 * de.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s ** 3 * ate.y;
    const tremor = k < passos ? 0.5 : 0;
    pts.push({ x: x + (rand() - 0.5) * 2 * tremor, y: y + (rand() - 0.5) * 2 * tremor });
  }
  return pts;
}

/** Leva o cursor até (x, y) como uma mão: arco, aceleração/desaceleração e, às vezes, passa do ponto e corrige. */
export async function moverAte(page, x, y, { largura = 40 } = {}) {
  const tela = await tamanhoTela(page);
  const de = posicao.get(page) ?? { x: tela.width * aleatorio(0.35, 0.65), y: tela.height * aleatorio(0.55, 0.85) };
  const passa = Math.random() < 0.12 && Math.hypot(x - de.x, y - de.y) > 120;
  const ang = Math.atan2(y - de.y, x - de.x), extra = aleatorio(3, 9);
  const meta = passa ? { x: x + Math.cos(ang) * extra, y: y + Math.sin(ang) * extra } : { x, y };
  const pts = trajetoria(de, meta, { largura });
  const total = duracaoFitts(Math.hypot(meta.x - de.x, meta.y - de.y), largura);
  for (const p of pts) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(Math.max(4, Math.round((total / pts.length) * aleatorio(0.7, 1.3))));
  }
  if (passa) {
    await pausa(page, 60, 160);
    for (const p of trajetoria(meta, { x, y }, { largura: 12 })) await page.mouse.move(p.x, p.y);
  }
  posicao.set(page, { x, y });
}

/**
 * Tira o cursor de cima da galeria e deixa "descansando" numa área neutra (faixa vazia da barra lateral).
 * Sem isso, um vídeo sob o cursor troca a miniatura pela prévia e a leitura da galeria falha.
 */
export async function afastarCursor(page) {
  const tela = await tamanhoTela(page);
  await moverAte(page, tela.width * aleatorio(0.03, 0.12), tela.height * aleatorio(0.64, 0.78), { largura: 120 }).catch(() => {});
  await pausa(page, 150, 450);
}

/** Ao chegar na página: olha a tela um instante e às vezes mexe o mouse à toa, como quem se orienta. */
export async function olharATela(page) {
  await pausa(page, 900, 2600);
  if (Math.random() < 0.5) {
    const tela = await tamanhoTela(page);
    await moverAte(page, tela.width * aleatorio(0.25, 0.75), tela.height * aleatorio(0.2, 0.8), { largura: 200 }).catch(() => {});
    await pausa(page, 300, 900);
  }
}

/** Tempo de leitura de um texto a ~230 palavras/min, entre 0,9 e 5 s. Exportado para teste. */
export function tempoLeitura(texto) {
  const palavras = String(texto ?? "").trim().split(/\s+/).filter(Boolean).length;
  return Math.min(5000, Math.max(900, palavras * 260));
}

/** Lê uma mensagem da tela antes de agir (ex.: o custo antes de aprovar). */
export async function lerComCalma(page, texto) {
  const base = tempoLeitura(texto);
  await page.waitForTimeout(tempoHumano(base * 0.8, base * 1.25));
}

/**
 * Clique com eventos REAIS de mouse (CDP), como uma pessoa: rola até o elemento, leva o cursor numa curva até um
 * ponto aleatório perto do centro, para um instante em cima, aperta e solta. Nada é escrito na página.
 */
export async function clicar(page, locator, { timeout = 10000 } = {}) {
  await locator.waitFor({ state: "visible", timeout });
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  const box = await locator.boundingBox();
  if (!box) return locator.click({ timeout });
  const x = box.x + box.width * aleatorio(0.32, 0.68);
  const y = box.y + box.height * aleatorio(0.32, 0.68);
  await moverAte(page, x, y, { largura: Math.min(box.width, box.height) });
  await pausa(page, 90, 350); // mira antes de clicar
  await page.mouse.down();
  await pausa(page, 50, 140);
  await page.mouse.up();
}

/**
 * Clica o elemento de `seletor` cujo índice `acharIndice` devolve. `acharIndice` roda na página SÓ PARA LER
 * (recebe { seletor, ...arg }, faz document.querySelectorAll(seletor) e devolve o índice do alvo ou -1).
 * Substitui o antigo "marcar com atributo e clicar": a página não é modificada.
 */
export async function clicarPorIndice(page, seletor, acharIndice, arg = {}) {
  const i = await page.evaluate(acharIndice, { seletor, ...arg });
  if (typeof i !== "number" || i < 0) return false;
  await clicar(page, page.locator(seletor).nth(i));
  return true;
}

/** Texto curto é digitado letra a letra; texto longo é colado (um evento de entrada), com pausas antes e depois. */
export async function escrever(page, texto) {
  await pausa(page, 300, 900);
  if (texto.length <= 60) {
    for (const ch of texto) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(ch === " " ? tempoHumano(110, 320) : tempoHumano(60, 170));
    }
  } else {
    await page.keyboard.insertText(texto);
  }
  await pausa(page, 600, 1500); // relê o que escreveu antes de enviar
}
