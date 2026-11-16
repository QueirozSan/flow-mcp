#!/usr/bin/env node
// flow-mcp command line. Run with no arguments from an MCP client (stdin is not a terminal) it IS the MCP server;
// from a terminal it shows help.

const HELP = `flow-mcp — Google Flow image/video generation for AI agents (MCP server)

Setup (once):
  flow-mcp login [--name <id>] [--new-project]   connect a Google account (opens Chrome; you sign in with Google)
  flow-mcp install [--client claude-code|claude-desktop|print]   register the MCP server in your AI client
  flow-mcp doctor                                check Node, Chrome, accounts

Use:
  flow-mcp serve                                 run the MCP server on stdio (your AI client does this for you)
  flow-mcp accounts                              list connected accounts
  flow-mcp healthcheck [--account <id>]          check Flow's live page still matches what this tool drives
  flow-mcp generate --prompt "..." [--mode image|video] [--model "Veo 3.1 - Lite"] [--max-credits N] ...
  flow-mcp download [--asset <id>] [--quality 720p]
  flow-mcp upload --path <file in the uploads folder> [--confirm-rights]

Data folder: ~/.flow-mcp (override with FLOW_MCP_HOME). Docs: README.md`;

const [cmd, ...rest] = process.argv.slice(2);

async function run(modulePath) {
  const mod = await import(modulePath);
  await mod.main(rest);
}

switch (cmd) {
  case undefined:
    if (process.stdin.isTTY) console.log(HELP);
    else await import("../src/server.mjs");
    break;
  case "serve": await import("../src/server.mjs"); break;
  case "login": await run("../src/login.mjs"); break;
  case "install": await run("../src/install.mjs"); break;
  case "doctor": await run("../src/doctor.mjs"); break;
  case "healthcheck": await run("../src/healthcheck.mjs"); break;
  case "generate": await run("../src/generate.mjs"); break;
  case "download": await run("../src/download.mjs"); break;
  case "upload": await run("../src/upload.mjs"); break;
  case "accounts": {
    const { listAccounts } = await import("../src/config.mjs");
    console.log(JSON.stringify(listAccounts(), null, 2));
    break;
  }
  case "help": case "--help": case "-h": console.log(HELP); break;
  case "--version": case "-v": {
    const { readFileSync } = await import("node:fs");
    console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    break;
  }
  default:
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    process.exit(2);
}
