# flow-mcp

**Let your AI agent generate images and videos in Google Flow.** An [MCP](https://modelcontextprotocol.io) server that drives
[Google Flow](https://flow.google.com) with *your own* Google account — you sign in once in Chrome, then ask Claude (or any
MCP client) to make images and videos and save the files on your computer.

[🇧🇷 Leia em português](README.pt-BR.md)

> **Unofficial.** Not affiliated with or endorsed by Google. Flow has no public API, so this tool automates the Flow website in a
> real Chrome window, the way a person would. Automating a website may go against Google's terms, and Google can show an
> "unusual activity" warning or restrict an account. Use it with an account you can afford to risk, at your own responsibility.
> The tool paces itself like a person and pauses on warnings, but it cannot remove that risk.

## What you get

| Tool | What it does |
|---|---|
| `flow_generate` | Generate an image (free) or a video (costs credits) from a prompt, optionally with reference images/videos |
| `flow_download` | Save the generated file to your computer (`~/.flow-mcp/downloads`) |
| `flow_upload` | Upload your own image/video to use as a reference |
| `flow_healthcheck` | Check that Flow's page still looks like what the tool expects (alerts you when Google changes the UI) |
| `flow_list_accounts` | List connected accounts, order, credit state, pacing limits |
| `flow_prepare_project` | Create a Flow project with three agent-instruction cards |

**Credit safety:** images are free. A video only runs if the call includes `maxCredits` ≥ the cost Flow quotes; otherwise it is
rejected, nothing is spent, and you get the price back. "Always approve" is never clicked.

## Requirements

- **Node.js 20+** and **Google Chrome** (Windows, macOS or Linux)
- A Google account with access to [Flow](https://flow.google.com)
- ⚠️ Flow in **Portuguese (pt-BR)** and an account that shows Flow's **chat-style composer** (the text box where you talk to
  Flow's agent). The tool matches Flow's Portuguese labels; it starts its own Chrome profile in pt-BR for that. If your account
  shows the classic panel instead, `flow-mcp login` tells you the interface does not match (see [Limits](#limits)).

## Install (3 commands)

```bash
git clone https://github.com/QueirozSan/flow-mcp.git
cd flow-mcp && npm install
node bin/flow-mcp.mjs login      # opens Chrome → sign in with Google → done
node bin/flow-mcp.mjs install    # registers the MCP server in Claude Code (or prints the snippet for your client)
```

Then ask your agent: *"Generate an image of a hot air balloon over Tokyo at sunrise with the flow tools and download it."*

### What "connect with OAuth" means here

Flow has no developer OAuth client or API, so there is nothing to register. `flow-mcp login` opens a Chrome window with a
**dedicated profile** and you sign in on **Google's own sign-in page** (the normal Google OAuth flow, including 2-step
verification). This tool never sees your password or codes; it only checks that a Google session exists and remembers the
Flow project URL. The session lives in a Chrome profile folder on **your** computer (`~/.flow-mcp/profiles/<name>`).

### Other MCP clients

```bash
node bin/flow-mcp.mjs install --client claude-desktop   # edits claude_desktop_config.json (keeps a .bak)
node bin/flow-mcp.mjs install --client print            # prints the JSON for Cursor, Codex, VS Code, Windsurf, …
```

Or add it by hand — the command is `node /full/path/to/flow-mcp/bin/flow-mcp.mjs serve`:

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/full/path/to/flow-mcp/bin/flow-mcp.mjs", "serve"] } } }
```

> Video generation takes 1–3 minutes per call. Pass `timeout: 300` for video and make sure your client's per-tool timeout is at
> least 10 minutes (Claude Code's default is fine; the MCP TypeScript SDK defaults to 60 s).

## Commands

```text
flow-mcp login [--name <id>] [--new-project]   connect a Google account (use --name to add more accounts)
flow-mcp install [--client ...]                register with your AI client
flow-mcp doctor                                check Node, Chrome, accounts
flow-mcp accounts                              list connected accounts
flow-mcp healthcheck [--account <id>]          is Flow's page still what the tool expects?
flow-mcp generate --prompt "…" [--mode image|video] [--model "Veo 3.1 - Lite"] [--max-credits 10] [--timeout 300]
flow-mcp download [--asset <id>] [--quality 720p]
flow-mcp upload --path <file in ~/.flow-mcp/uploads> [--confirm-rights]
```

Examples:

```bash
node bin/flow-mcp.mjs generate --prompt "a cat playing with yarn"                      # free image
node bin/flow-mcp.mjs generate --prompt "a cat playing with yarn" --mode video --model "Veo 3.1 - Lite"   # shows the cost, spends nothing
node bin/flow-mcp.mjs generate --prompt "a cat playing with yarn" --mode video --model "Veo 3.1 - Lite" --max-credits 10 --timeout 300
node bin/flow-mcp.mjs download                                                          # newest asset
```

## Multiple accounts

`flow-mcp login --name second` adds another account (own Chrome profile and port). Accounts are used one at a time, in order; the
next one is used **only** when the current one runs out of credits (never to dodge limits or warnings — they share your
machine and IP). Pass `account` to a tool to pick one explicitly.

## Where things live

Everything is under `~/.flow-mcp` (change with `FLOW_MCP_HOME`):

```text
accounts.json     connected accounts (ids, ports, project URLs — no secrets)
profiles/<id>/    one Chrome profile per account — THIS IS YOUR GOOGLE SESSION. Keep it private, never commit or share it.
downloads/        files saved by flow_download
uploads/          put files here to send them with flow_upload
logs/ state/      healthcheck logs, pacing and lock state
```

## Safety design

- **Credits:** never approves unknown costs, never clicks "Always approve", never picks paid "upscale" downloads unless you ask.
- **Local only:** Chrome's debugging port is bound to `127.0.0.1`. Never expose it: it controls a browser signed in to your account.
- **Uploads are fenced:** `flow_upload` only reads `~/.flow-mcp/uploads` and `downloads` (plus folders you list in
  `FLOW_MCP_UPLOAD_DIRS`), accepts only image/video extensions and no URLs — so a prompt-injected agent cannot ship your files to Google.
- **Legal confirmations stay human:** the video "rights" dialog is only accepted when a human tells the agent to pass `confirmRights`.
- **Pacing:** human-like mouse paths and timings, a minimum gap between generations, hourly/daily caps, and an automatic pause for
  hours if Google shows "unusual activity". Tunable through `FLOW_MCP_*` variables (see [`docs/GUIDE.md`](docs/GUIDE.md)).

See [SECURITY.md](SECURITY.md).

## When the site changes

Selectors live in one file, [`src/selectors.mjs`](src/selectors.mjs). `flow_healthcheck` (and every `flow_generate`, automatically,
before acting) verifies they still match the live page and refuses to continue with a clear message if Google changed something —
instead of failing three steps later with a confusing timeout. Logs go to `~/.flow-mcp/logs`. Run it on a schedule to find out the
day Google changes the page, and open an issue.

## Limits

- Portuguese (pt-BR) Flow interface only, for now (labels are matched by text). PRs adding other languages are welcome.
- Targets Flow's **chat-style composer**. Accounts that still get the classic panel are not supported.
- One action at a time (a lock serializes calls); videos take minutes.
- `aspect`/`count` for video are best-effort; verify the downloaded file.
- It automates a website; when Google changes it, things break until the selectors are updated.

## Development

```bash
npm install
npm test        # offline tests: MCP server over stdio, config, pacing, upload fence
```

Agent-facing manual (also served as the `flow://guide` MCP resource): [`docs/GUIDE.md`](docs/GUIDE.md).

## License

[MIT](LICENSE)
