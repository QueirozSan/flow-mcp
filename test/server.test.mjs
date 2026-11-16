// End-to-end smoke test of the MCP server over stdio, in a throw-away data folder (no browser, no Google account).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "flow-mcp.mjs");

async function withServer(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flow-mcp-test-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "serve"], env: { ...process.env, FLOW_MCP_HOME: home }, stderr: "pipe" });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  try { await fn(client, home); } finally { await client.close(); fs.rmSync(home, { recursive: true, force: true }); }
}

test("server lists the six tools and the guide resource", async () => {
  await withServer(async (client) => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["flow_download", "flow_generate", "flow_healthcheck", "flow_list_accounts", "flow_prepare_project", "flow_upload"]);
    const res = (await client.listResources()).resources.map((r) => r.uri);
    assert.ok(res.includes("flow://guide"));
    const guide = await client.readResource({ uri: "flow://guide" });
    assert.match(guide.contents[0].text, /flow_generate/);
  });
});

test("with no account connected, tools explain how to log in instead of crashing", async () => {
  await withServer(async (client) => {
    const r = await client.callTool({ name: "flow_generate", arguments: { prompt: "a red balloon" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /flow-mcp login/);
  });
});

test("flow_upload refuses paths outside the uploads/downloads folders", async () => {
  await withServer(async (client, home) => {
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.png`);
    fs.writeFileSync(outside, "x");
    try {
      const r = await client.callTool({ name: "flow_upload", arguments: { path: outside } });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /must be inside/);
    } finally { fs.rmSync(outside, { force: true }); }
  });
});
