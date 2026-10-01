// The fixed context every agent session pays before doing anything: tool definitions (tools/list)
// plus server instructions. `bun scripts/mcp-token-budget.ts` prints the breakdown per tool.
import { expect, test } from "bun:test";
import { measureToolList } from "../src/token-budget";

test("tool definitions and instructions stay within their budget", async () => {
  const m = await measureToolList();
  // was 32.1k chars (44 tools) and 6.6k of instructions before the token-efficiency pass
  expect(m.total).toBeLessThan(22_000);
  expect(m.instructions.total).toBeLessThan(4_500);
  expect(m.tools.filter((t) => t.total > 2_000).map((t) => `${t.name}: ${t.total}`)).toEqual([]);
});

test("tools/list carries no schema boilerplate", async () => {
  const { definitions } = await measureToolList();
  const json = JSON.stringify(definitions);
  expect(json).not.toContain("$schema");
  expect(json).not.toContain(String(Number.MAX_SAFE_INTEGER));
  expect(json).not.toContain("taskSupport");
  // the `document` parameter is explained once in the instructions, not on every tool
  expect(json).not.toContain("defaults to this session's document");
  // validation is unchanged: integers are still integers
  const edit = (definitions as any[]).find((t) => t.name === "edit_script");
  expect(edit.inputSchema.properties.baseVersion).toEqual({ type: "integer" });
});
