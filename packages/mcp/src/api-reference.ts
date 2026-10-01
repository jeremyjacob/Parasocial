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

function declText(name: string) {
  const d = decls[name];
  const text = d.text ?? API_DTS.slice(d.span[0], d.span[1]);
  return `// ${name} · ${fileOf(d)}\n${d.parent ? dedent(text) : text}`;
}

function topicText(name: string) {
  const t = topics.find((x) => x.name === name)!;
  // the cheat sheet is index.ts's module doc; the rest of that section is just export lists
  if (name === "cheatsheet") return t.doc ? API_DTS.slice(t.doc[0], t.doc[1]) : "";
  return API_DTS.slice(t.span[0], t.span[1]);
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
    const names = t.symbols.filter((n) => decls[n].public).map((n) => (decls[n].members?.length ? `${n}{${decls[n].members!.join(" ")}}` : n));
    if (names.length) lines.push(`${t.name}: ${names.join(" ")}`);
  }
  return lines.join("\n");
}

export const API_REFERENCE_DESCRIPTION =
  'Docs for the modeling API that scripts import from "parasocial", as its TypeScript declarations with JSDoc and examples. No arguments: index of every name by topic. symbol: a name like "Solid.fillet", "EntitySet.filter", "plane.XZ", "fillet", or several. topic: cheatsheet, plane (sketch axes and normals), selection (selectors and filters), sketch, solid, part (params, names), assembly, units, …. full: true returns the whole d.ts.';

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
        symbol: z.union([z.string(), z.array(z.string()).max(20)]).optional().describe('e.g. "Solid.fillet", "plane.XZ", "fillet", or a list'),
        topic: z.string().optional().describe("cheatsheet, plane, selection, sketch, solid, path3d, part, assembly, connector, units, types"),
        full: z.boolean().optional().describe("The whole d.ts"),
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
