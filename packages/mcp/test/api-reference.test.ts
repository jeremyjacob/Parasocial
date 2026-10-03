import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as api from "@parasocial/api";
import { API_DTS, API_INDEX, EXAMPLES } from "../src/resources";
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

test("names the docs use resolve: std.x / measure.x / plane.x paths, Class.member, aliased members", () => {
  // docs: the d.ts (minus its section headers), instructions and the example scripts
  const docs = [API_DTS.replace(/^\/\/ ───── .*$/gm, ""), INSTRUCTIONS, CHANNEL_INSTRUCTIONS, EXAMPLES].join("\n");
  const bad = new Set<string>();
  // namespaces: exported objects, and functions carrying members (measure)
  const spaces = Object.entries(api).filter(([, v]) => (typeof v === "object" && v) || (typeof v === "function" && !/^class\s/.test(Function.prototype.toString.call(v)) && Object.keys(v).length));
  for (const [ns, root] of spaces)
    for (const m of docs.matchAll(new RegExp(`(?<![\\w.])${ns}((?:\\.[A-Za-z_]\\w*)+)`, "g"))) {
      let v: any = root;
      for (const k of m[1].slice(1).split(".")) {
        if (v === null || (typeof v !== "object" && typeof v !== "function")) break; // a number's .toFixed etc.
        if (!(k in v)) {
          bad.add(`${ns}${m[1]}`);
          break;
        }
        v = v[k];
      }
    }
  // Class.member (`Solid.fillet`): a member the reference knows
  for (const m of docs.matchAll(/(?<![\w.])([A-Z]\w*)\.([a-z_]\w*)\b/g)) if (API_INDEX.decls[m[1]] && !API_INDEX.decls[`${m[1]}.${m[2]}`]) bad.add(m[0]);
  // `name: typeof other` in the d.ts shows agents a name the API doesn't have (std.mgnRailHoles was `typeof railHoles`)
  for (const m of API_DTS.matchAll(/(\w+): typeof (\w+);/g)) if (m[1] !== m[2]) bad.add(m[0]);
  expect([...bad]).toEqual([]);
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

test("dimension tables: keyof typeof keys inline, lookups by table, path and key", () => {
  const text = (s: string) => apiReference({ symbol: s }).text;
  // `keyof typeof BEARINGS` comes with its keys, for the alias and for declarations using it
  expect(text("BearingSize")).toMatch(/^\/\/ BearingSize: .*"6804"/m);
  expect(text("InsertSize")).toMatch(/^\/\/ InsertSize: .*"M3x4"/m);
  const bearing = text("std.bearing");
  expect(bearing.match(/^\/\/ BearingSize:/gm)?.length).toBe(1);
  // a key gives its row in every table that has it
  const row = text("6804");
  expect(row).toContain('std.tables.bearings["6804"] (BEARINGS): { d: 20, D: 32, B: 7 }');
  expect(row.length).toBeLessThan(300);
  expect(text("M3x4")).toContain("std.tables.inserts.M3x4 (INSERTS): { d: 3, od: 4.6, l: 4, hole: 4 }");
  const m3 = text("M3");
  for (const p of ["heads.ISO4762.M3", "heads.ISO7380.M3", "metric.M3", "nuts.M3", "washers.M3"]) expect(m3).toContain(`std.tables.${p} (`);
  expect(m3.match(/Head dimensions/g)?.length).toBe(1);
  // one table, by constant name or path, compact; into its rows by path
  for (const q of ["BEARINGS", "std.tables.bearings", "bearings"]) {
    const t = text(q);
    expect(t).toStartWith("// std.tables.bearings (BEARINGS): Deep-groove");
    expect(t).toContain('"6804": { d: 20, D: 32, B: 7 }');
    expect(t).not.toContain("INSERTS");
    expect(t.length).toBeLessThan(2500);
  }
  expect(text('std.tables.bearings["608"]')).toContain("{ d: 8, D: 22, B: 7 }");
  expect(text("METRIC.M2.5")).toContain('std.tables.metric["M2.5"] (METRIC): { d: 2.5, pitch: 0.45');
  expect(text("std.tables.heads.ISO7380")).toMatch(/^M3: \{ dk: 5\.7/m);
  // std.tables: an index of the tables, not their data
  const index = text("std.tables");
  expect(index).toContain("std.tables.bearings (BEARINGS: d D B): 608");
  expect(index).toContain("ISO7380{M3");
  expect(index.length).toBeLessThan(2000);
  // the tables topic is unchanged, and unknown keys still miss
  expect(apiReference({ topic: "tables" }).text).toContain("export declare const BEARINGS");
  expect(apiReference({ symbol: "6899" }).isError).toBe(true);
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
