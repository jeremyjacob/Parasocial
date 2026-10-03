// api_reference: the modeling API's docs for agents, served as verbatim slices of the generated
// d.ts (resources.ts, from packages/api's declarations and JSDoc), so they can't drift from the
// code. Topics are the d.ts sections (one per source file; index.ts's module doc is the cheat sheet).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { API_DTS, API_INDEX, API_TABLES } from "./resources";
import { trace } from "./trace";

export const API_DTS_URI = "parasocial://api/parasocial.d.ts";

type Decl = (typeof API_INDEX.decls)[string];
const decls = API_INDEX.decls;
const topics = API_INDEX.topics;

const TOPIC_ALIASES: Record<string, string> = {
  "cheat-sheet": "cheatsheet", "cheat sheet": "cheatsheet", overview: "cheatsheet", index: "cheatsheet", quickstart: "cheatsheet",
  planes: "plane", conventions: "plane", axes: "plane",
  selectors: "selection", selector: "selection", select: "selection", filters: "selection", entities: "selection",
  sketches: "sketch", solids: "solid", booleans: "solid", paths: "path3d", path: "path3d",
  parts: "part", params: "part", studios: "part", naming: "part",
  assemblies: "assembly", joints: "assembly", connectors: "connector",
  unit: "units",
  standard: "std", "standard parts": "std", holes: "std/holes", tables: "std/tables",
};

const lower = new Map(Object.keys(decls).map((k) => [k.toLowerCase(), k]));

function topicOf(q: string) {
  const k = q.trim().toLowerCase().replace(/\.ts$/, "");
  const name = TOPIC_ALIASES[k] ?? k;
  return topics.find((t) => t.name === name);
}

/** Member text without the class's indentation. */
function dedent(text: string) {
  const lines = text.split("\n");
  const rest = lines.slice(1).filter((l) => l.trim());
  const pad = rest.length ? Math.min(...rest.map((l) => l.match(/^ */)![0].length)) : 0;
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(pad, l.match(/^ */)![0].length)))].join("\n");
}

const fileOf = (d: Decl) => topics.find((t) => t.name === d.topic)!.file;

function declText(name: string, keys = true): string {
  const d = decls[name];
  const text = d.text ?? API_DTS.slice(d.span[0], d.span[1]);
  const out = `// ${name} · ${fileOf(d)}\n${d.parent ? dedent(text) : leanText(text)}`;
  // object members declared as `screw: typeof screw;` (std.screw): follow to the real declaration
  const alias = d.parent && text.match(/:\s*typeof\s+([\w$]+);\s*$/)?.[1];
  const full = alias && decls[alias] && !decls[alias].parent ? `${out}\n${declText(alias, false)}` : out;
  return API_TABLES[name] ? `// ${name} · ${fileOf(d)}\n${tableText(name)}` : keys ? withKeys(full) : full;
}

// ── dimension tables (API_TABLES: std.tables data by constant name) ──

const IDENT = /^[A-Za-z_$][\w$]*$/;
const keyLit = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const isRow = (v: unknown) => !!v && typeof v === "object" && Object.values(v).every((x) => x === null || typeof x !== "object");
const fmt = (v: unknown): string => (v && typeof v === "object" ? `{ ${Object.entries(v).map(([k, x]) => `${keyLit(k)}: ${fmt(x)}`).join(", ")} }` : JSON.stringify(v));
const pathOf = (table: string, at: string[]) => `${API_TABLES[table].path}${at.map((k) => (IDENT.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join("")}`;

/** A table's doc comment on one line (it names the columns). */
function tableDoc(name: string) {
  const d = decls[name];
  const doc = d && API_DTS.slice(d.span[0], d.span[1]).match(/^\/\*\*([\s\S]*?)\*\//)?.[1];
  return doc ? doc.replace(/^\s*\* ?/gm, "").replace(/\s+/g, " ").trim() : "";
}

/** One line per row (`key: { d: 3, … }`), sub-tables (HEADS.ISO4762) indented. */
function tableLines(rows: Record<string, unknown>, indent = ""): string[] {
  return Object.entries(rows).flatMap(([k, v]) => (isRow(v) || !v || typeof v !== "object" ? [`${indent}${keyLit(k)}: ${fmt(v)}`] : [`${indent}${keyLit(k)}:`, ...tableLines(v as Record<string, unknown>, `${indent}  `)]));
}

function tableText(name: string, at: string[] = []) {
  let rows = API_TABLES[name].rows;
  for (const k of at) rows = rows[k];
  const doc = tableDoc(name);
  if (isRow(rows)) return `// ${pathOf(name, at)} (${name}): ${fmt(rows)}${doc ? `\n//   ${doc}` : ""}`;
  return [`// ${pathOf(name, at)} (${name})${doc ? `: ${doc}` : ""}`, ...tableLines(rows)].join("\n");
}

/** Leading keys of a table, capped: the values of `keyof typeof TABLE`. */
function keyList(table: string, cap = 80) {
  const keys = Object.keys(API_TABLES[table].rows);
  return keys.slice(0, cap).map((k) => JSON.stringify(k)).join(" | ") + (keys.length > cap ? ` | … (${keys.length - cap} more: api_reference "${API_TABLES[table].path}")` : "");
}

/** Type aliases that are `keyof typeof TABLE` (BearingSize → BEARINGS). */
const KEYOF = new Map<string, string>();
for (const [n, d] of Object.entries(decls)) {
  const m = !d.parent && !d.text && API_DTS.slice(d.span[0], d.span[1]).match(/=\s*keyof typeof ([\w$]+);\s*$/);
  if (m && API_TABLES[m[1]]) KEYOF.set(n, m[1]);
}

/** Declaration text plus the keys of every `keyof typeof TABLE` it uses, directly or by alias. */
function withKeys(text: string) {
  const lines = new Map<string, string>();
  for (const m of text.matchAll(/keyof typeof ([\w$]+)/g)) if (API_TABLES[m[1]]) lines.set(m[1], `// keyof typeof ${m[1]}: ${keyList(m[1])}`);
  for (const [alias, table] of KEYOF) if (!lines.has(table) && new RegExp(`\\b${alias}\\b`).test(text)) lines.set(table, `// ${alias}: ${keyList(table)}`);
  // name the alias rather than the bare `keyof typeof` when the declaration is the alias itself
  for (const [alias, table] of KEYOF) if (lines.get(table)?.startsWith("// keyof") && new RegExp(`type ${alias} =`).test(text)) lines.set(table, `// ${alias}: ${keyList(table)}`);
  return lines.size ? `${text}\n${[...lines.values()].join("\n")}` : text;
}

/** A table by constant name or path, optionally into its rows: "BEARINGS", "std.tables.bearings", "bearings[\"608\"]", "nuts.M3". */
function tablePath(q: string): string | undefined {
  const s = q.replace(/\[\s*["']?([^\]"']+)["']?\s*\]/g, ".$1").toLowerCase();
  let best: [string, string] | undefined;
  for (const [name, t] of Object.entries(API_TABLES))
    for (const p of [name, t.path, t.path.replace(/^std\./, ""), t.path.replace(/^std\.tables\./, "")].map((x) => x.toLowerCase()))
      if ((s === p || s.startsWith(`${p}.`)) && (!best || p.length > best[1].length)) best = [name, p];
  if (!best) return undefined;
  // the rest are keys, which can contain dots ("M2.5"): match whole keys greedily
  const at: string[] = [];
  let rows = API_TABLES[best[0]].rows;
  for (let rest = s.slice(best[1].length + 1); rest; ) {
    if (!rows || typeof rows !== "object") return undefined;
    const k = Object.keys(rows).filter((k) => rest === k.toLowerCase() || rest.startsWith(`${k.toLowerCase()}.`)).sort((a, b) => b.length - a.length)[0];
    if (!k) return undefined;
    at.push(k);
    rows = rows[k];
    rest = rest.slice(k.length + 1);
  }
  return tableText(best[0], at);
}

/** Every table entry keyed `q` ("6804", "M3x4", "M3"), at any depth: exact keys, else case-insensitive. */
function tableKey(q: string): string | undefined {
  const hits: [string, string[]][] = [];
  const walk = (table: string, rows: unknown, at: string[], eq: (k: string) => boolean) => {
    if (!rows || typeof rows !== "object" || isRow(rows) && at.length) return;
    for (const [k, v] of Object.entries(rows)) {
      if (eq(k)) hits.push([table, [...at, k]]);
      else walk(table, v, [...at, k], eq);
    }
  };
  for (const eq of [(k: string) => k === q, (k: string) => k.toLowerCase() === q.toLowerCase()]) {
    for (const [name, t] of Object.entries(API_TABLES)) walk(name, t.rows, [], eq);
    if (hits.length) break;
  }
  if (!hits.length) return undefined;
  // one doc line per table, not per row (M3 is in HEADS three times)
  const seen = new Set<string>();
  return hits.map(([table, at]) => {
    const text = tableText(table, at);
    if (seen.has(table)) return text.replace(/\n\/\/ {3}.*$/, "");
    seen.add(table);
    return text;
  }).join("\n");
}

/** `std.tables`: each table's path, columns and keys. */
function tablesIndex() {
  const lines = Object.entries(API_TABLES).map(([name, t]) => {
    const rows = t.rows as Record<string, unknown>;
    const sub = Object.values(rows).every((v) => !isRow(v) && v && typeof v === "object");
    const first = sub ? Object.values(Object.values(rows)[0] as object)[0] : Object.values(rows)[0];
    const cols = isRow(first) ? Object.keys(first as object).join(" ") : "";
    const keys = sub ? Object.entries(rows).map(([k, v]) => `${k}{${Object.keys(v as object).join(" ")}}`).join(" ") : Object.keys(rows).join(" ");
    return `${t.path} (${name}${cols ? `: ${cols}` : ""}): ${keys}`;
  });
  return `// std.tables: dimension tables (mm). api_reference "std.tables.bearings" for one table, a key ("6804") for its row.\n${lines.join("\n")}`;
}

/** Indentation from which declaration text counts as an inlined literal type (data, not API). */
const DEEP = 12;

/**
 * Collapse object types nested DEEP or more spaces in (`inserts: { … };`). The std section
 * inlines every dimension table as a literal type (~13k chars of `readonly M3x4: { readonly d: 3; … }`);
 * the tables have their own topic, std/tables.
 */
export function collapseDeep(text: string) {
  const out: string[] = [];
  let dropped = false;
  for (const line of text.split("\n")) {
    if (line.length - line.trimStart().length >= DEEP && line.trim()) {
      dropped = true;
      continue;
    }
    if (dropped && out.length && out[out.length - 1]!.trimEnd().endsWith("{") && /^\s*}/.test(line)) out[out.length - 1] = `${out[out.length - 1]!.trimEnd()} … ${line.trim()}`;
    else out.push(line);
    dropped = false;
  }
  return out.join("\n");
}

function topicText(name: string) {
  const t = topics.find((x) => x.name === name)!;
  // the cheat sheet is index.ts's module doc; the rest of that section is just export lists
  if (name === "cheatsheet") return t.doc ? API_DTS.slice(t.doc[0], t.doc[1]) : "";
  return leanText(API_DTS.slice(t.span[0], t.span[1]));
}

/** Declarations with inlined data collapsed, only where it dominates (std): elsewhere deep lines are real option types. */
function leanText(text: string) {
  const lean = collapseDeep(text);
  return text.length - lean.length > 4000 ? `${lean}\n// (… = inlined data, collapsed: api_reference "std.tables" lists the tables)` : text;
}

/** Declarations for one query: a table or table path, an exact name, a topic, a member name on any owner ("fillet"), or a table key ("6804"). */
export function lookup(query: string, preferTopic = false): { text: string; found: boolean } {
  const q = query.trim().replace(/\(\)$/, "");
  const t = topicOf(q);
  if (t && preferTopic) return { text: topicText(t.name), found: true };
  const table = tablePath(q);
  if (table) return { text: table, found: true };
  const exact = decls[q] ? q : lower.get(q.toLowerCase());
  if (exact === "std.tables") return { text: tablesIndex(), found: true };
  if (exact) return { text: declText(exact), found: true };
  if (t) return { text: topicText(t.name), found: true };
  // table rows are members of the table's literal type: tableKey answers those
  const members = Object.keys(decls).filter((k) => decls[k].parent && !API_TABLES[decls[k].parent!] && k.toLowerCase().endsWith(`.${q.toLowerCase()}`));
  // public owners first (Solid.fillet before ExtrudeOpts.fillet)
  members.sort((a, b) => Number(!!decls[decls[b].parent!]?.public) - Number(!!decls[decls[a].parent!]?.public));
  if (members.length) return { text: members.slice(0, 6).map(declText).join("\n\n") + (members.length > 6 ? `\n\n// also: ${members.slice(6).join(", ")}` : ""), found: true };
  const key = tableKey(q);
  if (key) return { text: key, found: true };
  const near = Object.keys(decls).filter((k) => k.toLowerCase().includes(q.toLowerCase())).slice(0, 20);
  return { text: `No declaration or topic "${q}".${near.length ? ` Close: ${near.join(", ")}.` : ""} Call api_reference with no arguments for the index.`, found: false };
}

/** Every public name by topic, with class (and tool object) members: the no-argument answer. */
export function apiIndex() {
  const lines = [
    `Modeling API (import { … } from "parasocial"): mm and degrees, Z up. api_reference({ symbol: "Solid.fillet" }) or ({ topic: "plane" }) returns declarations with docs and examples; ({ full: true }) the whole d.ts (also resource ${API_DTS_URI}).`,
    `topics: ${topics.map((t) => t.name).join(" ")}`,
  ];
  for (const t of topics) {
    const names = t.symbols.filter((n) => decls[n].public).map((n) => {
      const members = decls[n].members?.length ? decls[n].members! : Object.keys(decls).filter((k) => decls[k].parent === n).map((k) => k.slice(n.length + 1));
      return members.length ? `${n}{${members.join(" ")}}` : n;
    });
    if (names.length) lines.push(`${t.name}: ${names.join(" ")}`);
  }
  return lines.join("\n");
}

export const API_REFERENCE_DESCRIPTION =
  'Docs for the modeling API scripts import from "parasocial": declarations with JSDoc and examples. No arguments: every name by topic. symbol: "Solid.fillet", "plane.XZ", "fillet", a table ("std.tables.bearings"; "std.tables" lists them) or key ("6804"), or a list. topic: cheatsheet, plane (axes, normals), selection (selectors, filters), sketch, solid, path3d, part (params, names), assembly, connector, measure, units, types, std, std/holes, std/parts, std/tables. full: true is the whole d.ts.';

export function apiReference(args: { symbol?: string | string[]; topic?: string; full?: boolean }): { text: string; isError: boolean } {
  if (args.full) return { text: API_DTS, isError: false };
  const symbols = (Array.isArray(args.symbol) ? args.symbol : args.symbol ? args.symbol.split(/\s*,\s*/) : []).filter(Boolean);
  if (!args.topic && !symbols.length) return { text: apiIndex(), isError: false };
  const results = [...(args.topic ? [lookup(args.topic, true)] : []), ...symbols.map((s) => lookup(s))];
  return { text: results.map((r) => r.text).join("\n\n"), isError: results.every((r) => !r.found) };
}

/** Register the api_reference tool (read-only, no document needed). */
export function registerApiReference(server: McpServer, session: { id: string; clientName?: string; label?: string }) {
  const traceCall = trace(`tools-${session.id}`);
  server.registerTool(
    "api_reference",
    {
      description: API_REFERENCE_DESCRIPTION,
      inputSchema: {
        symbol: z.union([z.string(), z.array(z.string()).max(20)]).optional(),
        topic: z.string().optional(),
        full: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    } as any,
    (async (args: { symbol?: string | string[]; topic?: string; full?: boolean }) => {
      const t0 = Date.now();
      const r = apiReference(args ?? {});
      const result = { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
      traceCall({ session: session.id, client: session.clientName, label: session.label, tool: "api_reference", args, ms: Date.now() - t0, isError: r.isError, result: result.content });
      return result;
    }) as any,
  );
}
