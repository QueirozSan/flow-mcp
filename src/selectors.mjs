// Single source of truth for every DOM selector this package depends on.
// If Google changes Flow's UI, healthcheck.mjs checks every entry here —
// add new selectors here, not inline in generate.mjs, so drift detection
// always covers exactly what generate.mjs actually uses.
//
// These target the AGENT-ONLY composer cohort (no classic settings-trigger-
// button, no agent-mode-chip — see README.md "Contexto"). If Flow ever
// reverts this account to the classic composer, these selectors will stop
// matching and healthcheck.mjs will alert on that too.

export const SELECTORS = {
  promptBox: {
    selector: "div.ProseMirror[contenteditable='true']",
    description: "Campo de texto do prompt (chat do agente)",
    critical: true,
  },
  submitButton: {
    selector: "button[aria-label='Iniciar geração']",
    description: "Botão de envio/gerar",
    critical: true,
  },
  settingsTrigger: {
    selector: "button[aria-label='Gatilho de configurações']",
    description: "Abre o painel de modelo/aspecto/quantidade/custo",
    critical: true,
  },
  addReferenceButton: {
    selector: "button[aria-label='Adicionar elementos à caixa de comando']",
    description: "Abre o seletor de referências (assets existentes) / upload",
    critical: false,
  },
  moreOptionsButton: {
    selector: "button[aria-label='Mais opções']",
    description: "Menu de mais opções de um asset aberto (contém 'Baixar mídia')",
    critical: false,
  },
  settingsSummary: {
    selector: ".settings-summary",
    description: "Resumo do modo/modelo/aspecto/quantidade selecionados",
    critical: false,
  },
  uploadMenuButton: {
    selector: "button[aria-label='Menu para adicionar arquivos']",
    description: "Menu '+' do cabeçalho; contém 'Enviar' (upload de arquivo local para o projeto) — usado por flow_upload",
    critical: false,
  },
};
