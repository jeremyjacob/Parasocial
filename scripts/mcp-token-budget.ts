// Prints the MCP server's fixed per-session context cost: each tool's definition (description +
// input schema, as tools/list sends it) and the server instructions, in characters and ~tokens.
//   bun scripts/mcp-token-budget.ts [--json] [--show <tool>…]
import { measureToolList, approxTokens } from "../packages/mcp/src/token-budget";

const m = await measureToolList();
const show = process.argv.indexOf("--show");
if (show >= 0) {
  for (const name of process.argv.slice(show + 1)) console.log(JSON.stringify(m.definitions.find((t) => t.name === name)));
  process.exit(0);
}
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...m, definitions: undefined }));
  process.exit(0);
}
const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`${"tool".padEnd(22)} ${pad("desc", 6)} ${pad("schema", 6)} ${pad("total", 6)} ${pad("~tok", 5)}`);
for (const t of [...m.tools].sort((a, b) => b.total - a.total)) console.log(`${t.name.padEnd(22)} ${pad(t.description, 6)} ${pad(t.schema, 6)} ${pad(t.total, 6)} ${pad(approxTokens(t.total), 5)}`);
console.log(`\n${m.tools.length} tools: ${m.total} chars (~${approxTokens(m.total)} tokens)`);
console.log(`instructions: ${m.instructions.total} chars (~${approxTokens(m.instructions.total)} tokens), ESSENTIALS ${m.instructions.essentials}`);
console.log(`per-session total: ${m.total + m.instructions.total} chars (~${approxTokens(m.total + m.instructions.total)} tokens)`);
