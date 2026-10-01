import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as api from "@parasocial/api";
import { API_INDEX } from "../src/resources";
import { apiIndex, apiReference, lookup, registerApiReference, API_DTS_URI } from "../src/api-reference";
import { ESSENTIALS, INSTRUCTIONS } from "../src/instructions";
import { CHANNEL_INSTRUCTIONS } from "../../mcp-local/src/channel";

const root = join(import.meta.dir, "../../..");
const apiSrc = join(root, "packages/api/src");
const parse = (f: string) => ts.createSourceFile(f, readFileSync(join(apiSrc, f), "utf8"), ts.ScriptTarget.ES2022, true);

test("resources.ts (API d.ts and its index) is generated from the current packages/api", async () => {
  const p = Bun.spawn(["bun", join(root, "scripts/gen-mcp-resources.ts"), "--check"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  expect(code === 0 ? "" : await new Response(p.stderr).text()).toBe("");
}, 120_000);

/** Value and type names `packages/api/src/index.ts` exports. */
function publicExports() {
  const names = new Set<string>(Object.keys(api));
  for (const s of parse("index.ts").statements) if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) names.add(e.name.text);
  return [...names];
}

test("every public export is in the reference", () => {
  const index = apiIndex();
  const missing = publicExports().filter((n) => !API_INDEX.decls[n]?.public || !lookup(n).found || !new RegExp(`[ :]${n}[ {\\n]|[ :]${n}$`, "m").test(index));
  expect(missing).toEqual([]);
});

/** Members of an exported class that are private or @internal in the source. */
function hiddenMembers(className: string) {
  const hidden = new Set<string>(["constructor"]);
  for (const f of ["solid.ts", "sketch.ts", "selection.ts", "plane.ts", "path3d.ts"]) {
    for (const s of parse(f).statements) {
      if (!ts.isClassDeclaration(s) || s.name?.text !== className) continue;
      for (const m of s.members) {
        const name = (m as any).name?.text ?? (m as any).name?.escapedText;
        if (!name) continue;
        const priv = (ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Private) !== 0 || ts.isPrivateIdentifier((m as any).name);
        const internal = ts.getJSDocTags(m).some((t) => t.tagName.text === "internal") || /@internal/.test(m.getFullText().slice(0, m.getStart() - m.getFullStart()));
        if (priv || internal) hidden.add(String(name));
      }
    }
  }
  return hidden;
}

test("every public method and property of the exported classes and plane is in the reference", () => {
  const missing: string[] = [];
  for (const [name, value] of Object.entries(api)) {
    if (typeof value !== "function" || !/^class\s/.test(Function.prototype.toString.call(value))) continue;
    const hidden = hiddenMembers(name);
    const members = new Set<string>();
    for (let proto = (value as any).prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) for (const k of Object.getOwnPropertyNames(proto)) members.add(k);
    for (const m of members) if (!hidden.has(m) && !API_INDEX.decls[`${name}.${m}`]) missing.push(`${name}.${m}`);
  }
  for (const k of Object.keys(api.plane)) if (!API_INDEX.decls[`plane.${k}`]) missing.push(`plane.${k}`);
  expect(missing).toEqual([]);
  // and the index lists them
  expect(apiIndex()).toContain("Solid{");
  expect(apiIndex()).toMatch(/EntitySet\{[^}]*\bfilter\b[^}]*\bplanar\b/);
  expect(apiIndex()).toMatch(/plane\{XY XZ YZ/);
});

test("lookups return the d.ts declarations verbatim, with their docs and examples", () => {
  const fillet = apiReference({ symbol: "Solid.fillet" });
  expect(fillet.isError).toBe(false);
  expect(fillet.text).toContain("fillet(edges: EdgesArg, radius: number, opts?: OpOpts): Solid;");
  expect(fillet.text).toContain("@example");
  expect(apiReference({ symbol: "fillet" }).text).toContain("// Solid.fillet");
  expect(apiReference({ symbol: "sketch.extrude" }).text).toContain("// Sketch.extrude");
  expect(apiReference({ symbol: "plane.XZ" }).text).toMatch(/normal −Y/);
  expect(apiReference({ symbol: ["intersect", "EntitySet.planar"] }).text).toMatch(/intersect\([\s\S]*planar\(\)/);
  // topics: the d.ts section, module doc first
  const planeTopic = apiReference({ topic: "plane" }).text;
  expect(planeTopic).toContain("@module plane");
  expect(planeTopic).toMatch(/XZ\s+\(front\)\s+\+X\s+\+Z\s+−Y/);
  expect(planeTopic).toContain("export declare const plane");
  expect(apiReference({ topic: "selection" }).text).toContain("export declare class EntitySet");
  expect(apiReference({ topic: "sketch" }).text).toContain("export declare class Sketch");
  const cheat = apiReference({ topic: "cheatsheet" }).text;
  expect(cheat).toContain("@module parasocial");
  expect(cheat.length).toBeLessThan(5000);
  expect(apiReference({ full: true }).text.length).toBeGreaterThan(40_000);
  // unknown names say so and suggest close ones
  const miss = apiReference({ symbol: "Solid.filet" });
  expect(miss.isError).toBe(true);
  expect(apiReference({ symbol: "Plane.off" }).text).toContain("Plane.offset");
  // the index is compact
  expect(apiIndex().length).toBeLessThan(3500);
});

test("api_reference is an MCP tool", async () => {
  const server = new McpServer({ name: "test", version: "1" });
  registerApiReference(server, { id: "test-session" });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "api_reference");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(["full", "symbol", "topic"]);
    const text = async (args: Record<string, unknown>) => ((await client.callTool({ name: "api_reference", arguments: args })).content as { text: string }[])[0].text;
    expect(await text({})).toContain("topics: cheatsheet");
    expect(await text({ symbol: "EntitySet.filter" })).toContain("filter(pred: string | ((e: Entity) => boolean)): EntitySet;");
    expect(await text({ topic: "plane" })).toContain("@module plane");
    const bad = await client.callTool({ name: "api_reference", arguments: { symbol: "nope_nothing" } });
    expect(bad.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("instructions put the essentials and the docs pointers first", () => {
  // Claude Code keeps ~2048 chars of instructions, after a channel's own when it's one
  const kept = `${CHANNEL_INSTRUCTIONS}\n\n${ESSENTIALS}`;
  expect(kept.length).toBeLessThan(2048);
  for (const s of ["api_reference", API_DTS_URI, "claim_note", "set_note_status", "baseVersion", "list_notes", "mm and degrees", "normal −Y"]) expect(ESSENTIALS).toContain(s);
  expect(INSTRUCTIONS.startsWith(ESSENTIALS)).toBe(true);
});
