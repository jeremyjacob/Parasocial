// api_reference: the modeling API's docs for agents, served as verbatim slices of the generated
// d.ts (resources.ts, from packages/api's declarations and JSDoc), so they can't drift from the
// code. Topics are the d.ts sections (one per source file; index.ts's module doc is the cheat sheet).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { API_DTS, API_INDEX } from "./resources";
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

function declText(name: string): string {
  const d = decls[name];
  const text = d.text ?? API_DTS.slice(d.span[0], d.span[1]);
  const out = `// ${name} · ${fileOf(d)}\n${d.parent ? dedent(text) : leanText(text)}`;
  // object members declared as `screw: typeof screw;` (std.screw): follow to the real declaration
  const alias = d.parent && text.match(/:\s*typeof\s+([\w$]+);\s*$/)?.[1];
  return alias && decls[alias] && !decls[alias].parent ? `${out}\n${declText(alias)}` : out;
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
  return text.length - lean.length > 4000 ? `${lean}\n// (… = inlined data, collapsed: see topic "std/tables")` : text;
}

/** Declarations for one query: an exact name, a topic, or a member name on any owner ("fillet"). */
export function lookup(query: string, preferTopic = false): { text: string; found: boolean } {
  const q = query.trim().replace(/\(\)$/, "");
  const t = topicOf(q);
  if (t && preferTopic) return { text: topicText(t.name), found: true };
  const exact = decls[q] ? q : lower.get(q.toLowerCase());
  if (exact) return { text: declText(exact), found: true };
  if (t) return { text: topicText(t.name), found: true };
  const members = Object.keys(decls).filter((k) => decls[k].parent && k.toLowerCase().endsWith(`.${q.toLowerCase()}`));
  // public owners first (Solid.fillet before ExtrudeOpts.fillet)
  members.sort((a, b) => Number(!!decls[decls[b].parent!]?.public) - Number(!!decls[decls[a].parent!]?.public));
  if (members.length) return { text: members.slice(0, 6).map(declText).join("\n\n") + (members.length > 6 ? `\n\n// also: ${members.slice(6).join(", ")}` : ""), found: true };
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
  'Docs for the modeling API scripts import from "parasocial": TypeScript declarations with JSDoc and examples. No arguments: every name by topic. symbol: e.g. "Solid.fillet", "plane.XZ", "fillet", or a list. topic: cheatsheet, plane (sketch axes, normals), selection (selectors, filters), sketch, solid, path3d, part (params, names), assembly, connector, measure, units, types, std (standard parts), std/holes, std/parts, std/tables. full: true is the whole d.ts (~100k chars).';

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
