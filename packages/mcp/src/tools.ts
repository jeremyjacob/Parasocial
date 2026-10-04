// MCP tools (§7). Every tool takes a `document` (defaulting to the session's). Writes go
// through the shared mutators as this agent session; geometry questions run in the engine pool
// (the same engine build the browser runs), so agents see exactly what the human sees.
import { z } from "zod";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mutators, newID, type NoteTarget } from "@parasocial/sync";
import { runMutator, readVersion, exportDocument, importDocument, buildDocumentZip, parseDocumentZip, signBlobURL, type Db, type BlobStore } from "@parasocial/sync/server";
import { EngineUnavailable, type PoolClient } from "@parasocial/engine-pool/client";
import { loadDoc, overridesFor, scriptMap, requireMember, AccessError, type DocState } from "./docs";
import { NoteCursor, type NoteEvents } from "./note-events";
import { documentContext } from "./document-context";
import { GUIDE, sessionContext } from "./instructions";
import { trace } from "./trace";
import { recordTouch, othersOn, changedUnderYou } from "./awareness";
import { emptyPreview, mergeOverrides, solveAssemblies, findAssembly, poseTarget, scopedJointValues, expandTargets, targetNames, closeMatches, posedBox, posedPoint, posedDir, type Preview } from "./preview";
import { sourcePart, type AssemblyInfo, type Overlap, type PartInfo, type PartPose } from "@parasocial/runtime/protocol";
import { overlapIntended } from "@parasocial/runtime/assembly-scope";
import { registerOutputTools } from "./tools-output";
import { affectedScripts, lineDiff, nameHints } from "./write-report";

export type Session = {
  id: string;
  userID: string;
  clientID: string;
  clientName: string;
  label?: string;
  defaultDocument?: string;
  /** active configuration per document (null = Default) */
  activeConfig: Map<string, string | null>;
  /** latest version this session created, per document (linked by replies) */
  lastVersion: Map<string, string>;
  calls: number[];
  /** wait_for_notes position per document; starts at connect (list_notes covers what came before) */
  noteCursors: Map<string, NoteCursor>;
  startedAt: number;
  /** Session-local param overrides and assembly joint values per document (set_param / set_pose scope "session"): seen only by this session, never saved. */
  preview?: Map<string, Preview>;
  /** The guide (instructions.ts) was delivered: in the instructions, or with this session's first tool result. */
  guided?: boolean;
};

export type ToolDeps = { db: Db; pool: PoolClient; store: BlobStore; noteEvents: NoteEvents; config: { appOrigin: string; secret: string } };

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };
/** What the SDK hands a tool besides its arguments (cancellation, progress). */
type Extra = { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };

class ToolError extends Error {
  constructor(
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

// Results are compact JSON: agents read every character of them, and indentation is ~a third of
// a pretty-printed result. Coordinates are mm, rounded to µm (3 decimals).
const text = (v: unknown): ToolResult => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
/** Outline lines: imports, top-level declarations, params and tags. */
const OUTLINE = /^(import|export)\b|^(async\s+)?(function|const|let|var|class|type|interface|enum)\b|\bparam\(|\btag:\s*["'`]/;
/**
 * A script to read: a header line (path, version, line count, range, other sessions), then
 * numbered lines ("12\t…", the numbers line edits take): all of them, a range, or an outline.
 * Plain text, not JSON: escaped source costs more tokens and is harder to read.
 */
function sourceListing(sc: { path: string; version: number; content: string }, others?: unknown, o: { offset?: number | undefined; limit?: number | undefined; outline?: boolean | undefined } = {}) {
  const lines = sc.content.split("\n");
  const from = Math.min(o.offset ?? 1, lines.length);
  const to = o.limit ? Math.min(from + o.limit - 1, lines.length) : lines.length;
  const range = o.outline ? "outline" : from > 1 || to < lines.length ? `lines ${from}–${to}` : "";
  const header = [sc.path, `version ${sc.version}`, `${lines.length} lines`, range, others ? `otherSessions ${JSON.stringify(others)}` : ""].filter(Boolean).join(" · ");
  const shown: string[] = [];
  let inImport = false; // a multi-line import: its names, up to the line with `from`
  for (let i = from - 1; i < to; i++) {
    const line = lines[i]!;
    const keep = !o.outline || inImport || OUTLINE.test(line);
    if (o.outline) inImport = (inImport || /^import\b/.test(line)) && !/\bfrom\s*["'`]|^import\s*["'`]/.test(line);
    if (keep) shown.push(`${i + 1}\t${line}`);
  }
  return `${header}\n${shown.join("\n")}`;
}
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const vec = (v?: number[]) => v?.map((x) => round(x, 3));
/** An object without its undefined, null and empty-array fields. */
const lean = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length))) as Partial<T>;
/** A long list cut to `max`, saying how many more there were. */
/** How long list_problems waits for regeneration before answering with the parts done so far. */
const listProblemsBudgetMs = () => Number(process.env.LIST_PROBLEMS_BUDGET_MS ?? 10_000);
const cap = <T>(xs: T[] | undefined, max: number): (T | string)[] | undefined => (xs && xs.length > max ? [...xs.slice(0, max), `+${xs.length - max} more`] : xs);
/**
 * `Unknown <what>: x. Did you mean "y"?` with a few close names per unknown key; when some have
 * none, a capped list of `names` and where to find the rest.
 */
function unknownMessage(what: string, unknown: string[], names: string[], rest: string) {
  const near = unknown.map((u) => [u, closeMatches(u, names)] as const);
  const quoted = (m: readonly string[]) => m.map((x) => `"${x}"`).join(", ");
  const head = near.length === 1 ? `${unknown[0]}.${near[0]![1].length ? ` Did you mean ${quoted(near[0]![1])}?` : ""}` : `${near.map(([u, m]) => (m.length ? `${u} (did you mean ${quoted(m)}?)` : u)).join(", ")}.`;
  return `Unknown ${what}: ${head}${near.every(([, m]) => m.length) ? "" : ` Known: ${cap([...new Set(names)], 12)!.join(", ") || "none"}; ${rest}`}`;
}

/**
 * tools/list as clients send it to the model: no JSON Schema `$schema` URL, no ±2^53 bounds that
 * zod adds to every integer, and no `execution` block when it only says the default (tasks forbidden).
 * About 3 kB less per session, with the same validation.
 */
export function compactToolList(server: McpServer) {
  const handlers = (server.server as any)._requestHandlers as Map<string, (req: unknown, extra: unknown) => Promise<{ tools: any[] }>> | undefined;
  const list = handlers?.get("tools/list");
  if (!handlers || !list || (list as any).compact) return;
  const strip = (s: any): any => {
    if (Array.isArray(s)) return s.map(strip);
    if (!s || typeof s !== "object") return s;
    const out: any = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "$schema") continue;
      if ((k === "minimum" || k === "maximum") && Math.abs(v as number) === Number.MAX_SAFE_INTEGER) continue;
      out[k] = strip(v);
    }
    return out;
  };
  const compact = Object.assign(
    async (req: unknown, extra: unknown) => {
      const r = await list(req, extra);
      return { ...r, tools: r.tools.map(({ execution, ...t }) => ({ ...t, inputSchema: strip(t.inputSchema), ...(execution && execution.taskSupport !== "forbidden" ? { execution } : {}) })) };
    },
    { compact: true },
  );
  handlers.set("tools/list", compact);
}

/** postgres.js errors raised while opening a connection, before any query was sent. */
const CONNECT_ERRORS = new Set(["CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const unreachableDb = (e: unknown) => !!e && typeof e === "object" && CONNECT_ERRORS.has((e as { code?: string }).code ?? "");

const LIMIT_PER_MIN = 240;
/**
 * Write results note regenerations slower than this: about a third of the engine pool's limit
 * (POOL_REGEN_TIMEOUT_MS, 10 s by default, set in the pool's process). Lower, heavy documents got
 * the note on every write; verbose results carry every part's timings anyway.
 */
export const SLOW_MS = 3000;
/** Default render size. Image input is billed by pixels (~w·h/750 tokens): 800×600 is ~640, 1024×768 was ~1050. */
const RENDER_SIZE = [800, 600] as const;

export function registerTools(server: McpServer, s: Session, deps: ToolDeps) {
  const { db, pool } = deps;
  const ctx = () => ({ userID: s.userID, agentSessionID: s.id });

  const docID = (d?: string) => {
    const id = d ?? s.defaultDocument;
    if (!id) throw new ToolError("No document given and this session has no default. Pass `document` (see list_documents).");
    return id;
  };

  async function mutate(mr: any) {
    const r = await runMutator(db, mr, ctx());
    if (r.ok) return;
    const d = r.details as { code?: string; path?: string; baseVersion?: number | null; current?: { content: string; version: number } | null; index?: number };
    if (!d.path || !("current" in d)) throw new ToolError(r.message, r.details);
    // script conflicts: never the whole file back (an agent re-reads what it needs), but what changed since its base
    const current = d.current ? { version: d.current.version, lines: d.current.content.split("\n").length } : null;
    let diff = "";
    if (d.code === "stale" && d.current && d.baseVersion != null) {
      // a script's version is the document version that last wrote it: that version's snapshot has the base
      const [b] = await db.sql`SELECT c.content FROM versions v JOIN script_contents c ON c.hash = v.snapshot->'scripts'->>${d.path}::text WHERE v.document_id = ${mr.args.documentID} AND v.number = ${d.baseVersion}`;
      diff = b ? `\nChanges since version ${d.baseVersion}:\n${lineDiff(b.content, d.current.content) || "(none)"}` : `\n${d.path} didn't exist at version ${d.baseVersion}.`;
    }
    const hint = d.code === "stale" || d.code === "exists" ? `\nbaseVersion is the document version that last changed this script (list_scripts / read_script)${current ? `: ${d.path} is at ${current.version}` : ""}.` : "";
    throw new ToolError(`${r.message}${hint}${diff}`, lean({ code: d.code, path: d.path, baseVersion: d.baseVersion, current, index: d.index }));
  }

  async function setStatus(status: "idle" | "working" | "writing", documentID?: string, detail?: Record<string, unknown> | null) {
    await runMutator(db, mutators.agent.setStatus({ id: s.id, status, documentID: documentID ?? null, ...(detail !== undefined ? { detail } : {}) } as any), ctx()).catch(() => {});
  }

  /** Append an activity-log entry to every note this session has claimed in the document. */
  async function activity(documentID: string, line: string) {
    const claimed = await db.sql`SELECT id FROM notes WHERE document_id = ${documentID} AND claimed_by = ${s.id} AND removed_at IS NULL`;
    for (const n of claimed) await runMutator(db, mutators.note.reply({ id: newID(), noteID: n.id, text: line, kind: "activity" } as any), ctx()).catch(() => {});
  }

  /** An unknown render/describe/export target, with close ids or a capped list of them. */
  const unknownTargets = (what: string, unknown: string[], parts: string[], infos: AssemblyInfo[]) =>
    new ToolError(unknownMessage(what, unknown, targetNames(parts, infos), "describe_model lists parts and assemblies (instance ids are <assembly>/<part>)."));

  function configOf(d: DocState) {
    const c = s.activeConfig.get(d.id) ?? null;
    return d.configurations.some((x) => x.id === c) ? c : null;
  }

  /** This session's preview (param overrides, joint values) for a document. */
  function previewOf(documentID: string): Preview {
    s.preview ??= new Map();
    let p = s.preview.get(documentID);
    if (!p) s.preview.set(documentID, (p = emptyPreview()));
    return p;
  }

  /** Run engine ops against the document's current state (active configuration of this session, plus its preview overrides). */
  async function engine(d: DocState, ops: { op: string; [k: string]: unknown }[]) {
    if (!ops.length) return [];
    const res = await pool.run({ document: `${d.id}:${configOf(d) ?? "default"}`, scripts: scriptMap(d), overrides: mergeOverrides(overridesFor(d, configOf(d)), s.preview?.get(d.id)), units: d.units, ops });
    return res.map((r: any, i: number) => {
      if (!r.ok) throw new ToolError(r.error, { op: ops[i].op });
      return r.value;
    });
  }

  /**
   * Part ids, discovered by the engine: a studio exports one part (`export default`, id `<file>`)
   * or several (named exports, ids `<file>:<export>`).
   */
  async function partsOf(d: DocState): Promise<string[]> {
    return (await partInfosOf(d)).map((p) => p.id);
  }

  async function partInfosOf(d: DocState): Promise<PartInfo[]> {
    const [infos] = await engine(d, [{ op: "parts" }]);
    return infos as PartInfo[];
  }

  /** Each studio's display name and description export, in path order. */
  function studiosOf(parts: readonly PartInfo[], assemblies: readonly AssemblyInfo[]) {
    const byFile = new Map<string, { file: string; name: string; description?: string }>();
    for (const x of [...parts, ...assemblies]) if (!byFile.has(x.file)) byFile.set(x.file, { file: x.file, name: x.studio, ...(x.studioDescription ? { description: x.studioDescription } : {}) });
    return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  }

  /**
   * Assemblies and where their instances are for this session: the document's saved joint values
   * (what people see), then this session's set_pose values on top. Regenerates the parts they use.
   */
  async function assemblyState(d: DocState, targets?: string[]) {
    const [infos] = (await engine(d, [{ op: "assemblies" }])) as [AssemblyInfo[]];
    const wanted = targets && new Set(targets.map((id) => findAssembly(infos, id)?.id ?? id));
    const needed = wanted ? infos.filter((a) => wanted.has(a.id) || a.subs.some((sub) => wanted.has(sub.id)) || a.instances.some((i) => wanted.has(i.id))) : infos;
    if (!needed.length) return { infos, poses: {} as Record<string, PartPose>, assemblies: [] as ReturnType<typeof solveAssemblies>["assemblies"] };
    const sources = [...new Set(needed.flatMap((a) => a.instances.map((i) => i.part)))];
    // not engine(): a part that fails to regenerate leaves its assembly unposed instead of failing the call
    const results = await pool.run({ document: `${d.id}:${configOf(d) ?? "default"}`, scripts: scriptMap(d), overrides: mergeOverrides(overridesFor(d, configOf(d)), s.preview?.get(d.id)), units: d.units, ops: sources.map((part) => ({ op: "regenerate", part })) });
    const meta = new Map(sources.map((p, i) => [p, results[i]?.ok ? (results[i] as any).value : undefined]));
    const [row] = await db.sql`SELECT settings FROM documents WHERE id = ${d.id}`;
    const shared = (row?.settings as any)?.poses;
    return { infos, ...solveAssemblies(needed, (p) => meta.get(p), shared && typeof shared === "object" ? shared : {}, s.preview?.get(d.id)?.poses, infos) };
  }

  /**
   * Regenerate parts. A part whose regeneration fails outright (it timed out or crashed the engine)
   * gets a result with that error as its problem: the other parts' results still come back.
   */
  async function regenerateParts(d: DocState, parts: string[]) {
    const res = await pool.run({ document: `${d.id}:${configOf(d) ?? "default"}`, scripts: scriptMap(d), overrides: mergeOverrides(overridesFor(d, configOf(d)), s.preview?.get(d.id)), units: d.units, ops: parts.map((part) => ({ op: "regenerate", part })) });
    return res.map((r: any, i: number) => {
      if (r.ok) return r.value;
      const problem = { severity: "error", kind: r.timeout ? "timeout" : "runtime", message: r.error };
      return { part: parts[i], name: parts[i], ok: false, partial: true, empty: true, problems: [problem], params: [], faces: [], edges: [], timings: { total: 0, ops: 0 } };
    });
  }

  /**
   * Regenerate parts in small jobs, waiting at most `ms`: a cold engine can take a minute on a big
   * document. Parts not done by then are undefined; their jobs keep running, so the host warms up.
   */
  async function regenerateWithin(d: DocState, parts: string[], ms: number) {
    const CHUNK = 8;
    const results: any[] = new Array(parts.length);
    let failure: unknown;
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < parts.length; i += CHUNK)
      jobs.push(regenerateParts(d, parts.slice(i, i + CHUNK)).then((r) => r.forEach((x, j) => (results[i + j] = x)), (e) => void (failure ??= e)));
    let timer!: ReturnType<typeof setTimeout>;
    const done = await Promise.race([Promise.all(jobs).then(() => true), new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)))]);
    clearTimeout(timer);
    if (failure) throw failure;
    return { results, done };
  }

  /** Regenerate parts; compact results in the shape the UI shows (§8 Errors). */
  async function regen(d: DocState, parts?: string[]) {
    parts ??= await partsOf(d);
    const out = await regenerateParts(d, parts);
    return out.map((r: any) => summarize(r));
  }

  /** "error studios/a.ts:12 message" (the location moved to the front). */
  const problemLine = (p: any) => {
    const at = p.source ? `${p.source.file}:${p.source.line}` : "";
    const message = at ? String(p.message).replace(/\s*\([^()]*(?::\d+(?::\d+)?|\.ts)\)\s*$/, "") : p.message;
    return `${p.severity}${at ? ` ${at}` : ""} ${message}`;
  };

  /** Per part: "ok", or its problem lines (and whether the workspace shows its last good geometry). */
  const partStatus = (results: any[]) =>
    Object.fromEntries(results.filter(Boolean).map((r: any) => [r.part, r.problems.length ? (r.partial && !r.empty ? [...r.problems.map(problemLine), "(showing last good geometry)"] : r.problems.map(problemLine)) : "ok"]));

  /** A regeneration result: part, name (when it differs), ok, problems (one line each), counts, bbox and volume; timings with `full`. */
  function summarize(r: any, full = false) {
    if (!r) return null;
    return lean({
      part: r.part,
      name: r.name !== r.part ? r.name : undefined,
      ok: r.ok,
      showingLastGoodGeometry: r.partial && !r.empty ? true : undefined,
      problems: full ? r.problems.map((p: any) => lean({ severity: p.severity, kind: p.kind, message: p.message, source: p.source && `${p.source.file}:${p.source.line}`, op: p.op, highlight: p.highlight && { ...p.highlight, names: cap(p.highlight.names, 10) } })) : r.problems.map(problemLine),
      faces: r.faces.length,
      edges: r.edges.length,
      bbox: r.bbox ? { min: vec(r.bbox.min), max: vec(r.bbox.max) } : undefined,
      volume: r.mass ? round(r.mass.volume, 2) : undefined,
      timingsMs: full ? lean({ total: round(r.timings.total, 1), script: r.timings.script !== undefined ? round(r.timings.script, 1) : undefined, ops: round(r.timings.ops, 1), opsRun: r.timings.opCount, mesh: r.timings.mesh !== undefined ? round(r.timings.mesh, 1) : undefined, slowest: r.timings.slowest?.map(opTime) }) : undefined,
    });
  }

  /** `intersect "slots" at studios/grille.ts:12 1840 ms` */
  const opTime = (o: { type: string; tag?: string; source?: { file: string; line: number }; ms?: number }) => `${o.type}${o.tag ? ` "${o.tag}"` : ""}${o.source ? ` at ${o.source.file}:${o.source.line}` : ""} ${Math.round(o.ms ?? 0)} ms`;

  /** A regeneration slow enough to matter against the engine's time limit: where its time went. */
  const slowLine = (r: any) => {
    const t = r?.timings;
    if (!t || t.total < SLOW_MS) return undefined;
    const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    return `${sec(t.total)} (geometry ${sec(t.ops)} in ${t.opCount ?? "?"} operations${t.mesh >= 100 ? `, meshing ${sec(t.mesh)}` : ""}); slowest: ${(t.slowest ?? []).slice(0, 3).map(opTime).join(", ") || "none"}`;
  };

  /**
   * An entity, compactly: name, type, measurements, and `by`, the operation that made it with its
   * source line (`type id #tag at file:line`, then helper calls in `via`). Neighbors: the adjacent
   * faces, left out of edges whose name already says them; `neighbors` caps them (0: none).
   * `context` adds part and kind (for lists that mix them).
   */
  function describeEntity(e: any, opts: { context?: boolean; neighbors?: number } = {}) {
    const measure = e.kind === "face" ? { area: round(e.area), normal: vec(e.normal), radius: e.radius && round(e.radius), axis: vec(e.axis) } : e.kind === "edge" ? { length: round(e.length), radius: e.radius && round(e.radius), direction: vec(e.axis) } : {};
    const c = e.createdBy;
    const tag = c?.tag && !String(c.id).endsWith(`/${c.tag}`) && c.id !== c.tag ? ` #${c.tag}` : "";
    const at = c?.source ? ` at ${c.source.file}:${c.source.line}` : "";
    const via = c?.chain?.map((x: any) => `${x.fn && !x.fn.startsWith("<") && x.fn !== "Object.eval [as body]" ? x.fn + "() at " : ""}${x.file}:${x.line}`).filter((s: string) => !c.source || s !== `${c.source.file}:${c.source.line}`);
    const max = opts.neighbors ?? 8;
    const neighbors = max && e.neighbors?.length && !e.neighbors.every((n: string) => String(e.name).includes(n)) ? cap(e.neighbors, max) : undefined;
    return lean({
      ...(opts.context ? { part: e.part, kind: e.kind } : {}),
      name: e.name,
      type: e.type,
      ...measure,
      center: vec(e.center),
      by: c ? `${c.type} ${c.id}${tag}${at}` : undefined,
      via,
      neighbors,
    });
  }

  /** Resolve a stable name (or selector) on a part to entity indices. */
  async function resolveName(d: DocState, part: string, name: string, kind?: "face" | "edge" | "vertex") {
    const kinds = kind ? [kind] : (["face", "edge", "vertex"] as const);
    for (const k of kinds) {
      const [idx] = await engine(d, [{ op: "indexOfName", part, kind: k, name }]);
      if ((idx as number[]).length) return { kind: k, indices: idx as number[] };
    }
    for (const k of kinds) {
      try {
        const [q] = await engine(d, [{ op: "query", part, expr: name, kind: k }]);
        if ((q as number[]).length) return { kind: k, indices: q as number[] };
      } catch {}
    }
    throw new ToolError(`No entity named or matching "${name}" on ${part}. Names come from list_notes, describe_model or query.`);
  }

  async function describeTargets(d: DocState, targets: NoteTarget[]) {
    const out = [];
    for (const t of targets) {
      if (t.kind === "studio") {
        out.push({ kind: t.kind, studio: t.studio, name: t.name, status: d.scripts.some((s) => s.path === t.studio) ? "name" : "orphaned", point: vec(t.point) });
        continue;
      }
      const part = t.part ?? (await partsOf(d))[0];
      if (t.kind === "part" || t.kind === "point") {
        out.push({ kind: t.kind, part, point: vec(t.point) });
        continue;
      }
      try {
        const [res] = await engine(d, [{ op: "resolve", part, targets: [{ kind: t.kind, name: t.name, query: t.query, point: t.point, normal: t.normal }] }]);
        const r = (res as any[])[0];
        if (r.status === "orphaned") {
          out.push({ kind: t.kind, part, name: t.name, status: "orphaned", point: vec(t.point), hint: "This geometry is gone; use the point and the snapshot (get_note) for intent." });
          continue;
        }
        const idx = r.indices.length > 1 ? (await engine(d, [{ op: "resolveOne", part, kind: t.kind, candidates: r.indices, point: t.point }]))[0] : r.indices[0];
        const [desc] = await engine(d, [{ op: "describe", part, kind: t.kind, index: idx }]);
        // resolvedBy/notePoint only when the name alone didn't find it (the geometry changed)
        out.push({ ...describeEntity(desc, { context: true }), ...(r.status !== "name" ? { resolvedBy: r.status, notePoint: vec(t.point) } : {}), splitInto: r.indices.length > 1 ? r.indices.length : undefined });
      } catch (e) {
        out.push({ kind: t.kind, part, name: t.name, status: "unresolved", error: (e as Error).message });
      }
    }
    return out;
  }

  /**
   * A note thread for an agent. The camera is left out (render({ view: "note:<id>" }) uses it), as
   * are false flags; the activity log (what agents did while holding it) is cut to its last lines;
   * the snapshot link comes with `full` (get_note).
   */
  type NoteData = { messages: any[]; strokes: any[]; number: number };
  async function noteData(documentID: string, ids: string[]): Promise<Map<string, NoteData>> {
    if (!ids.length) return new Map();
    const [messages, strokes, numbers] = await Promise.all([
      db.sql`SELECT m.note_id, m.kind, m.text, m.data, m.created_at, m.version_id, u.name AS user_name, a.client_name, a.label FROM note_messages m LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agent_sessions a ON a.id = m.author_agent_id WHERE m.note_id = ANY(${ids}) ORDER BY m.created_at`,
      db.sql`SELECT note_id, part, points, color FROM markup_strokes WHERE note_id = ANY(${ids})`,
      db.sql`SELECT id FROM notes WHERE document_id = ${documentID} ORDER BY created_at`,
    ]);
    const ordinals = new Map(numbers.map((n: any, i: number) => [n.id, i + 1]));
    const out = new Map(ids.map((id) => [id, { messages: [], strokes: [], number: ordinals.get(id) ?? 0 } as NoteData]));
    for (const m of messages) out.get(m.note_id)?.messages.push(m);
    for (const st of strokes) out.get(st.note_id)?.strokes.push(st);
    return out;
  }
  async function noteView(documentID: string, n: any, d: DocState, full = false, data?: Map<string, NoteData>) {
    const { messages, strokes, number } = (data ?? await noteData(documentID, [n.id])).get(n.id)!;
    const activity = messages.filter((m: any) => m.kind === "activity").map((m: any) => m.text as string);
    return lean({
      id: n.id,
      number,
      status: n.status,
      orphaned: n.orphaned || undefined,
      removed: n.removed_at ? true : undefined,
      claimedBy: n.claimed_by ?? undefined,
      author: n.author_agent_id ? "agent" : "human",
      configuration: n.anchor.configuration && n.anchor.configuration !== "Default" ? n.anchor.configuration : undefined,
      targets: await describeTargets(d, n.anchor.targets),
      markup: strokes.length ? strokes.map((st: any) => ({ part: st.part, color: st.color, points: st.points.length, from: vec(st.points[0]), to: vec(st.points[st.points.length - 1]) })) : undefined,
      snapshot: full && n.snapshot_hash ? signBlobURL(deps.config, { hash: n.snapshot_hash, documentID, basePath: "/api/blobs" }) : undefined,
      messages: messages
        .filter((m: any) => m.kind !== "activity")
        .map((m: any) => lean({ kind: m.kind, from: m.client_name ? `${m.client_name}${m.label ? ` (${m.label})` : ""}` : (m.user_name ?? "someone"), text: m.text, images: messageImages(m).length ? messageImages(m).map((hash) => signBlobURL(deps.config, { hash, documentID, basePath: "/api/blobs" })) : undefined, at: when(m.created_at), version: m.version_id ?? undefined })),
      activity: activity.length > 5 ? [`(${activity.length - 5} earlier)`, ...activity.slice(-5)] : activity,
    });
  }

  /** A timestamp to the minute (UTC). */
  const when = (ms: unknown) => `${new Date(Number(ms)).toISOString().slice(0, 16)}Z`;

  /** Images a person pasted into a message (blob hashes). */
  const messageImages = (m: { data?: { images?: unknown } | null }): string[] => (Array.isArray(m.data?.images) ? m.data.images.filter((h): h is string => typeof h === "string") : []);

  /** The images pasted into a note's thread, newest last, as image content (at most `max`). */
  async function noteImages(noteID: string, max = 8): Promise<Content[]> {
    const rows = await db.sql`SELECT data FROM note_messages WHERE note_id = ${noteID} AND kind = 'message' ORDER BY created_at`;
    const hashes = [...new Set(rows.flatMap((m: any) => messageImages(m)))].slice(-max);
    const out: Content[] = [];
    for (const hash of hashes) {
      const [b] = await db.sql`SELECT content_type FROM blobs WHERE hash = ${hash}`;
      const body = b ? await deps.store.get(hash) : null;
      if (!body) continue;
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      out.push({ type: "image", data: bytes.toString("base64"), mimeType: b!.content_type });
    }
    return out;
  }

  /** This session's latest version (never someone else's that landed in between). */
  async function latestVersion(documentID: string) {
    const [v] = await db.sql`SELECT id, number, message FROM versions WHERE document_id = ${documentID} AND author_agent_id = ${s.id} ORDER BY number DESC LIMIT 1`;
    return v ? { id: v.id as string, number: Number(v.number), message: v.message as string } : null;
  }

  async function storeFile(documentID: string, bytes: Uint8Array, contentType: string) {
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (!(await deps.store.has(hash))) await deps.store.put(hash, bytes, contentType);
    await db.sql`INSERT INTO blobs (hash, size, content_type, uploaded_by) VALUES (${hash}, ${bytes.length}, ${contentType}, ${s.userID}) ON CONFLICT (hash) DO NOTHING`;
    return signBlobURL(deps.config, { hash, documentID, basePath: "/api/blobs", ttlSeconds: 3600 });
  }

  /** A signed blob URL on the app origin. */
  const downloadURL = (url: string) => `${deps.config.appOrigin}${url.startsWith("/") ? "" : "/"}${url.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "")}`;

  // every call in full, for debugging (off unless AGENT_TRACE_DIR is set)
  const traceCall = trace(`tools-${s.id}`);

  /** Wrap a tool: rate limit, error shaping, last-seen, trace. */
  function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>, extra: Extra) => Promise<ToolResult>, annotations?: Record<string, boolean>) {
    server.registerTool(name, { description, inputSchema: shape as any, annotations }, (async (args: any, extra: Extra) => {
      const now = Date.now();
      s.calls = s.calls.filter((t) => now - t < 60_000);
      if (s.calls.length >= LIMIT_PER_MIN) return { isError: true, content: [{ type: "text", text: "Rate limit: too many calls this minute. Slow down and batch work." }] };
      s.calls.push(now);
      let result: ToolResult;
      let thrown: unknown;
      try {
        try {
          result = await fn(args, extra);
        } catch (e) {
          // the database connection couldn't be opened: no query got through, so one retry is safe
          if (!unreachableDb(e) || extra.signal?.aborted) throw e;
          await new Promise((r) => setTimeout(r, 300));
          result = await fn(args, extra);
        }
      } catch (e) {
        thrown = e;
        const known = e instanceof ToolError || e instanceof AccessError || e instanceof EngineUnavailable;
        const msg = known ? e.message : unreachableDb(e) ? `The database didn't answer (${(e as any).code}); nothing was changed. Retry shortly.` : `Internal error: ${(e as Error).message}`;
        const data = e instanceof ToolError ? e.data : undefined;
        // traces are dev-only: internal errors (and the engine being down) must also reach the server log
        if (e instanceof EngineUnavailable || unreachableDb(e)) console.warn(`mcp: ${name}: ${(e as Error).message}`);
        else if (!known) console.error(`mcp: ${name} failed (document ${s.defaultDocument?.slice(0, 8) ?? "?"})`, e);
        result = { isError: true, content: [{ type: "text", text: data ? `${msg}\n${JSON.stringify(data)}` : msg }] };
      }
      // the guide rides on the session's first result, once (instructions.ts), whatever the tool
      if (!s.guided) {
        s.guided = true;
        const context = await documentContext(db, s.userID, deps.config.appOrigin).catch(() => null);
        result = { ...result, content: [...result.content, { type: "text", text: `${GUIDE}\n\n${sessionContext(s.defaultDocument, context)}` }] };
      }
      traceCall({ session: s.id, client: s.clientName, label: s.label, document: s.defaultDocument, tool: name, args, ms: Date.now() - now, isError: !!result.isError, result: result.content, ...(thrown && !(thrown instanceof ToolError) ? { exception: thrown } : {}) });
      return result;
    }) as any);
  }

  // the instructions say once that `document` defaults to the session's document (not on every tool)
  const document = z.string().optional();

  // ---------------- documents ----------------
  const documentURL = (id: string) => new URL(`/d/${encodeURIComponent(id)}`, deps.config.appOrigin).href;
  const documentName = z.string().trim().min(1).max(200);

  tool("list_documents", "Documents you can access, newest edits first; query filters by name.", { query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) }, async ({ query, limit, offset }) => {
    const rows = await db.sql`SELECT d.id, d.name, d.updated_at, d.head_version, m.role FROM documents d JOIN document_members m ON m.document_id = d.id AND m.user_id = ${s.userID}
      WHERE strpos(lower(d.name), lower(${query ?? ""})) > 0 ORDER BY d.updated_at DESC, d.id LIMIT ${limit + 1} OFFSET ${offset}`;
    // one URL pattern instead of a URL per document
    return text({ default: s.defaultDocument, url: documentURL("{id}").replace(encodeURIComponent("{id}"), "{id}"), documents: rows.slice(0, limit).map((r) => ({ id: r.id, name: r.name, role: r.role, version: Number(r.head_version), updated: when(r.updated_at) })), nextOffset: rows.length > limit ? offset + limit : undefined });
  }, { readOnlyHint: true });

  tool("get_document_context", "The user's recent browser activity (a hint, not a list of open tabs) and this session's default document.", {}, async () =>
    text({ default: s.defaultDocument, ...await documentContext(db, s.userID, deps.config.appOrigin) }), { readOnlyHint: true });

  tool("open_document", "Make a document (id or document URL) this session's default; returns its scripts and configurations. Doesn't affect the human's browser.", { document: z.string().min(1) }, async ({ document: target }) => {
    let id = target;
    if (/^https?:\/\//i.test(target)) {
      const url = new URL(target);
      const match = url.pathname.match(/^\/d\/([^/]+)\/?$/);
      if (url.origin !== new URL(deps.config.appOrigin).origin || !match) throw new ToolError("Use a document URL from this Parasocial instance.");
      id = decodeURIComponent(match[1]!);
    }
    const d = await loadDoc(db, s.userID, id);
    s.defaultDocument = id;
    await setStatus("idle", id);
    // warm the engine in the background: the first list_problems or describe_model is then fast
    partsOf(d).then((parts) => regenerateParts(d, parts)).catch(() => {});
    return text({ id, name: d.name, url: documentURL(id), units: d.units, scripts: d.scripts.map((f) => f.path), configurations: d.configurations.map((c) => ({ id: c.id, name: c.name })) });
  }, { readOnlyHint: true });

  tool("create_document", "Create an empty document (then write studios/<name>.ts). It becomes the default only if the session has none.", { name: documentName }, async ({ name }) => {
    const id = newID();
    await mutate(mutators.document.create({ id, name }));
    s.defaultDocument ??= id;
    return text({ id, name, url: documentURL(id) });
  });

  tool("rename_document", "Rename a document (editor access).",{ document, name: documentName }, async ({ document: dd, name }) => {
    const id = docID(dd);
    await mutate(mutators.document.rename({ id, name }));
    return text({ id, name, url: documentURL(id) });
  });

  tool("duplicate_document", "Copy a document's scripts, settings and configurations (not notes or history) into a new document you own. The session default stays.",{ document, name: documentName.optional() }, async ({ document: dd, name }) => {
    const payload = await exportDocument(db, docID(dd), s.userID, { notes: false });
    const copyName = name ?? `${payload.manifest.name.slice(0, 193)} (copy)`;
    const { documentID: id } = await importDocument(db, payload, ctx(), { name: copyName });
    return text({ id, name: copyName, url: documentURL(id) });
  });

  tool("delete_document", "Permanently delete a document with its notes and history (owner only, explicit id). Only when the user asks for it.",{ document: z.string().min(1) }, async ({ document: id }) => {
    await mutate(mutators.document.delete({ id }));
    if (s.defaultDocument === id) s.defaultDocument = undefined;
    s.activeConfig.delete(id);
    s.lastVersion.delete(id);
    s.noteCursors.delete(id);
    return text({ id, deleted: true });
  }, { destructiveHint: true });

  // ---------------- notes ----------------
  tool(
    "list_notes",
    "Note threads (default: all unresolved) with each target described (stable name, measurements, the operation and source line that made it), markup and messages. get_note adds the snapshot and pasted images. studio: a studio script path, for studio-level notes.",
    { document, status: z.enum(["Open", "AgentWorking", "Resolved", "all"]).optional(), part: z.string().optional(), studio: z.string().optional() },
    async ({ document: dd, status, part, studio }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const rows = await db.sql`SELECT * FROM notes WHERE document_id = ${documentID} AND removed_at IS NULL ORDER BY created_at`;
      const want = rows.filter((n: any) => (!status || status === "all" ? n.status !== "Resolved" : n.status === status) && (!part || n.anchor.targets.some((t: NoteTarget) => t.part === part)) && (!studio || n.anchor.targets.some((t: NoteTarget) => t.kind === "studio" && t.studio === studio)));
      const data = await noteData(documentID, want.map((n: any) => n.id));
      const out = [];
      for (const n of want) out.push(await noteView(documentID, n, d, false, data));
      return text({ notes: out });
    },
    { readOnlyHint: true },
  );

  tool("get_note", "One note thread like list_notes, with its snapshot link, followed by the images pasted into it (in messages[].images order).", { document, id: z.string() }, async ({ document: dd, id }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    const [n] = await db.sql`SELECT * FROM notes WHERE id = ${id} AND document_id = ${documentID}`;
    if (!n) throw new ToolError(`No note ${id} in this document.`);
    const view = text(await noteView(documentID, n, d, true));
    return { content: [...view.content, ...(await noteImages(n.id))] };
  });

  tool(
    "wait_for_notes",
    "Block until a human adds a note or replies (notes other agents hold are skipped); returns those notes like list_notes, each with a `reason`, then their pasted images. At the timeout (default 50 s) returns { notes: [] }: call again. Each call continues where the last stopped, from when this session connected (list_notes covers earlier). allDocuments: wait on every document you can access (notes then carry `document`).",
    {
      document,
      allDocuments: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(1).max(600).optional(),
    },
    async ({ document: dd, allDocuments, timeoutSeconds }, extra) => {
      let documentIDs: string[];
      if (allDocuments) {
        // re-read per call so documents created or shared since the last one are included
        documentIDs = (await db.sql`SELECT document_id FROM document_members WHERE user_id = ${s.userID}`).map((r: any) => r.document_id);
      } else {
        documentIDs = [docID(dd)];
        await requireMember(db, s.userID, documentIDs[0]);
      }
      const key = allDocuments ? "*" : documentIDs[0];
      let cursor = s.noteCursors.get(key);
      if (!cursor) s.noteCursors.set(key, (cursor = new NoteCursor(s.startedAt)));
      // progress keeps clients that reset their timeout on progress from giving up on a long wait
      const token = extra._meta?.progressToken;
      let tick = 0;
      const beat = token === undefined ? undefined : setInterval(() => extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++tick, message: "waiting for notes" } }).catch(() => {}), 15_000);
      try {
        const found = await deps.noteEvents.wait(documentIDs, cursor, s.id, { timeoutMs: (timeoutSeconds ?? 50) * 1000, signal: extra.signal });
        if (!found.length) return text({ notes: [] });
        const docs = new Map<string, DocState>();
        const notes = [];
        const images: Content[] = [];
        for (const a of found) {
          const [n] = await db.sql`SELECT * FROM notes WHERE id = ${a.noteID}`;
          if (!n) continue;
          let d = docs.get(a.documentID);
          if (!d) docs.set(a.documentID, (d = await loadDoc(db, s.userID, a.documentID)));
          const reason = { created: a.created || undefined, replies: a.replies.length ? a.replies.map((r) => ({ author: r.author, text: r.text })) : undefined };
          notes.push({ reason, ...(allDocuments ? { document: { id: d.id, name: d.name, url: documentURL(d.id) } } : {}), ...(await noteView(a.documentID, n, d)) });
          if (images.length < 8) images.push(...(await noteImages(n.id, 8 - images.length)));
        }
        return { content: [...text({ notes }).content, ...images] };
      } finally {
        clearInterval(beat);
      }
    },
    { readOnlyHint: true },
  );

  tool(
    "reply_to_note",
    "Reply on a note: resolves it (status Open for questions or unfinished work), links your latest version (or `version`) and releases your claim. One to three sentences: what changed or what you need, not a recap.",
    { document, id: z.string(), text: z.string().min(1), version: z.string().optional(), status: z.enum(["Resolved", "Open"]).optional() },
    async ({ document: dd, id, text: body, version, status }) => {
      const documentID = docID(dd);
      await requireMember(db, s.userID, documentID);
      let versionID = version ?? s.lastVersion.get(documentID);
      if (!versionID) {
        // a previous connection of this agent made the change
        const [v] = await db.sql`SELECT id FROM versions WHERE document_id = ${documentID} AND author_agent_id = ${s.id} ORDER BY number DESC LIMIT 1`;
        versionID = v?.id;
      }
      // status first: it fails (with the holder) if another agent has the note, and then nothing is posted
      await mutate(mutators.note.setStatus({ noteID: id, status: status ?? "Resolved" }));
      await mutate(mutators.note.reply({ id: newID(), noteID: id, text: body, versionID } as any));
      const [n] = await db.sql`SELECT claimed_by FROM notes WHERE id = ${id}`;
      if (n?.claimed_by === s.id) await mutate(mutators.note.release({ noteID: id }));
      await setStatus("idle", documentID, null);
      return text({ ok: true, linkedVersion: versionID ?? null, status: status ?? "Resolved" });
    },
  );

  tool("claim_note", "Claim a note before working on it; fails with the holder's name if another session has it.", { document, id: z.string() }, async ({ document: dd, id }) => {
    const documentID = docID(dd);
    await requireMember(db, s.userID, documentID);
    await mutate(mutators.note.claim({ noteID: id }));
    return text({ ok: true, claimed: id });
  });

  tool("release_note", "Release a note you claimed, e.g. when you stop working on it.", { document, id: z.string() }, async ({ document: dd, id }) => {
    const documentID = docID(dd);
    await requireMember(db, s.userID, documentID);
    await mutate(mutators.note.release({ noteID: id }));
    await setStatus("idle", documentID, null);
    return text({ ok: true });
  });

  tool("set_note_status", "Set a note's status and release its claim. Resolve verified work without asking; no reply needed (reply_to_note only to add something useful).", { document, id: z.string(), status: z.enum(["Open", "Resolved"]) }, async ({ document: dd, id, status }) => {
    await requireMember(db, s.userID, docID(dd));
    await mutate(mutators.note.setStatus({ noteID: id, status }));
    return text({ ok: true });
  });

  tool("delete_note", "Remove a finished note (soft delete; humans can restore it).", { document, id: z.string() }, async ({ document: dd, id }) => {
    await requireMember(db, s.userID, docID(dd));
    await mutate(mutators.note.remove({ noteID: id }));
    return text({ ok: true });
  });

  tool("get_selection", "The human's current workspace selection, described like note targets.", { document }, async ({ document: dd }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    const [p] = await db.sql`SELECT selection FROM presence WHERE document_id = ${documentID} AND user_id = ${s.userID} AND agent_session_id IS NULL ORDER BY updated_at DESC LIMIT 1`;
    const sel = (p?.selection ?? []) as any[];
    if (!sel.length) return text({ selection: [], hint: "Nothing is selected in the workspace." });
    return text({ selection: await describeTargets(d, sel.map((e) => ({ ...e, point: [0, 0, 0] }))) });
  }, { readOnlyHint: true });

  // ---------------- scripts ----------------
  tool("list_scripts", "Script paths with version (baseVersion for writes) and line count; content: true includes every script's source like read_script (costly on big documents: prefer read_script outlines).", { document, content: z.boolean().optional() }, async ({ document: dd, content }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    // only content counts as read (changedByOthers compares against what this session has seen)
    if (content) for (const x of d.scripts) recordTouch(s, documentID, x.path, "read", x.version);
    const others = await othersOn(db, s, documentID, d.scripts.map((x) => x.path));
    if (content) return text(d.scripts.map((x) => sourceListing(x, others[x.path])).join("\n\n"));
    return text({ scripts: d.scripts.map((x) => ({ path: x.path, version: x.version, lines: x.content.split("\n").length, ...(others[x.path] ? { otherSessions: others[x.path] } : {}) })) });
  }, { readOnlyHint: true });

  tool(
    "read_script",
    "A script as numbered lines (line edits use the numbers) under a header with its version (the document version that last changed it: baseVersion for writes) and other sessions on it. offset (1-based) and limit read a range; outline: true shows only imports, top-level declarations, params and tags.",
    { document, path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional(), outline: z.boolean().optional() },
    async ({ document: dd, path, offset, limit, outline }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const sc = d.scripts.find((x) => x.path === path);
      if (!sc) throw new ToolError(`No script at ${path}. Scripts: ${d.scripts.map((x) => x.path).join(", ") || "none"}`);
      // an outline isn't a read of the content: changedByOthers still warns about edits made since
      if (!outline) recordTouch(s, documentID, path, "read", sc.version);
      const others = (await othersOn(db, s, documentID, [path]))[path];
      return text(sourceListing(sc, others, { offset, limit, outline }));
    },
    { readOnlyHint: true },
  );

  tool(
    "search_scripts",
    "Regex search (JavaScript syntax) over every script: \"path:line: text\" per match and the matching scripts' versions. Find usages without reading whole files. path: prefix filter (\"lib/\"); context: lines around; limit: default 100.",
    { document, pattern: z.string().min(1).max(500), path: z.string().optional(), ignoreCase: z.boolean().optional(), context: z.number().int().min(0).max(10).optional(), limit: z.number().int().min(1).max(1000).optional() },
    async ({ document: dd, pattern, path, ignoreCase, context, limit }) => {
      const d = await loadDoc(db, s.userID, docID(dd));
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignoreCase ? "i" : "");
      } catch (e) {
        throw new ToolError(`Invalid regular expression: ${(e as Error).message}`);
      }
      const max = limit ?? 100;
      const around = context ?? 0;
      const matches: string[] = [];
      const versions: Record<string, number> = {};
      let count = 0;
      for (const sc of d.scripts) {
        if (path && !sc.path.startsWith(path)) continue;
        const lines = sc.content.split("\n");
        let shownTo = -1;
        lines.forEach((line, i) => {
          if (!re.test(line)) return;
          count++;
          versions[sc.path] = sc.version;
          if (count > max) return;
          // matches with context: the lines around, each line once; "-" marks context, ":" a match
          const from = Math.max(i - around, shownTo + 1);
          if (around && matches.length && from > shownTo + 1) matches.push("--");
          for (let k = from; k <= Math.min(i + around, lines.length - 1); k++) {
            matches.push(`${sc.path}:${k + 1}${k === i ? ":" : "-"} ${lines[k].length > 300 ? `${lines[k].slice(0, 300)}…` : lines[k]}`);
            shownTo = k;
          }
        });
      }
      return text(lean({ count, matches, truncated: count > max ? `first ${max} of ${count}; pass limit or a narrower pattern/path` : undefined, versions: Object.keys(versions).length ? versions : undefined }));
    },
    { readOnlyHint: true },
  );

  tool("evaluate", "Evaluate an expression in a script's module scope, e.g. expr \"winch().drumFront\". Params: defaults and shared overrides, or part's (with previews) if given.", { document, script: z.string(), expr: z.string().min(1).max(4000), part: z.string().optional() }, async ({ document: dd, script, expr, part }) => {
    const d = await loadDoc(db, s.userID, docID(dd));
    if (!d.scripts.some((x) => x.path === script)) throw new ToolError(`No script at ${script}. Scripts: ${d.scripts.map((x) => x.path).join(", ") || "none"}`);
    const [r] = await engine(d, [{ op: "evaluate", script, expr, ...(part ? { part } : {}) }]);
    return text(r);
  }, { readOnlyHint: true });

  /**
   * After a committed write: our version and new script versions, the parts the change reaches
   * regenerated (studios written, or importing a written file; every part with `all` or `verbose`),
   * "ok" counted and problem lines per part or file, imports of missing files, and who else is on
   * these files. Nothing here may fail the call, since the write already landed: problems come back
   * in the result.
   */
  async function afterWrite(documentID: string, label: string, w: { versionID: string; paths: string[]; verbose?: boolean | undefined; all?: boolean }) {
    const [v] = await db.sql`SELECT id, number, message FROM versions WHERE id = ${w.versionID}`;
    // our own version, by id: the document's latest may already be someone else's
    const version = v ? { id: v.id as string, number: Number(v.number), message: v.message as string } : null;
    if (version) s.lastVersion.set(documentID, version.id);
    const rows = await db.sql`SELECT path, version FROM scripts WHERE document_id = ${documentID} AND path = ANY(${w.paths})`;
    const scripts: Record<string, number | null> = {};
    for (const p of w.paths) {
      const r = rows.find((x: any) => x.path === p);
      scripts[p] = r ? Number(r.version) : null; // null: deleted
      if (r) recordTouch(s, documentID, p, version ? "write" : "read", Number(r.version));
    }
    // the version's message is the caller's own (or a default): not echoed back
    const out: Record<string, unknown> = { ok: true, version: version && { id: version.id, number: version.number }, ...(version ? {} : { unchanged: "already up to date (nothing new was written)" }), scripts };
    let failed = false;
    try {
      const d = await loadDoc(db, s.userID, documentID);
      const [infos, asms] = (await engine(d, [{ op: "parts" }, { op: "assemblies" }])) as [PartInfo[], AssemblyInfo[]];
      const { affected, missing } = affectedScripts(new Map(d.scripts.map((x) => [x.path, x.content])), w.paths);
      const every = w.all || w.verbose;
      const parts = infos.filter((p) => every || affected.has(p.file)).map((p) => p.id);
      // a studio with neither parts nor assemblies failed to load: regenerating its stem reports why
      const silent = d.scripts.map((x) => x.path).filter((f) => /^studios\/.*\.ts$/.test(f) && (every || affected.has(f)) && !infos.some((p) => p.file === f) && !asms.some((a) => a.file === f));
      const raw = await regenerateParts(d, [...parts, ...silent.map((f) => f.slice("studios/".length, -".ts".length))]);
      const bad = raw.filter((r: any) => r?.problems.length);
      failed = bad.some((r: any) => !r.ok);
      const problems: Record<string, string[]> = {};
      for (const r of bad as any[]) problems[r.part] = [...(cap(r.problems.map(problemLine), 6) as string[]), ...(r.partial && !r.empty ? ["(showing last good geometry)"] : [])];
      for (const a of asms) if (a.problems.length && (every || affected.has(a.file))) problems[a.id] = cap(a.problems.map(problemLine), 6) as string[];
      // imports of files that don't exist, unless that file's load error is already listed
      const reported = new Set(bad.flatMap((r: any) => r.problems.map((p: any) => p.source?.file)));
      for (const [file, gone] of missing) if (!reported.has(file)) (problems[file] ??= []).push(...gone.map((g) => `warning ${file} imports ${g}, which doesn't exist`));
      out.parts = lean({ regenerated: raw.length, ok: raw.length - bad.length, unaffected: infos.length - parts.length || undefined });
      if (Object.keys(problems).length) out.problems = problems;
      // regenerations getting close to the time limit: where the time went (verbose has every part's)
      const slow = Object.fromEntries(raw.map((r: any) => [r.part, slowLine(r)]).filter(([, l]) => l));
      if (Object.keys(slow).length) out.slow = slow;
      // one file edited and other files broke: the change probably needed them too, in the same version
      if (w.paths.length === 1 && Object.keys(problems).some((id) => { const f = infos.find((p) => p.id === id)?.file ?? asms.find((a) => a.id === id)?.file ?? (d.scripts.some((x) => x.path === id) ? id : undefined); return f !== undefined && f !== w.paths[0]; }))
        out.hint = "Other files have problems after this change. If they depend on what you changed, make the remaining edits with write_scripts (edits per file, one version) rather than one file at a time.";
      if (w.verbose) out.regeneration = raw.map((r: any) => summarize(r, true));
      const names = nameHints(infos, asms, new Set(w.paths));
      if (names.length) out.names = names;
    } catch (e) {
      failed = true;
      out.regenerationFailed = `${(e as Error).message}. The write is committed${version ? ` (version ${version.number})` : ""}: don't redo it; check later with list_problems.`;
    }
    try {
      const others = await othersOn(db, s, documentID, w.paths);
      if (Object.keys(others).length) out.otherSessions = others;
      const changed = await changedUnderYou(db, s, documentID, w.paths);
      if (changed.length) out.changedByOthers = changed;
      await activity(documentID, `${label}${version ? ` (v${version.number})` : ""}${failed ? " — regeneration failed" : ""}`);
      await setStatus((await db.sql`SELECT 1 FROM notes WHERE claimed_by = ${s.id} AND removed_at IS NULL`).length ? "working" : "idle", documentID);
    } catch {}
    return out;
  }

  // the write tools share these; write_script's description says what they mean
  const writeId = z.string().min(8).max(200).optional();
  const verbose = z.boolean().optional();
  // one object shape (search or lines) keeps the schema small; checkEdits enforces the choice
  const edits = z.array(z.object({ search: z.string().optional(), lines: z.array(z.number().int()).length(2).optional(), replace: z.string(), all: z.boolean().optional() })).min(1);
  const checkEdits = (es: { search?: string | undefined; lines?: number[] | undefined }[], path: string) => {
    const bad = es.findIndex((e) => (e.search === undefined) === (e.lines === undefined));
    if (bad >= 0) throw new ToolError(`Edit ${bad + 1} on ${path}: give either search or lines.`);
  };

  /** Files whose edits target an older version than the current one: if the write lands, they were rebased. */
  async function rebasing(documentID: string, files: { path: string; edits?: unknown[] | undefined; baseVersion: number | null }[]) {
    const stale = files.filter((f) => f.edits && f.baseVersion !== null);
    if (!stale.length) return {};
    const rows = await db.sql`SELECT path, version FROM scripts WHERE document_id = ${documentID} AND path = ANY(${stale.map((f) => f.path)})`;
    const out: Record<string, string> = {};
    for (const f of stale) {
      const r = rows.find((x: any) => x.path === f.path);
      if (r && Number(r.version) !== f.baseVersion) out[f.path] = `edits applied on top of version ${Number(r.version)} (yours was ${f.baseVersion}); changedByOthers or read_script shows what else changed`;
    }
    return out;
  }
  /** afterWrite plus the files that were rebased, when the write made a version. */
  const withRebased = (out: Record<string, unknown>, rebased: Record<string, string>) => (out.version && Object.keys(rebased).length ? { ...out, rebased } : out);

  tool(
    "write_script",
    "Create or replace a script (studios/*.ts or lib/**/*.ts). baseVersion: its version from list_scripts / read_script (the document version that last changed it), null to create. Makes a version and regenerates the parts it reaches (its studio, or studios importing it). Returns the version, each script's new version (its next baseVersion), parts counted (regenerated, ok), problem lines per part or file (imports of missing files too), names that pack in details (names: move them to description/partNumber) and files others changed under you; verbose: every part, full results. note: the note id this answers. Safe to retry; writeId: an idempotency key to reuse when retrying.",
    { document, path: z.string(), content: z.string(), baseVersion: z.number().int().nullable(), message: z.string().optional(), note: z.string().optional(), writeId, verbose },
    async ({ document: dd, path, content, baseVersion, message, note, writeId, verbose }) => {
      const documentID = docID(dd);
      await requireMember(db, s.userID, documentID, "editor");
      await setStatus("writing", documentID, { path });
      const versionID = writeId ?? newID();
      await mutate(mutators.script.write({ documentID, path, content, baseVersion, message, noteID: note, versionID } as any));
      return text(await afterWrite(documentID, `write ${path}`, { versionID, paths: [path], verbose }));
    },
  );

  tool(
    "edit_script",
    "Edits to a script, each { search, replace, all? } (search matches exactly once unless all) or { lines: [first, last], replace } (numbered as read_script showed them at baseVersion; \"\" deletes, [k, k - 1] inserts before line k). Search edits on a stale baseVersion still apply if they match (rebased); line edits need it current. Otherwise like write_script. Dependent changes across files: write_scripts with edits.",
    { document, path: z.string(), edits, baseVersion: z.number().int(), message: z.string().optional(), note: z.string().optional(), writeId, verbose },
    async ({ document: dd, path, edits, baseVersion, message, note, writeId, verbose }) => {
      const documentID = docID(dd);
      await requireMember(db, s.userID, documentID, "editor");
      await setStatus("writing", documentID, { path });
      const versionID = writeId ?? newID();
      checkEdits(edits, path);
      const rebased = await rebasing(documentID, [{ path, edits, baseVersion }]);
      await mutate(mutators.script.edit({ documentID, path, edits, baseVersion, message, noteID: note, versionID } as any));
      return text(withRebased(await afterWrite(documentID, `edit ${path}`, { versionID, paths: [path], verbose }), rebased));
    },
  );

  tool(
    "write_scripts",
    "Change, create or delete several scripts in one version (or none), one regeneration: e.g. rename an export and its users. Each file gives edits (search/replace like edit_script), content or delete: true, and its baseVersion (null to create); any stale baseVersion or failed edit rejects the whole write. Otherwise like write_script.",
    {
      document,
      files: z
        .array(
          z.object({
            path: z.string(),
            content: z.string().optional(),
            edits: edits.optional(),
            delete: z.boolean().optional(),
            baseVersion: z.number().int().nullable(),
          }),
        )
        .min(1)
        .max(50),
      message: z.string().optional(),
      note: z.string().optional(),
      writeId,
      verbose,
    },
    async ({ document: dd, files, message, note, writeId, verbose }) => {
      const documentID = docID(dd);
      await requireMember(db, s.userID, documentID, "editor");
      await setStatus("writing", documentID, { path: files[0]!.path });
      const versionID = writeId ?? newID();
      for (const f of files) if (f.edits) checkEdits(f.edits, f.path);
      const rebased = await rebasing(documentID, files);
      await mutate(mutators.script.writeMany({ documentID, files, message, noteID: note, versionID } as any));
      return text(withRebased(await afterWrite(documentID, `write ${files.map((f) => f.path).join(", ")}`, { versionID, paths: files.map((f) => f.path), verbose }), rebased));
    },
  );

  // ---------------- geometry ----------------
  const VIEWS = ["iso", "top", "bottom", "front", "back", "left", "right", "section"] as const;
  tool(
    "render",
    'PNG (default 800×600). view: iso (default), top, bottom, front, back, left, right, section, or "note:<id>" (its camera and targets); views: 2–4 named views tiled in one image; or a camera. top looks down −Z, front along +Y; up: "y" for Y-up. parts: part, instance or assembly ids (default: all), posed and previewed as in your session. hide: ids to omit (part id: all its instances). frame: ids to fit in view (others still drawn). camera.width: mm across the image. highlight: names/selectors in orange. section: cut this image only, removing dot(p − origin, normal) > 0; view "section" (default with it) faces the cut.',
    {
      document,
      view: z.string().optional(),
      views: z.array(z.string()).min(2).max(4).optional(),
      up: z.enum(["z", "y"]).optional(),
      camera: z.object({ position: z.array(z.number()).length(3), target: z.array(z.number()).length(3), up: z.array(z.number()).length(3).optional(), ortho: z.boolean().optional(), width: z.number().optional() }).optional(),
      section: z.object({
        origin: z.array(z.number().finite()).length(3),
        normal: z.array(z.number().finite()).length(3).refine((n) => {
          const lengthSquared = n.reduce((sum, x) => sum + x * x, 0);
          return lengthSquared > 0 && Number.isFinite(lengthSquared);
        }, "Section normal must have a finite, nonzero length."),
      }).optional(),
      highlight: z.array(z.object({ part: z.string(), name: z.string() })).optional(),
      parts: z.array(z.string()).optional(),
      hide: z.array(z.string()).optional(),
      frame: z.array(z.string()).optional(),
      style: z.enum(["shaded", "shadedEdges", "wireframe", "hiddenLine"]).optional(),
      width: z.number().int().min(128).max(2048).optional(),
      height: z.number().int().min(128).max(2048).optional(),
    },
    async ({ document: dd, view, views, up, camera, section, highlight, parts, hide, frame, style, width, height }) => {
      const documentID = docID(dd);
      if (views && (view || camera)) throw new ToolError("views replaces view and camera: give one of them.");
      const unknownView = views?.find((x) => !VIEWS.includes(x as any));
      if (unknownView) throw new ToolError(`Unknown view "${unknownView}" in views. Use ${VIEWS.join(", ")}.`);
      if (views?.includes("section") && !section) throw new ToolError('view "section" needs section.');
      const d = await loadDoc(db, s.userID, documentID);
      const asm = await assemblyState(d, [...(parts ?? []), ...(frame ?? [])]);
      const all = await partsOf(d);
      let ids = all;
      if (parts) {
        const t = expandTargets(parts, all, asm.infos);
        if (t.unknown.length) throw unknownTargets("part, instance or assembly", t.unknown, all, asm.infos);
        ids = t.ids;
      }
      if (hide?.length) {
        const t = expandTargets(hide, all, asm.infos);
        if (t.unknown.length) throw unknownTargets("part, instance or assembly to hide", t.unknown, all, asm.infos);
        const gone = new Set(t.ids);
        ids = ids.filter((id) => !gone.has(id) && !gone.has(sourcePart(id)));
        if (!ids.length) throw new ToolError("hide leaves nothing to render.");
      }
      let framed: string[] | undefined;
      if (frame?.length) {
        const t = expandTargets(frame, all, asm.infos);
        if (t.unknown.length) throw unknownTargets("part, instance or assembly to frame", t.unknown, all, asm.infos);
        // a part id frames its instances too (render({ parts: ["pack"], frame: ["battery"] }))
        framed = ids.filter((id) => t.ids.includes(id) || t.ids.includes(sourcePart(id)));
        if (!framed.length) throw new ToolError(`Nothing to frame: ${frame.join(", ")} isn't among the parts rendered${parts ? "" : " (instances show only when parts names their assembly: parts: [\"<assembly>\"])"}${hide ? " or is hidden" : ""}.`);
      }
      await regen(d, ids);
      if (camera?.width !== undefined && !(camera.width > 0)) throw new ToolError("camera.width must be a positive number of mm.");
      let cam = camera as any;
      if (view === "section" && !section) throw new ToolError('view "section" needs section.');
      let v: string | undefined = view ?? (section && !camera ? "section" : "iso");
      if (view?.startsWith("note:")) {
        const [n] = await db.sql`SELECT anchor FROM notes WHERE id = ${view.slice(5)} AND document_id = ${documentID}`;
        if (!n) throw new ToolError(`No note ${view.slice(5)}.`);
        cam = n.anchor.camera;
        v = undefined;
        highlight ??= n.anchor.targets.filter((t: NoteTarget) => t.kind === "face" || t.kind === "edge" || t.kind === "vertex").map((t: NoteTarget) => ({ part: t.part, name: t.name }));
      } else if (v && !VIEWS.includes(v as any)) throw new ToolError(`Unknown view "${v}". Use ${VIEWS.join(", ")} or note:<id>.`);
      const refs: any[] = [];
      const missed: string[] = [];
      for (const h of highlight ?? []) {
        try {
          const r = await resolveName(d, h.part, h.name);
          for (const index of r.indices) refs.push({ part: h.part, kind: r.kind, index });
        } catch {
          // said, with close names: otherwise a typo is just an image without orange
          const [names] = all.includes(h.part) ? ((await engine(d, [{ op: "names", part: h.part }]).catch(() => [])) as { face: string[]; edge: string[] }[]) : [];
          missed.push(names ? unknownMessage(`name on ${h.part}`, [h.name], [...names.face, ...names.edge], "describe_model { part } lists its faces and edges.") : unknownMessage("part to highlight", [h.part], all, "highlight takes part ids (describe_model)."));
        }
      }
      const poses = Object.fromEntries(ids.filter((p) => asm.poses[p]).map((p) => [p, asm.poses[p]]));
      const [img] = await engine(d, [{ op: "render", view: v, up: up ?? "z", camera: cam && { ...cam, up: cam.up ?? (up === "y" ? [0, 1, 0] : [0, 0, 1]) }, section, highlight: refs, parts: ids, frame: framed, poses, style, views, width: width ?? RENDER_SIZE[0], height: height ?? RENDER_SIZE[1] }]);
      await activity(documentID, `render ${views?.join("+") ?? view ?? v ?? "iso"}${refs.length ? ` (${refs.length} highlighted)` : ""}`);
      return { content: [{ type: "image", data: (img as any).png, mimeType: "image/png" }, ...(missed.length ? [{ type: "text" as const, text: `Not highlighted: ${missed.join(" ")}` }] : [])] };
    },
    { readOnlyHint: true },
  );

  tool(
    "describe_model",
    "Parts with bounding box, mass properties and material. entities (default when part is given): every face and edge with name, type, area/length, normal/axis, center and `by` (the operation and source line that made it); neighbors: true adds faces' adjacent faces. part: part, instance, assembly or subassembly copy id (world coordinates at the session pose). Params once per source part (`params`), shared in `sharedParams`; params: false omits them. Without part, also lists studios (file, name, description) and assemblies with joint values. assemblies: true: only assemblies (instance count, joints, problems).",
    { document, part: z.string().optional(), entities: z.boolean().optional(), neighbors: z.boolean().optional(), params: z.boolean().optional(), assemblies: z.boolean().optional() },
    async ({ document: dd, part, entities, neighbors, params: withParams, assemblies: onlyAssemblies }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const asm = await assemblyState(d, part ? [part] : undefined);
      const head = { document: d.name, units: d.units, configuration: d.configurations.find((c) => c.id === configOf(d))?.name ?? "Default" };
      if (onlyAssemblies) {
        if (part && !asm.assemblies.length) throw new ToolError(`No assembly "${part}". Assemblies: ${asm.infos.map((a) => a.id).join(", ") || "none"}`);
        // "revolute 90 deg (0..110) session"
        const joint = (j: (typeof asm.assemblies)[number]["joints"][number]) => `${j.type} ${j.value.map((v, i) => `${v} ${j.units[i]}`).join(", ")}${j.limits.some(Boolean) ? ` (${j.limits.map((l) => (l ? `${l.min ?? "-inf"}..${l.max ?? "inf"}` : "free")).join(", ")})` : ""} ${j.from}`;
        await activity(documentID, `describe_model assemblies${part ? ` ${part}` : ""}`);
        const poses = s.preview?.get(documentID)?.poses;
        return text({ ...head, sessionPoses: poses && Object.keys(poses).length ? poses : undefined, assemblies: asm.assemblies.map((a) => lean({ id: a.id, name: a.name !== a.id ? a.name : undefined, instances: a.instances.length, subassemblies: a.subassemblies.length || undefined, joints: a.joints.length ? Object.fromEntries(a.joints.map((j) => [j.name, joint(j)])) : undefined, problems: a.problems })) });
      }
      const infos = await partInfosOf(d);
      let parts = infos.map((p) => p.id);
      if (part) {
        const t = expandTargets([part], parts, asm.infos);
        if (t.unknown.length) throw unknownTargets("part, instance or assembly", t.unknown, parts, asm.infos);
        parts = t.ids;
      }
      const results = await regenerateParts(d, parts);
      const entityParts = (entities ?? !!part) ? results.filter((r: any) => !r.empty).map((r: any) => r.part) : [];
      const descriptions = await engine(d, entityParts.map((part) => ({ op: "describeAll", part })));
      const entitiesOf = new Map(entityParts.map((part: string, i: number) => [part, descriptions[i]]));
      const out: any[] = [];
      // name: value with unit, once per source part (shared ones once); get_params has defaults, bounds and sources
      const preview = s.preview?.get(documentID)?.params;
      const params: Record<string, Record<string, string>> = {};
      const sharedParams: Record<string, string> = {};
      const fmt = (r: any, p: any) => `${typeof p.value === "number" ? round(p.value, 4) : p.value}${p.unit && typeof p.value === "number" ? ` ${p.unit}` : ""}${p.overridden ? " (override)" : ""}${preview?.[sourcePart(r.part)]?.[p.name] !== undefined || preview?.["*"]?.[p.name] !== undefined ? " (preview)" : ""}`;
      if (withParams ?? true) for (const r of results as any[]) for (const p of r.params) if (p.shared) sharedParams[p.name] ??= fmt(r, p); else (params[sourcePart(r.part)] ??= {})[p.name] ??= fmt(r, p);
      for (const r of results as any[]) {
        // instances: part coordinates -> where this session poses them
        const pose = asm.poses[r.part];
        const place = (e: any) => (pose ? { ...e, center: vec(posedPoint(e.center, pose)), normal: vec(posedDir(e.normal, pose)), axis: vec(posedDir(e.axis, pose)), direction: vec(posedDir(e.direction, pose)), point: vec(posedPoint(e.point, pose)) } : e);
        const summary = summarize(r)!;
        const color = r.color?.kind === "rgb" ? r.color.hex : r.color?.kind;
        const entry: any = lean({
          ...summary,
          volume: undefined, // in mass
          bbox: pose && r.bbox ? (({ min, max }) => ({ min: vec(min), max: vec(max) }))(posedBox(r.bbox, pose)) : summary.bbox,
          posed: pose ? true : undefined,
          color,
          appearance: part ? r.appearance : undefined,
          material: r.material?.name ? `${r.material.name}${r.material.density ? ` (${r.material.density} g/cm³)` : ""}` : r.material,
          mass: r.mass && lean({ volume: round(r.mass.volume, 2), area: round(r.mass.area, 2), grams: r.material?.density ? round(r.mass.mass, 2) : undefined, centroid: vec(posedPoint(r.mass.centroid, pose)) }),
        });
        if ((entities ?? !!part) && !r.empty) {
          const all = entitiesOf.get(r.part);
          const opts = { neighbors: neighbors ? 1000 : 0 };
          entry.faces = (all as any).faces.map((e: any) => describeEntity(place(e), opts));
          entry.edges = (all as any).edges.map((e: any) => describeEntity(place(e), opts));
        }
        out.push(entry);
      }
      await activity(documentID, `describe_model${part ? ` ${part}` : ""}`);
      const session = s.preview?.get(documentID);
      return text({
        ...head,
        sessionPreview: session && (Object.keys(session.params).length || Object.keys(session.poses).length) ? session : undefined,
        studios: part ? undefined : studiosOf(infos, asm.infos),
        sharedParams: Object.keys(sharedParams).length ? sharedParams : undefined,
        params: Object.keys(params).length ? params : undefined,
        parts: out,
        assemblies: !part && asm.assemblies.length ? asm.assemblies.map(({ poses: _, ...a }) => a) : undefined,
      });
    },
    { readOnlyHint: true },
  );

  tool(
    "query",
    'Evaluate a selector on a part (default the first) and describe the matches like describe_model, e.g. ">Z", "base.side & |Z", "%circle", "@finUnion". kind: face (default), edge or vertex. limit: default 50.',
    { document, expr: z.string(), part: z.string().optional(), kind: z.enum(["face", "edge", "vertex"]).optional(), limit: z.number().int().min(1).max(500).optional(), neighbors: z.boolean().optional() },
    async ({ document: dd, expr, part, kind, limit, neighbors }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const p = part ?? (await partsOf(d))[0];
      if (!p) throw new ToolError("This document has no parts.");
      await regen(d, [p]);
      const k = kind ?? "face";
      const max = limit ?? 50;
      const [idx] = await engine(d, [{ op: "query", part: p, expr, kind: k }]);
      const descs = await engine(d, (idx as number[]).slice(0, max).map((index) => ({ op: "describe", part: p, kind: k, index })));
      return text(lean({ part: p, kind: k, count: (idx as number[]).length, entities: descs.map((e: any) => describeEntity(e, { neighbors: neighbors ? 1000 : 0 })), truncated: (idx as number[]).length > max ? `first ${max}; pass limit for more` : undefined }));
    },
    { readOnlyHint: true },
  );

  const ref = z.object({ part: z.string(), name: z.string().optional() });
  tool("measure", "Minimum distance between two entities (name: stable name or selector) or whole parts (no name), with the closest points; the angle between faces/edges; the interference volume between parts. Instances (mechanism/box:lid) are where this session poses them.",{ document, a: ref, b: ref }, async ({ document: dd, a, b }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    // the engine is shared with other sessions: always set this session's poses (none unless an instance is involved)
    const poses = a.part.includes("/") || b.part.includes("/") ? (await assemblyState(d, [a.part, b.part])).poses : {};
    await regen(d, [...new Set([a.part, b.part])]);
    const toRef = async (x: { part: string; name?: string }) => {
      if (!x.name) return { part: x.part, kind: "part" as const };
      const r = await resolveName(d, x.part, x.name);
      return { part: x.part, kind: r.kind, index: r.indices[0] };
    };
    const A = await toRef(a),
      B = await toRef(b);
    const [, m] = await engine(d, [{ op: "setPoses", poses }, { op: "measure", a: A, b: B }]);
    const out: any = { distance: round((m as any).distance, 4), pointA: vec((m as any).a), pointB: vec((m as any).b) };
    if (A.kind !== "part" && B.kind !== "part") {
      const [da, db2] = await engine(d, [
        { op: "describe", ...A },
        { op: "describe", ...B },
      ]);
      const na = posedDir((da as any).normal ?? (da as any).axis, poses[A.part]),
        nb = posedDir((db2 as any).normal ?? (db2 as any).axis, poses[B.part]);
      if (na && nb) {
        const dot = Math.abs(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]);
        out.angleDeg = round((Math.acos(Math.min(1, dot)) * 180) / Math.PI, 3);
      }
    }
    if (A.kind === "part" && B.kind === "part" && A.part !== B.part) {
      const [, [o]] = (await engine(d, [{ op: "setPoses", poses }, { op: "overlapPairs", pairs: [[A.part, B.part]] }])) as [unknown, (Overlap | null)[]];
      out.interferenceVolume = round(o?.volume ?? 0, 3);
      // overlapping: the closest points are just some point where they touch
      if (o) (out.overlap = { bbox: { min: o.bbox.min.map((x) => round(x, 2)), max: o.bbox.max.map((x) => round(x, 2)) }, centroid: o.centroid.map((x) => round(x, 2)) }), (out.note = "the parts overlap: pointA/pointB are a contact point, not the overlap; overlap is the shared region");
    }
    await activity(documentID, `measure ${a.part}${a.name ? ` · ${a.name}` : ""} ↔ ${b.part}${b.name ? ` · ${b.name}` : ""}: ${out.distance}`);
    return text(out);
  }, { readOnlyHint: true });

  // ---------------- params & configurations ----------------
  tool("get_params", "Params per part: code default, override, effective value, unit, bounds, source line; preview marks your session's set_param previews. configuration: switch this session's active configuration first (each session has its own; list_configurations lists them).", { document, configuration: z.string().optional() }, async ({ document: dd, configuration }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    if (configuration) s.activeConfig.set(documentID, findConfig(d, configuration));
    const results = await engine(d, (await partsOf(d)).map((part) => ({ op: "regenerate", part })));
    return text({
      configuration: d.configurations.find((c) => c.id === configOf(d))?.name ?? "Default",
      // parts without params are left out
      parts: (results as any[]).filter((r) => r.params.length).map((r) => ({ part: r.part, params: r.params.map((p: any) => ({ name: p.name, codeDefault: p.default, override: p.overridden ? p.expression : undefined, preview: s.preview?.get(documentID)?.params[r.part]?.[p.name] !== undefined || s.preview?.get(documentID)?.params["*"]?.[p.name] !== undefined || undefined, effective: p.value, unit: p.unit, min: p.min, max: p.max, step: p.step, options: p.options, source: p.source && `${p.source.file}:${p.source.line}`, error: p.error })) })),
    });
  }, { readOnlyHint: true });

  function findConfig(d: DocState, nameOrID: string): string | null {
    if (nameOrID.toLowerCase() === "default") return null;
    const c = d.configurations.find((x) => x.id === nameOrID || x.name.toLowerCase() === nameOrID.toLowerCase());
    if (!c) throw new ToolError(`No configuration "${nameOrID}". Configurations: Default, ${d.configurations.map((x) => x.name).join(", ")}`);
    return c.id;
  }

  async function ensureConfig(d: DocState): Promise<string> {
    const c = configOf(d);
    if (c) return c;
    // Default is exactly the code; overrides live in a named configuration for this agent
    const name = s.label ? `${s.clientName} (${s.label})` : s.clientName;
    const existing = d.configurations.find((x) => x.name === name);
    const id = existing?.id ?? newID();
    if (!existing) await mutate(mutators.configuration.create({ id, documentID: d.id, name, overrides: [] }));
    s.activeConfig.set(d.id, id);
    return id;
  }

  /** Set (undefined: drop) this session's preview of part.name. */
  function putPreview(documentID: string, part: string, name: string, v: string | number | undefined) {
    const prev = previewOf(documentID);
    if (v !== undefined) return void ((prev.params[part] ??= {})[name] = v);
    if (prev.params[part]) (delete prev.params[part][name], !Object.keys(prev.params[part]).length && delete prev.params[part]);
  }
  /** Run `f` with this session's preview of part.name at `v`, then put it back. */
  async function withPreview<T>(documentID: string, part: string, name: string, v: string | number | undefined, f: () => Promise<T>) {
    const cur = s.preview?.get(documentID)?.params[part]?.[name];
    putPreview(documentID, part, name, v);
    try {
      return await f();
    } finally {
      putPreview(documentID, part, name, cur);
    }
  }
  /** This session's param previews, or just how many when the map is large. */
  function previewEcho(documentID: string) {
    const p = s.preview?.get(documentID)?.params ?? {};
    return JSON.stringify(p).length <= 400 ? p : `${Object.values(p).reduce((n, o) => n + Object.keys(o).length, 0)} previewed params (get_params marks them)`;
  }
  /**
   * set_param's result: parts counted (regenerated, ok), problem lines per part, and the parts
   * declaring the param whose bounding box moved (`before` regenerates them as they were); with
   * `verbose`, every part's summary.
   */
  async function paramReport(part: string, name: string, after: any[], before: (parts: string[]) => Promise<any[]>, verbose?: boolean) {
    const bad = after.filter((r) => r?.problems.length);
    const problems = Object.fromEntries(bad.map((r) => [r.part, [...(cap(r.problems.map(problemLine), 6) as string[]), ...(r.partial && !r.empty ? ["(showing last good geometry)"] : [])]]));
    const box = (b?: any) => (b ? { min: vec(b.min), max: vec(b.max) } : null);
    const declaring = after.filter((r) => r && !r.empty && r.params.some((p: any) => p.name === name && (part !== "*" || p.shared))).map((r) => r.part as string);
    const was = new Map(declaring.length ? (await before(declaring)).map((r: any, i) => [declaring[i]!, box(r?.bbox)]) : []);
    const changed: Record<string, unknown> = {};
    for (const r of after) if (r && was.has(r.part) && JSON.stringify(box(r.bbox)) !== JSON.stringify(was.get(r.part))) changed[r.part] = { bbox: box(r.bbox), was: was.get(r.part) };
    return lean({ parts: { regenerated: after.length, ok: after.length - bad.length }, problems: bad.length ? problems : undefined, bboxChanged: Object.keys(changed).length ? changed : undefined, regeneration: verbose ? after.map((r) => summarize(r)) : undefined });
  }
  const paramTargets = async (d: DocState, part: string) => (part === "*" ? await partsOf(d) : [part]);

  tool(
    "set_param",
    'Override a param without editing source. value: a number in its unit or an expression ("=width/2", "1/4 in"); null clears the override (by default your preview if you have one, else the shared one). scope "session" (default): a preview only this session sees, no version. scope "shared": saved as a version in your active configuration (or `configuration`); on Default, one named after you is made and activated. part: part id, instance id (its part) or "*" for a shared param. Returns counts, problems and bboxChanged; verbose: every part.',
    {
      document,
      part: z.string(),
      name: z.string(),
      value: z.union([z.number(), z.string(), z.null()]),
      scope: z.enum(["session", "shared"]).optional(),
      configuration: z.string().optional(),
      verbose,
    },
    async ({ document: dd, part, name, value, scope, configuration, verbose }) => {
      const documentID = docID(dd);
      part = sourcePart(part);
      if (value === null) return resetParam(documentID, part, name, scope, configuration, verbose);
      if ((scope ?? "session") === "session") {
        const d = await loadDoc(db, s.userID, documentID);
        const before = previewOf(documentID).params[part]?.[name];
        putPreview(documentID, part, name, typeof value === "number" ? value : String(value));
        const targets = await paramTargets(d, part);
        let raw: any[];
        try {
          raw = await engine(d, targets.map((p) => ({ op: "regenerate", part: p })));
        } catch (e) {
          raw = [];
          if (!(e instanceof ToolError)) throw e;
        }
        if (!raw.some((r) => r?.params?.some((p: any) => p.name === name))) {
          putPreview(documentID, part, name, before);
          const known = raw.flatMap((r) => r?.params?.map((p: any) => p.name) ?? []);
          throw new ToolError(`No param "${name}" on ${part}.${known.length ? ` Params: ${[...new Set(known)].join(", ")}` : " Check the part id (get_params)."}`);
        }
        const report = await paramReport(part, name, raw, (ps) => withPreview(documentID, part, name, before, () => regenerateParts(d, ps)), verbose);
        return text({ scope: "session", sessionPreview: previewEcho(documentID), ...report });
      }
      await requireMember(db, s.userID, documentID, "editor");
      const old = await loadDoc(db, s.userID, documentID);
      if (configuration) s.activeConfig.set(documentID, findConfig(old, configuration));
      const configurationID = await ensureConfig(old);
      await mutate(mutators.param.set({ documentID, configurationID, part, name, expression: String(value), value: typeof value === "number" ? value : Number.isFinite(+value) ? +value : String(value), versionID: newID() } as any));
      // the shared value now applies: drop this session's preview of it
      const previewed = s.preview?.get(documentID)?.params[part]?.[name];
      putPreview(documentID, part, name, undefined);
      const d = await loadDoc(db, s.userID, documentID);
      const raw = await regenerateParts(d, await paramTargets(d, part));
      const v = await latestVersion(documentID);
      if (v) s.lastVersion.set(documentID, v.id);
      await activity(documentID, `set ${part}.${name} = ${value}`);
      const report = await paramReport(part, name, raw, (ps) => withPreview(documentID, part, name, previewed, () => regenerateParts(old, ps)), verbose);
      return text({ scope: "shared", configuration: d.configurations.find((c) => c.id === configurationID)?.name, ...report });
    },
  );

  /** set_param with value null: drop the session preview, or clear the override in the configuration (a version). */
  async function resetParam(documentID: string, part: string, name: string, scope?: "session" | "shared", configuration?: string, verbose?: boolean) {
    const previewed = s.preview?.get(documentID)?.params[part]?.[name];
    if (scope === "session" || (!scope && previewed !== undefined)) {
      if (previewed === undefined) throw new ToolError(`No session preview for ${part}.${name}.`);
      putPreview(documentID, part, name, undefined);
      const d = await loadDoc(db, s.userID, documentID);
      const raw = await regenerateParts(d, await paramTargets(d, part));
      const report = await paramReport(part, name, raw, (ps) => withPreview(documentID, part, name, previewed, () => regenerateParts(d, ps)), verbose);
      return text({ scope: "session", sessionPreview: previewEcho(documentID), ...report });
    }
    await requireMember(db, s.userID, documentID, "editor");
    const old = await loadDoc(db, s.userID, documentID);
    if (configuration) s.activeConfig.set(documentID, findConfig(old, configuration));
    const configurationID = configOf(old);
    if (!configurationID) throw new ToolError("You're on Default, which has no overrides.");
    await mutate(mutators.param.reset({ documentID, configurationID, part, name, versionID: newID() } as any));
    const d = await loadDoc(db, s.userID, documentID);
    const raw = await regenerateParts(d, await paramTargets(d, part));
    return text({ scope: "shared", ...(await paramReport(part, name, raw, (ps) => regenerateParts(old, ps), verbose)) });
  }

  // switching is session state only (no write): get_params / set_param take `configuration`, and so does this.
  // rename and delete change the document for everyone (a params version), like the app's configuration menu
  tool("list_configurations", "Configurations (named override sets) with their overrides, and this session's active one. activate: switch it (each session has its own). rename: rename the active one; delete: remove one (name or id); both for everyone, not Default. A shared set_param on Default makes one named after the agent.", { document, activate: z.string().optional(), rename: z.string().optional(), delete: z.string().optional() }, async ({ document: dd, activate, rename, delete: del }) => {
    const documentID = docID(dd);
    let d = await loadDoc(db, s.userID, documentID);
    if (activate) s.activeConfig.set(documentID, findConfig(d, activate));
    if (rename || del) {
      await requireMember(db, s.userID, documentID, "editor");
      const named = (id: string | null) => {
        if (!id) throw new ToolError("Default is the code itself: it can't be renamed or deleted.");
        return id;
      };
      if (rename) await mutate(mutators.configuration.rename({ id: named(configOf(d)), name: rename, versionID: newID() } as any));
      if (del) {
        const id = named(findConfig(d, del));
        await mutate(mutators.configuration.delete({ id, versionID: newID() } as any));
        if (s.activeConfig.get(documentID) === id) s.activeConfig.delete(documentID);
      }
      const v = await latestVersion(documentID);
      if (v) s.lastVersion.set(documentID, v.id);
      await activity(documentID, [rename && `rename configuration to ${rename}`, del && `delete configuration ${del}`].filter(Boolean).join("; "));
      d = await loadDoc(db, s.userID, documentID);
    }
    return text({ active: d.configurations.find((c) => c.id === configOf(d))?.name ?? "Default", configurations: [{ name: "Default" }, ...d.configurations.map((c) => lean({ id: c.id, name: c.name, overrides: c.overrides.map((o) => `${o.part}.${o.name} = ${o.expression}`) }))] });
  });

  // ---------------- assembly poses ----------------
  tool(
    "set_pose",
    'Pose an assembly or subassembly copy: joint values in degrees or mm, 0 where modeled, clamped to limits, e.g. { lid: 90 } or { base: [10, 0, 45] } for multi-variable joints; joints you don\'t name keep their value or settle. Joint names: the script\'s { name }, else "<partA>+<partB>"; joints of an inserted assembly are prefixed "<its assembly id>@<insert name>/", e.g. "winch_assembly:drive@upright/Drum rotation" (describe_model lists them). With a subassembly copy id as assembly, use relative joint names; reset affects only that copy. scope "session" (default): a preview only this session sees, nothing saved. scope "shared": save the positions to the document for everyone (no version); without joints it saves your session preview. reset: true first drops your session values (shared: the saved positions). Returns each joint\'s value and source (session, shared or home).',
    {
      document,
      assembly: z.string(),
      joints: z.record(z.string(), z.union([z.number(), z.array(z.number())])).optional(),
      scope: z.enum(["session", "shared"]).optional(),
      reset: z.boolean().optional(),
    },
    async ({ document: dd, assembly, joints, scope, reset }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      if (scope === "shared") await requireMember(db, s.userID, documentID, "editor");
      let state = await assemblyState(d, [assembly]);
      const target = poseTarget(state.infos, assembly);
      if (!target) throw new ToolError(`No assembly or subassembly "${assembly}". Assemblies: ${state.infos.map((a) => `${a.id} (${a.name})`).join(", ") || "none"}`);
      const info = target.assembly;
      const sub = target.id !== info.id;
      const jointNames = new Set(target.joints.map((j) => j.name));
      const outside = (values: Record<string, number[]>) => Object.fromEntries(Object.entries(values).filter(([name]) => !jointNames.has(name)));
      let values: Record<string, number[]>;
      try {
        values = scopedJointValues(target, joints ?? {});
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      const prev = previewOf(documentID);
      const prior = prev.poses[info.id] ?? {};
      const mine = reset ? (sub ? outside(prior) : {}) : prior;
      if (scope === "shared") {
        if (reset) {
          const [row] = await db.sql`SELECT settings FROM documents WHERE id = ${documentID}`;
          const saved = (row?.settings as any)?.poses?.[info.id] ?? {};
          await mutate(mutators.document.setPose({ id: documentID, assembly: info.id, joints: sub ? outside(saved) : null }));
        }
        // solve from the shared positions (plus any preview kept) with the new values on top, then save the whole pose
        const commit = sub ? Object.fromEntries(Object.entries(mine).filter(([name]) => jointNames.has(name))) : mine;
        prev.poses[info.id] = { ...commit, ...values };
        state = await assemblyState(await loadDoc(db, s.userID, documentID), [info.id]);
        const solved = state.assemblies.find((a) => a.id === info.id)!;
        if (Object.keys(values).length || !reset) await mutate(mutators.document.setPose({ id: documentID, assembly: info.id, joints: Object.fromEntries(solved.joints.map((j) => [j.name, j.value])) }));
        delete prev.poses[info.id];
        if (sub && Object.keys(outside(mine)).length) prev.poses[info.id] = outside(mine);
      } else {
        prev.poses[info.id] = { ...mine, ...values };
        if (!Object.keys(prev.poses[info.id]).length) delete prev.poses[info.id];
      }
      state = await assemblyState(await loadDoc(db, s.userID, documentID), [info.id]);
      // instances are in describe_model; the joints are what changed
      const { poses: _, instances: __, ...out } = state.assemblies.find((a) => a.id === info.id)! as any;
      if (scope === "shared") await activity(documentID, `set pose ${info.name}`);
      return text(lean({ scope: scope ?? "session", ...out, ...(sub && { id: target.id, name: target.name, assembly: info.id, joints: out.joints.filter((j: any) => jointNames.has(j.name)) }) }));
    },
  );

  // ---------------- problems & checks ----------------
  tool("engine_status", "Whether the geometry engine is reachable (documents loaded, build). Check when a tool says it's unavailable.", {}, async () => text(await pool.health()), { readOnlyHint: true });

  tool(
    "list_problems",
    "Each part's status (\"ok\" or its error and warning lines), assemblies' problems, and per problem file the version that last changed it (likely the one that introduced the problem). Check at the start of a session. On a cold engine it answers after about 10 s with the parts done so far; call again for the rest.",
    { document },
    async ({ document: dd }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const started = Date.now();
      const all = await partsOf(d);
      const { results: partial, done } = await regenerateWithin(d, all, Math.max(0, listProblemsBudgetMs() - (Date.now() - started)));
      const results = partial.filter(Boolean);
      if (!done) {
        // assemblies wait behind the remaining parts; report what's done instead of blocking on them
        const pending = all.filter((_, i) => !partial[i]);
        return text(lean({ parts: partStatus(results), stillRegenerating: cap(pending, 20), note: `The geometry engine was cold: ${pending.length} of ${all.length} parts are still regenerating, and assemblies weren't checked yet. Call list_problems again shortly.` }));
      }
      const [asms] = (await engine(d, [{ op: "assemblies" }])) as [AssemblyInfo[]];
      const versions = await db.sql`SELECT v.id, v.number, v.kind, v.message, v.snapshot, v.created_at, u.name AS user_name, a.client_name FROM versions v LEFT JOIN users u ON u.id = v.author_user_id LEFT JOIN agent_sessions a ON a.id = v.author_agent_id WHERE v.document_id = ${documentID} ORDER BY v.number DESC LIMIT 200`;
      const introduced = (file: string | undefined, kind: string) => {
        // the most recent version that changed this script (or params, for param problems)
        for (let i = 0; i < versions.length; i++) {
          const v = versions[i],
            prev = versions[i + 1];
          const changed = kind === "param" ? v.kind === "params" : !file || !prev || v.snapshot.scripts[file] !== prev.snapshot.scripts[file];
          if (changed) return `v${v.number} by ${v.client_name ?? v.user_name ?? "someone"} at ${when(v.created_at)}: ${v.message} (id ${v.id})`;
        }
        return undefined;
      };
      // one entry per file (or "params") with problems, not per problem
      const introducedBy: Record<string, string> = {};
      for (const r of [...results, ...asms] as any[]) for (const p of r.problems) {
        const key = p.kind === "param" ? "params" : (p.source?.file ?? "unknown");
        if (!(key in introducedBy)) introducedBy[key] = introduced(p.source?.file, p.kind) ?? "unknown";
      }
      const assemblies = Object.fromEntries(asms.filter((a) => a.problems.length).map((a) => [a.id, a.problems.map(problemLine)]));
      return text(lean({ parts: partStatus(results), assemblies: Object.keys(assemblies).length ? assemblies : undefined, introducedBy: Object.keys(introducedBy).length ? introducedBy : undefined }));
    },
    { readOnlyHint: true },
  );

  /** check's pair work: pairs per engine request, the engine's time per request, and the whole check's (env CHECK_BUDGET_MS). */
  const PAIR_CHUNK = 500,
    PAIR_BUDGET_MS = 15_000;
  const checkBudgetMs = () => Number(process.env.CHECK_BUDGET_MS ?? 90_000);

  /**
   * An engine pair op (overlapPairs, distancePairs) over many pairs at `poses`, PAIR_CHUNK pairs a
   * request. The engine cuts each request short at PAIR_BUDGET_MS (it answers the first pairs; the
   * rest go again), so none nears the pool's per-request limit. Pairs of a request that failed
   * (crashed or timed out), and those still left at `deadline`, are skipped: undefined, and counted.
   */
  async function pairwise(d: DocState, poses: Record<string, PartPose>, op: { op: string; [k: string]: unknown }, pairs: [string, string][], deadline: number) {
    const values: unknown[] = new Array(pairs.length);
    const skipped = { pairs: 0, reasons: new Set<string>() };
    const run = (ops: { op: string; [k: string]: unknown }[]) => pool.run({ document: `${d.id}:${configOf(d) ?? "default"}`, scripts: scriptMap(d), overrides: mergeOverrides(overridesFor(d, configOf(d)), s.preview?.get(d.id)), units: d.units, ops });
    let restore = false;
    for (let i = 0; i < pairs.length; ) {
      if (Date.now() > deadline) {
        skipped.pairs += pairs.length - i;
        skipped.reasons.add(`out of time (${Math.round(checkBudgetMs() / 1000)} s)`);
        break;
      }
      const chunk = pairs.slice(i, i + PAIR_CHUNK);
      // a failed request restarts the engine without its parts: regenerate them first
      if (restore) await regenerateParts(d, [...new Set(pairs.slice(i).flat().map(sourcePart))]);
      const [set, r] = (await run([{ op: "setPoses", poses }, { ...op, pairs: chunk, budgetMs: PAIR_BUDGET_MS }])) as any[];
      if (set?.ok && r?.ok && Array.isArray(r.value) && r.value.length) {
        (r.value as unknown[]).forEach((v, k) => (values[i + k] = v));
        i += r.value.length;
        restore = false;
        continue;
      }
      skipped.pairs += chunk.length;
      skipped.reasons.add(String((set?.ok ? r?.error : set?.error) ?? "no answer"));
      restore = true;
      i += chunk.length;
    }
    return { values, skipped };
  }

  tool(
    "check",
    "Validity and interference at the session pose (assemblies as posed; unassembled parts in their studio). part: what to check; near: only pairs touching it. Intended overlaps count as expected. clearance (mm): also close pairs (near).",
    { document, part: z.string().optional(), near: z.string().optional(), clearance: z.number().positive().optional() },
    async ({ document: dd, part, near: nearTo, clearance }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const infos = await partInfosOf(d);
      const all = infos.map((p) => p.id);
      const asm = await assemblyState(d);
      const resolve = (id: string | undefined) => {
        if (id === undefined) return undefined;
        const t = expandTargets([id], all, asm.infos);
        if (t.unknown.length) throw new ToolError(`Unknown part, instance, assembly or subassembly: ${id}`);
        const set = new Set(t.ids);
        // a source part stands for its instances too
        return (x: string) => set.has(x) || set.has(sourcePart(x));
      };
      const inPart = resolve(part),
        inNear = resolve(nearTo);
      const keep = ([x, y]: [string, string]) => (inPart && inNear ? (inPart(x) && inNear(y)) || (inPart(y) && inNear(x)) : inPart ? inPart(x) || inPart(y) : inNear ? inNear(x) || inNear(y) : true);
      const parts = part ? expandTargets([part], all, asm.infos).ids : all;
      // the pairs, picked before computing: studio parts no assembly uses, then each assembly's instances
      const used = new Set(asm.infos.flatMap((a) => a.instances.map((i) => i.part)));
      const free = infos.filter((p) => !used.has(p.id));
      const top: [string, string][] = [];
      for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) if (free[i].file === free[j].file && keep([free[i].id, free[j].id])) top.push([free[i].id, free[j].id]);
      const groups = asm.infos.map((a) => {
        const ids = a.instances.map((i) => i.id);
        const pairs: [string, string][] = [];
        let expected = 0;
        for (let i = 0; i < ids.length; i++)
          for (let j = i + 1; j < ids.length; j++) {
            const p: [string, string] = [ids[i], ids[j]];
            if (!keep(p)) continue;
            if (overlapIntended(a, p[0], p[1])) expected++;
            else pairs.push(p);
          }
        return { a, pairs, expected };
      });
      const pairs = [...top, ...groups.flatMap((g) => g.pairs)];
      // which list each pair reports in: "" top level, else its assembly
      const owner = [...top.map(() => ""), ...groups.flatMap((g) => g.pairs.map(() => g.a.id))];
      await regen(d, [...new Set([...parts, ...pairs.flat()].map(sourcePart))]);
      const checks = await engine(d, parts.map((p) => ({ op: "check", part: p })));
      // valid parts by id; invalid ones with their problems
      const invalid = parts.map((p, i) => ({ part: p, problems: checks[i] as any[] })).filter((x) => x.problems.length);
      // valid parts as a count: a big assembly would list a hundred names on every check
      const out: any = { valid: parts.length - invalid.length, ...(invalid.length ? { invalid } : {}) };
      // instance ids always have a "/", source part ids never: one pose map serves both
      const deadline = Date.now() + checkBudgetMs();
      const hit = await pairwise(d, asm.poses, { op: "overlapPairs" }, pairs, deadline);
      const p2 = (v: number[]) => v.map((x) => round(x, 2));
      const listed = () => new Map<string, any[]>([["", []], ...asm.infos.map((a) => [a.id, []] as [string, any[]])]);
      const hits = listed();
      pairs.forEach(([a, b], i) => {
        const o = hit.values[i] as Overlap | null | undefined;
        if (o) hits.get(owner[i])!.push({ a, b, volume: round(o.volume, 3), bbox: { min: p2(o.bbox.min), max: p2(o.bbox.max) }, centroid: p2(o.centroid) });
      });
      // pairs closer than clearance that don't interfere (and weren't skipped), closest first
      const close = listed();
      const skipped = hit.skipped;
      if (clearance) {
        const apart = pairs.flatMap((p, i) => (hit.values[i] === null ? [i] : []));
        const dist = await pairwise(d, asm.poses, { op: "distancePairs", within: clearance }, apart.map((i) => pairs[i]), deadline);
        skipped.pairs += dist.skipped.pairs;
        for (const r of dist.skipped.reasons) skipped.reasons.add(r);
        apart.forEach((i, k) => {
          const m = dist.values[k] as { distance: number; a: number[]; b: number[] } | null | undefined;
          if (m) close.get(owner[i])!.push({ a: pairs[i][0], b: pairs[i][1], distance: round(m.distance, 4), points: [vec(m.a), vec(m.b)] });
        });
        for (const list of close.values()) list.sort((x, y) => x.distance - y.distance);
      }
      out.interference = hits.get("");
      if (clearance) out.near = close.get("");
      if (asm.infos.length)
        out.assemblies = groups.map(({ a, expected }) => {
          const problems = asm.assemblies.find((x) => x.id === a.id)?.problems;
          return { assembly: a.id, interference: hits.get(a.id), ...(clearance ? { near: close.get(a.id) } : {}), ...(expected ? { expected } : {}), problems: problems?.length ? problems : undefined };
        });
      if (skipped.pairs) out.skipped = { pairs: skipped.pairs, reason: [...skipped.reasons].join("; "), hint: "check fewer pairs with near or part" };
      return text(out);
    },
    { readOnlyHint: true },
  );

  // ---------------- versions ----------------
  tool("list_versions", "Version history, newest first (limit: default 20).", { document, limit: z.number().int().min(1).max(200).optional() }, async ({ document: dd, limit }) => {
    const documentID = docID(dd);
    await requireMember(db, s.userID, documentID);
    const rows = await db.sql`SELECT v.id, v.number, v.kind, v.message, v.note_id, v.created_at, u.name AS user_name, a.client_name, a.label FROM versions v LEFT JOIN users u ON u.id = v.author_user_id LEFT JOIN agent_sessions a ON a.id = v.author_agent_id WHERE v.document_id = ${documentID} ORDER BY v.number DESC LIMIT ${limit ?? 20}`;
    return text({ versions: rows.map((v: any) => ({ id: v.id, number: Number(v.number), kind: v.kind, message: v.message, note: v.note_id ?? undefined, author: v.client_name ? `${v.client_name}${v.label ? ` (${v.label})` : ""}` : v.user_name, at: when(v.created_at) })) });
  }, { readOnlyHint: true });

  tool("read_version", "A script as it was at a version (path), or every script (content: true). With neither, lists the version's scripts and whether each is the same now.", { document, id: z.string(), path: z.string().optional(), content: z.boolean().optional() }, async ({ document: dd, id, path, content }) => {
    const documentID = docID(dd);
    await requireMember(db, s.userID, documentID);
    if (!path && !content) {
      const [v] = await db.sql`SELECT number, message, snapshot FROM versions WHERE id = ${id} AND document_id = ${documentID}`;
      if (!v) throw new ToolError(`No version ${id} in this document (list_versions).`);
      const now = new Map((await db.sql`SELECT path, content_hash FROM scripts WHERE document_id = ${documentID}`).map((r: any) => [r.path as string, r.content_hash as string]));
      const scripts = Object.fromEntries(Object.entries((v.snapshot?.scripts ?? {}) as Record<string, string>).map(([p, h]) => [p, !now.has(p) ? "deleted since" : now.get(p) === h ? "same now" : "changed since"]));
      return text({ version: Number(v.number), message: v.message, scripts });
    }
    const v = await readVersion(db, id, s.userID, path).catch((e) => {
      throw new ToolError((e as Error).message);
    });
    return text({ version: v.version.number, message: v.version.message, scripts: v.scripts });
  }, { readOnlyHint: true });

  tool("restore_version", "Copy a version to the tip as a new version (nothing is overwritten). Result like write_script.", { document, id: z.string(), verbose }, async ({ document: dd, id, verbose }) => {
    const documentID = docID(dd);
    await requireMember(db, s.userID, documentID, "editor");
    const versionID = newID();
    await mutate(mutators.version.restore({ documentID, versionID: id, newVersionID: versionID } as any));
    const paths = (await db.sql`SELECT path FROM scripts WHERE document_id = ${documentID} ORDER BY path`).map((r: any) => r.path as string);
    return text(await afterWrite(documentID, `restore version`, { versionID, paths, verbose, all: true }));
  });

  // ---------------- export / import ----------------
  tool("export", "Export a part, instance, assembly or subassembly copy as STEP, STL or 3MF; returns a signed download URL (valid 1 hour).", { document, part: z.string(), format: z.enum(["step", "stl", "3mf"]) }, async ({ document: dd, part, format }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    const asm = await assemblyState(d, [part]);
    const targets = expandTargets([part], await partsOf(d), asm.infos);
    if (targets.unknown.length) throw unknownTargets("part, instance, assembly or subassembly", targets.unknown, await partsOf(d), asm.infos);
    await regen(d, targets.ids);
    const [, f] = await engine(d, [{ op: "setPoses", poses: asm.poses }, { op: "export", parts: targets.ids, format }]);
    const bytes = Buffer.from((f as any).base64, "base64");
    const type = ({ step: "model/step", stl: "model/stl", "3mf": "model/3mf" } as Record<string, string>)[format as string];
    const url = await storeFile(documentID, new Uint8Array(bytes), type);
    return text({ url: downloadURL(url), bytes: bytes.length });
  }, { readOnlyHint: true });

  registerOutputTools({
    tool: tool as any,
    document,
    load: (dd) => loadDoc(db, s.userID, docID(dd)),
    engine,
    store: async (documentID, bytes, type) => {
      const url = await storeFile(documentID, bytes, type);
      return `${deps.config.appOrigin}${url.startsWith("/") ? "" : "/"}${url.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "")}`;
    },
    version: async (documentID) => (await latestVersion(documentID))?.number ?? null,
  });

  tool("export_document", "The whole document as a plain-file zip; returns a signed download URL (valid 1 hour), or the zip inline with base64: true.", { document, notes: z.boolean().optional(), base64: z.boolean().optional() },async ({ document: dd, notes, base64 }) => {
    const documentID = docID(dd);
    const payload = await exportDocument(db, documentID, s.userID, { notes: notes ?? true });
    const zip = buildDocumentZip(payload);
    const filename = `${payload.manifest.name}.zip`;
    if (base64) return text({ filename, base64: Buffer.from(zip).toString("base64") });
    const url = await storeFile(documentID, zip, "application/zip");
    return text({ filename, url: downloadURL(url), bytes: zip.length });
  }, { readOnlyHint: true });

  tool("import_document", "Create a document from a plain-file zip (zip: base64).", { zip: z.string(), name: z.string().optional() }, async ({ zip, name }) => {
    const payload = parseDocumentZip(new Uint8Array(Buffer.from(zip, "base64")));
    const { documentID } = await importDocument(db, payload, ctx(), { name });
    s.defaultDocument ??= documentID;
    return text({ id: documentID, name: name ?? payload.manifest.name, url: documentURL(documentID) });
  });

  compactToolList(server);
}
