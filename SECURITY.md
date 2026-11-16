# Security

## What this tool holds

`flow-mcp` keeps a **logged-in Chrome profile** per connected Google account in `~/.flow-mcp/profiles/<id>` (or under
`FLOW_MCP_HOME`). That folder is equivalent to your Google session: anyone who gets it can act as you on Flow (and possibly on
other Google services signed in in that profile).

- Never commit, upload, sync or share that folder. The repository's `.gitignore` excludes it, but it normally lives outside the repo.
- The tool never reads or stores your password, 2-step codes or OAuth tokens. It only checks that a Google session cookie
  *exists* (by name) during `flow-mcp login`.
- Chrome's remote-debugging port is bound to `127.0.0.1` only. Do not forward or expose it (SSH tunnels, port forwards,
  containers with published ports): it gives full control of a browser signed in to your account.
- Use a dedicated Google account for automation if you can.

## Built-in guard rails

- Spending credits needs an explicit `maxCredits` ≥ the quoted cost; unknown costs are never approved; "Always approve" is never clicked.
- `flow_upload` reads only the uploads/downloads folders (plus `FLOW_MCP_UPLOAD_DIRS`), resolves symlinks, accepts only
  image/video extensions, and accepts no URLs.
- The video rights confirmation dialog is only accepted with an explicit `confirmRights: true`, which an agent must only set after a human confirmed.
- The server writes nothing to stdout besides MCP protocol messages.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository ("Security" tab → "Report a vulnerability") instead of a public issue.
