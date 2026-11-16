# flow-mcp

**Deixe seu agente de IA gerar imagens e vídeos no Google Flow.** Um servidor [MCP](https://modelcontextprotocol.io) que dirige o
[Google Flow](https://flow.google.com) com a **sua própria conta Google**: você entra uma vez no Chrome e depois pede ao Claude
(ou a qualquer cliente MCP) para criar imagens e vídeos e salvar os arquivos no seu computador.

[🇺🇸 Read in English](README.md)

> **Não oficial.** Sem ligação com o Google. O Flow não tem API pública, então esta ferramenta automatiza o site do Flow num
> Chrome de verdade, como uma pessoa faria. Automatizar um site pode ir contra os termos do Google, e o Google pode mostrar um
> aviso de "atividade incomum" ou restringir uma conta. Use com uma conta que você aceite arriscar, por sua conta e risco.
> A ferramenta se comporta num ritmo humano e pausa quando recebe aviso, mas não elimina esse risco.

## O que você ganha

| Ferramenta | Para quê |
|---|---|
| `flow_generate` | Gera imagem (grátis) ou vídeo (gasta créditos) a partir de um prompt, com referências opcionais |
| `flow_download` | Salva o arquivo gerado no seu computador (`~/.flow-mcp/downloads`) |
| `flow_upload` | Envia uma imagem/vídeo seu para usar como referência |
| `flow_healthcheck` | Confere se a página do Flow ainda é a que a ferramenta espera (avisa quando o Google muda a interface) |
| `flow_list_accounts` | Lista contas conectadas, ordem, estado de créditos e limites de ritmo |
| `flow_prepare_project` | Cria um projeto do Flow com três cartões de instruções para o agente |

**Segurança de créditos:** imagem é grátis. Um vídeo só roda se a chamada tiver `maxCredits` ≥ o custo cotado pelo Flow; senão é
rejeitado, nada é gasto e o preço volta. O "Sempre aprovar" nunca é clicado.

## Requisitos

- **Node.js 20+** e **Google Chrome** (Windows, macOS ou Linux)
- Uma conta Google com acesso ao [Flow](https://flow.google.com)
- ⚠️ Flow em **português (pt-BR)** e conta que mostre o **compositor em formato de chat** do Flow (a caixa de texto onde você fala
  com o agente do Flow). A ferramenta casa os rótulos em português; ela abre o próprio perfil do Chrome em pt-BR. Se a sua conta
  mostra o painel clássico, o `flow-mcp login` avisa que a interface não confere (veja [Limites](#limites)).

## Instalar (3 comandos)

```bash
git clone https://github.com/QueirozSan/flow-mcp.git
cd flow-mcp && npm install
node bin/flow-mcp.mjs login      # abre o Chrome → entre com o Google → pronto
node bin/flow-mcp.mjs install    # registra o servidor MCP no Claude Code (ou imprime o trecho do seu cliente)
```

Depois peça ao seu agente: *"Gere uma imagem de um balão sobre Tóquio ao amanhecer com as ferramentas flow e baixe."*

### O que significa "conectar via OAuth" aqui

O Flow não tem cliente OAuth para desenvolvedores nem API, então não há nada para registrar. O `flow-mcp login` abre uma janela do
Chrome com um **perfil dedicado** e você entra na **página de login do próprio Google** (o fluxo OAuth normal do Google, com
verificação em duas etapas). A ferramenta nunca vê sua senha nem códigos; só confere que existe uma sessão Google e guarda a URL
do projeto do Flow. A sessão fica numa pasta de perfil do Chrome no **seu** computador (`~/.flow-mcp/profiles/<nome>`).

### Outros clientes MCP

```bash
node bin/flow-mcp.mjs install --client claude-desktop   # edita o claude_desktop_config.json (guarda um .bak)
node bin/flow-mcp.mjs install --client print            # imprime o JSON para Cursor, Codex, VS Code, Windsurf, …
```

Ou à mão — o comando é `node /caminho/completo/flow-mcp/bin/flow-mcp.mjs serve`:

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/caminho/completo/flow-mcp/bin/flow-mcp.mjs", "serve"] } } }
```

> Vídeo leva 1–3 minutos por chamada. Passe `timeout: 300` em vídeo e garanta que o tempo limite por ferramenta do seu cliente seja
> de pelo menos 10 minutos (o padrão do Claude Code serve; o SDK TypeScript do MCP usa 60 s).

## Comandos

```text
flow-mcp login [--name <id>] [--new-project]   conecta uma conta Google (--name adiciona mais contas)
flow-mcp install [--client ...]                registra no seu cliente de IA
flow-mcp doctor                                confere Node, Chrome, contas
flow-mcp accounts                              lista as contas conectadas
flow-mcp healthcheck [--account <id>]          a página do Flow ainda é a esperada?
flow-mcp generate --prompt "…" [--mode image|video] [--model "Veo 3.1 - Lite"] [--max-credits 10] [--timeout 300]
flow-mcp download [--asset <id>] [--quality 720p]
flow-mcp upload --path <arquivo em ~/.flow-mcp/uploads> [--confirm-rights]
```

## Várias contas

`flow-mcp login --name segunda` adiciona outra conta (perfil e porta próprios). As contas são usadas uma por vez, em ordem; a
próxima só entra **quando a atual fica sem créditos** (nunca para fugir de limite ou aviso — elas compartilham sua máquina e IP).

## Onde ficam as coisas

Tudo em `~/.flow-mcp` (mude com `FLOW_MCP_HOME`):

```text
accounts.json     contas conectadas (ids, portas, URLs de projeto — sem segredos)
profiles/<id>/    um perfil do Chrome por conta — AQUI ESTÁ A SUA SESSÃO GOOGLE. Mantenha privado, nunca versione nem compartilhe.
downloads/        arquivos salvos pelo flow_download
uploads/          coloque aqui os arquivos para enviar com o flow_upload
logs/ state/      logs do healthcheck, estado de ritmo e trava
```

## Desenho de segurança

- **Créditos:** nunca aprova custo desconhecido, nunca clica "Sempre aprovar", nunca baixa versões "Aprimoradas" (pagas) sem você pedir.
- **Só local:** a porta de depuração do Chrome fica em `127.0.0.1`. Nunca a exponha: ela controla um navegador logado na sua conta.
- **Upload cercado:** o `flow_upload` só lê `~/.flow-mcp/uploads` e `downloads` (e pastas que você listar em `FLOW_MCP_UPLOAD_DIRS`),
  só aceita extensões de imagem/vídeo e nenhuma URL — um agente enganado por prompt injection não consegue enviar seus arquivos ao Google.
- **Confirmações legais ficam com humanos:** o aviso de "direitos" de vídeo só é aceito quando um humano manda o agente passar `confirmRights`.
- **Ritmo:** trajetos e tempos de mouse humanos, intervalo mínimo entre gerações, tetos por hora/dia e pausa automática de horas se o
  Google mostrar "atividade incomum". Ajustável por variáveis `FLOW_MCP_*` (veja [`docs/GUIDE.md`](docs/GUIDE.md)).

Veja [SECURITY.md](SECURITY.md).

## Quando o site muda

Os seletores ficam num único arquivo, [`src/selectors.mjs`](src/selectors.mjs). O `flow_healthcheck` (e todo `flow_generate`, antes
de agir) confere se ainda batem com a página e recusa continuar, com mensagem clara, se o Google mudou algo — em vez de falhar três
passos depois com um timeout confuso. Abra uma issue quando acontecer.

## Limites

- Só interface do Flow em português (pt-BR) por enquanto (rótulos casados por texto). PRs para outros idiomas são bem-vindos.
- Mira o **compositor em formato de chat**. Contas que ainda recebem o painel clássico não são suportadas.
- Uma ação por vez (uma trava serializa as chamadas); vídeos levam minutos.
- `aspect`/`count` em vídeo são melhor-esforço; confira o arquivo baixado.
- Automatiza um site; quando o Google muda, quebra até os seletores serem atualizados.

## Licença

[MIT](LICENSE)
