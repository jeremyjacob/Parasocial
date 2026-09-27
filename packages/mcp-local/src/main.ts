#!/usr/bin/env node
// Local stdio bridge to Parasocial's MCP endpoint (§7). It forwards tools and resources to the
// remote /mcp session unchanged; with --channel it is also a Claude Code channel that pushes
// note activity into the session (see channel.ts).
//   parasocial-mcp --url https://host/mcp[?document=…] [--channel]
//   parasocial-mcp login --url https://host/mcp     sign in ahead of time (browser)
//   parasocial-mcp logout --url https://host/mcp
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Remote, VERSION } from "./remote";
import { forget } from "./auth";
import { NotePump, CHANNEL_INSTRUCTIONS } from "./channel";
import { log } from "./log";

const USAGE = "usage: parasocial-mcp [login|logout] --url <Parasocial MCP URL> [--channel]";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { url: { type: "string" }, channel: { type: "boolean", default: false } } });
if (!values.url) {
  console.error(USAGE);
  process.exit(2);
}
const url = new URL(values.url);
const command = positionals[0] ?? "serve";

if (command === "logout") {
  forget(url.origin);
  console.error(`Signed out of ${url.origin}`);
  process.exit(0);
}

const remote = new Remote(url);
await remote.connect();

if (command === "login") {
  await remote.close();
  console.error(`Signed in to ${url.origin}`);
  process.exit(0);
}
if (command !== "serve") {
  console.error(USAGE);
  process.exit(2);
}

const channel = values.channel;
const caps = remote.client.getServerCapabilities() ?? {};
const server = new Server(
  { name: "parasocial", version: VERSION },
  {
    capabilities: {
      tools: {},
      ...(caps.resources ? { resources: {} } : {}),
      ...(channel ? { experimental: { "claude/channel": {} } } : {}),
    },
    instructions: [channel ? CHANNEL_INSTRUCTIONS : null, remote.client.getInstructions()].filter(Boolean).join("\n\n"),
  },
);

const pump = channel
  ? new NotePump(
      (fn) => remote.call(fn),
      (e) => server.notification({ method: "notifications/claude/channel", params: e } as any),
    )
  : null;

server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const r = await remote.call((c) => c.listTools(req.params));
  // the pump already waits for notes; Claude waiting too would get each one twice
  return pump ? { ...r, tools: r.tools.filter((t) => t.name !== "wait_for_notes") } : r;
});

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params;
  const token = req.params._meta?.progressToken;
  const r = await remote.call((c) =>
    c.callTool({ name, arguments: args }, undefined, {
      signal: extra.signal,
      timeout: 10 * 60_000,
      resetTimeoutOnProgress: true,
      onprogress: token === undefined ? undefined : (p) => void extra.sendNotification({ method: "notifications/progress", params: { ...p, progressToken: token } }).catch(() => {}),
    }),
  );
  return r;
});

if (caps.resources) {
  server.setRequestHandler(ListResourcesRequestSchema, (req) => remote.call((c) => c.listResources(req.params)));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) => remote.call((c) => c.listResourceTemplates(req.params)));
  server.setRequestHandler(ReadResourceRequestSchema, (req) => remote.call((c) => c.readResource(req.params)));
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  pump?.stop();
  await remote.close();
  process.exit(0);
}
server.onclose = shutdown;
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);

await server.connect(new StdioServerTransport());
log(`connected to ${url.origin}${channel ? " (channel on)" : ""}`);
pump?.start();
