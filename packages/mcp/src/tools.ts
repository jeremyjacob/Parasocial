// MCP tools (§7). Every tool takes a `document` (defaulting to the session's). Writes go
// through the shared mutators as this agent session; geometry questions run in the engine pool
// (the same engine build the browser runs), so agents see exactly what the human sees.
import { z } from "zod";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mutators, newID, type NoteTarget } from "@parasocial/sync";
import { runMutator, readVersion, exportDocument, importDocument, buildDocumentZip, parseDocumentZip, signBlobURL, type Db, type BlobStore } from "@parasocial/sync/server";
import type { PoolClient } from "@parasocial/engine-pool/client";
import { loadDoc, overridesFor, scriptMap, requireMember, AccessError, type DocState } from "./docs";
import { NoteCursor, type NoteEvents } from "./note-events";
import { documentContext } from "./document-context";
import { trace } from "./trace";
import { recordTouch, othersOn, changedUnderYou } from "./awareness";
import { emptyPreview, mergeOverrides, solveAssemblies, findAssembly, jointValues, expandTargets, posedBox, posedPoint, posedDir, type Preview } from "./preview";
import { sourcePart, type AssemblyInfo, type PartPose } from "@parasocial/runtime/protocol";

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

const text = (v: unknown): ToolResult => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const vec = (v?: number[]) => v?.map((x) => round(x, 4));

const LIMIT_PER_MIN = 240;

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
    if (!r.ok) throw new ToolError(r.message, r.details);
  }

  async function setStatus(status: "idle" | "working" | "writing", documentID?: string, detail?: Record<string, unknown> | null) {
    await runMutator(db, mutators.agent.setStatus({ id: s.id, status, documentID: documentID ?? null, ...(detail !== undefined ? { detail } : {}) } as any), ctx()).catch(() => {});
  }

  /** Append an activity-log entry to every note this session has claimed in the document. */
  async function activity(documentID: string, line: string) {
    const claimed = await db.sql`SELECT id FROM notes WHERE document_id = ${documentID} AND claimed_by = ${s.id} AND removed_at IS NULL`;
    for (const n of claimed) await runMutator(db, mutators.note.reply({ id: newID(), noteID: n.id, text: line, kind: "activity" } as any), ctx()).catch(() => {});
  }

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
    const [infos] = await engine(d, [{ op: "parts" }]);
    return (infos as { id: string }[]).map((p) => p.id);
  }

  /**
   * Assemblies and where their instances are for this session: the document's saved joint values
   * (what people see), then this session's set_pose values on top. Regenerates the parts they use.
   */
  async function assemblyState(d: DocState) {
    const [infos] = (await engine(d, [{ op: "assemblies" }])) as [AssemblyInfo[]];
    if (!infos.length) return { infos, poses: {} as Record<string, PartPose>, assemblies: [] as ReturnType<typeof solveAssemblies>["assemblies"] };
    const sources = [...new Set(infos.flatMap((a) => a.instances.map((i) => i.part)))];
    // not engine(): a part that fails to regenerate leaves its assembly unposed instead of failing the call
    const results = await pool.run({ document: `${d.id}:${configOf(d) ?? "default"}`, scripts: scriptMap(d), overrides: mergeOverrides(overridesFor(d, configOf(d)), s.preview?.get(d.id)), units: d.units, ops: sources.map((part) => ({ op: "regenerate", part })) });
    const meta = new Map(sources.map((p, i) => [p, results[i]?.ok ? (results[i] as any).value : undefined]));
    const [row] = await db.sql`SELECT settings FROM documents WHERE id = ${d.id}`;
    const shared = (row?.settings as any)?.poses;
    return { infos, ...solveAssemblies(infos, (p) => meta.get(p), shared && typeof shared === "object" ? shared : {}, s.preview?.get(d.id)?.poses) };
  }

  /** Regenerate parts; compact results in the shape the UI shows (§8 Errors). */
  async function regen(d: DocState, parts?: string[]) {
    parts ??= await partsOf(d);
    const out = await engine(d, parts.map((part) => ({ op: "regenerate", part })));
    return out.map((r: any) => summarize(r));
  }

  function summarize(r: any) {
    if (!r) return null;
    return {
      part: r.part,
      name: r.name,
      ok: r.ok,
      showingLastGoodGeometry: r.partial && !r.empty ? true : undefined,
      problems: r.problems.map((p: any) => ({ severity: p.severity, kind: p.kind, message: p.message, source: p.source, op: p.op, highlight: p.highlight })),
      faces: r.faces.length,
      edges: r.edges.length,
      bbox: r.bbox ? { min: vec(r.bbox.min), max: vec(r.bbox.max) } : undefined,
      volume: r.mass ? round(r.mass.volume, 2) : undefined,
      timingsMs: { total: round(r.timings.total, 1), ops: round(r.timings.ops, 1) },
    };
  }

  function describeEntity(e: any) {
    const measure = e.kind === "face" ? { area: round(e.area), normal: vec(e.normal), radius: e.radius && round(e.radius), axis: vec(e.axis) } : e.kind === "edge" ? { length: round(e.length), radius: e.radius && round(e.radius), direction: vec(e.axis) } : { point: vec(e.center) };
    return {
      part: e.part,
      kind: e.kind,
      type: e.type,
      name: e.name,
      ...measure,
      center: vec(e.center),
      createdBy: e.createdBy && {
        operation: e.createdBy.id,
        tag: e.createdBy.tag,
        type: e.createdBy.type,
        source: e.createdBy.source && `${e.createdBy.source.file}:${e.createdBy.source.line}`,
        callChain: e.createdBy.chain?.map((c: any) => `${c.fn && !c.fn.startsWith("<") && c.fn !== "Object.eval [as body]" ? c.fn + "() at " : ""}${c.file}:${c.line}`),
      },
      neighbors: e.neighbors?.length ? e.neighbors : undefined,
    };
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
          out.push({ kind: t.kind, part, name: t.name, status: "orphaned", point: vec(t.point), hint: "The geometry this note pointed at is gone. Use the point and the snapshot to understand intent." });
          continue;
        }
        const idx = r.indices.length > 1 ? (await engine(d, [{ op: "resolveOne", part, kind: t.kind, candidates: r.indices, point: t.point }]))[0] : r.indices[0];
        const [desc] = await engine(d, [{ op: "describe", part, kind: t.kind, index: idx }]);
        out.push({ ...describeEntity(desc), resolvedBy: r.status, splitInto: r.indices.length > 1 ? r.indices.length : undefined, notePoint: vec(t.point) });
      } catch (e) {
        out.push({ kind: t.kind, part, name: t.name, status: "unresolved", error: (e as Error).message });
      }
    }
    return out;
  }

  async function noteView(documentID: string, n: any, d: DocState) {
    const messages = await db.sql`SELECT m.kind, m.text, m.data, m.created_at, m.version_id, u.name AS user_name, a.client_name, a.label FROM note_messages m LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agent_sessions a ON a.id = m.author_agent_id WHERE m.note_id = ${n.id} ORDER BY m.created_at`;
    const strokes = await db.sql`SELECT part, points, color FROM markup_strokes WHERE note_id = ${n.id}`;
    const numberRows = await db.sql`SELECT id FROM notes WHERE document_id = ${documentID} ORDER BY created_at`;
    return {
      id: n.id,
      number: numberRows.findIndex((r: any) => r.id === n.id) + 1,
      status: n.status,
      orphaned: n.orphaned,
      removed: !!n.removed_at,
      claimedBy: n.claimed_by ?? undefined,
      author: n.author_agent_id ? "agent" : "human",
      targets: await describeTargets(d, n.anchor.targets),
      view: { camera: n.anchor.camera, configuration: n.anchor.configuration, render: `render({ view: "note:${n.id}" })` },
      markup: strokes.length ? strokes.map((st: any) => ({ part: st.part, color: st.color, points: st.points.length, from: vec(st.points[0]), to: vec(st.points[st.points.length - 1]) })) : undefined,
      snapshot: n.snapshot_hash ? signBlobURL(deps.config, { hash: n.snapshot_hash, documentID, basePath: "/api/blobs" }) : undefined,
      messages: messages.map((m: any) => ({ kind: m.kind, from: m.client_name ? `${m.client_name}${m.label ? ` (${m.label})` : ""}` : (m.user_name ?? "someone"), text: m.text, images: messageImages(m).length ? messageImages(m).map((hash) => signBlobURL(deps.config, { hash, documentID, basePath: "/api/blobs" })) : undefined, at: new Date(Number(m.created_at)).toISOString(), version: m.version_id ?? undefined })),
    };
  }

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
        result = await fn(args, extra);
      } catch (e) {
        thrown = e;
        const msg = e instanceof ToolError || e instanceof AccessError ? e.message : `Internal error: ${(e as Error).message}`;
        const data = e instanceof ToolError ? e.data : undefined;
        result = { isError: true, content: [{ type: "text", text: data ? `${msg}\n${JSON.stringify(data, null, 2)}` : msg }] };
      }
      traceCall({ session: s.id, client: s.clientName, label: s.label, document: s.defaultDocument, tool: name, args, ms: Date.now() - now, isError: !!result.isError, result: result.content, ...(thrown && !(thrown instanceof ToolError) ? { exception: thrown } : {}) });
      return result;
    }) as any);
  }

  const document = z.string().optional().describe("Document id (defaults to this session's document)");

  // ---------------- documents ----------------
  const documentURL = (id: string) => new URL(`/d/${encodeURIComponent(id)}`, deps.config.appOrigin).href;
  const documentName = z.string().trim().min(1).max(200);

  tool("list_documents", "Find documents you can access, newest edits first. Search by name; use offset to paginate.", { query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }, async ({ query, limit, offset }) => {
    const rows = await db.sql`SELECT d.id, d.name, d.updated_at, d.head_version, m.role FROM documents d JOIN document_members m ON m.document_id = d.id AND m.user_id = ${s.userID}
      WHERE strpos(lower(d.name), lower(${query ?? ""})) > 0 ORDER BY d.updated_at DESC, d.id LIMIT ${limit + 1} OFFSET ${offset}`;
    return text({ default: s.defaultDocument, documents: rows.slice(0, limit).map((r) => ({ id: r.id, name: r.name, url: documentURL(r.id), role: r.role, version: Number(r.head_version), updated: new Date(Number(r.updated_at)).toISOString() })), nextOffset: rows.length > limit ? offset + limit : null });
  }, { readOnlyHint: true });

  tool("get_document_context", "This user's recent browser activity and the agent's current default. Activity is a hint, not an exact list of open tabs; it never changes the default.", {}, async () =>
    text({ default: s.defaultDocument, ...await documentContext(db, s.userID, deps.config.appOrigin) }), { readOnlyHint: true });

  tool("open_document", "Select a document as this agent session's default and return its details. Accepts an ID or a Parasocial document URL. Does not navigate the human's browser.", { document: z.string().min(1) }, async ({ document: target }) => {
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
    return text({ id, name: d.name, url: documentURL(id), units: d.units, scripts: d.scripts.map((f) => f.path), configurations: d.configurations.map((c) => ({ id: c.id, name: c.name })) });
  }, { readOnlyHint: true });

  tool("create_document", "Create an empty document (then write studios/<name>.ts). Becomes the default only if the session has none; use open_document to switch.", { name: documentName }, async ({ name }) => {
    const id = newID();
    await mutate(mutators.document.create({ id, name }));
    s.defaultDocument ??= id;
    return text({ id, name, url: documentURL(id) });
  });

  tool("rename_document", "Rename a document. Requires editor access.", { document, name: documentName }, async ({ document: dd, name }) => {
    const id = docID(dd);
    await mutate(mutators.document.rename({ id, name }));
    return text({ id, name, url: documentURL(id) });
  });

  tool("duplicate_document", "Copy a document's scripts, settings and configurations into a new document you own. Notes and version history are not copied. Does not change the session default.", { document, name: documentName.optional() }, async ({ document: dd, name }) => {
    const payload = await exportDocument(db, docID(dd), s.userID, { notes: false });
    const copyName = name ?? `${payload.manifest.name.slice(0, 193)} (copy)`;
    const { documentID: id } = await importDocument(db, payload, ctx(), { name: copyName });
    return text({ id, name: copyName, url: documentURL(id) });
  });

  tool("delete_document", "Permanently delete a document and its contents, including notes and version history. Requires owner access and an explicit document ID. Only use when the user requests deletion.", { document: z.string().min(1) }, async ({ document: id }) => {
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
    "Note threads with fully described targets (stable name, the operation that made it with its source line and helper chain, measurements, neighbors), markup and a snapshot link. Messages with pasted images list their links; get_note returns the images themselves.",
    { document, status: z.enum(["Open", "AgentWorking", "Resolved", "all"]).optional(), part: z.string().optional(), studio: z.string().optional().describe("Filter studio-level notes by studio script path, e.g. studios/model.ts.") },
    async ({ document: dd, status, part, studio }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const rows = await db.sql`SELECT * FROM notes WHERE document_id = ${documentID} AND removed_at IS NULL ORDER BY created_at`;
      const want = rows.filter((n: any) => (!status || status === "all" ? n.status !== "Resolved" : n.status === status) && (!part || n.anchor.targets.some((t: NoteTarget) => t.part === part)) && (!studio || n.anchor.targets.some((t: NoteTarget) => t.kind === "studio" && t.studio === studio)));
      const out = [];
      for (const n of want) out.push(await noteView(documentID, n, d));
      return text({ notes: out });
    },
    { readOnlyHint: true },
  );

  tool("get_note", "One note thread, described like list_notes, followed by the images people pasted into it (messages[].images lists them in order).", { document, id: z.string() }, async ({ document: dd, id }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    const [n] = await db.sql`SELECT * FROM notes WHERE id = ${id} AND document_id = ${documentID}`;
    if (!n) throw new ToolError(`No note ${id} in this document.`);
    const view = text(await noteView(documentID, n, d));
    return { content: [...view.content, ...(await noteImages(n.id))] };
  });

  tool(
    "wait_for_notes",
    "Block until a human adds a note or replies on one (notes held by other agents are skipped), then return those notes described like list_notes, each with a `reason` (created, and/or the new replies), followed by the images pasted into them. Returns { notes: [] } at the timeout; call it again to keep waiting. Each call continues where the previous one stopped, starting from when this session connected, so call list_notes first for what was already there.",
    {
      document,
      allDocuments: z.boolean().optional().describe("wait across every document you can access instead of one; each note then carries its `document`"),
      timeoutSeconds: z.number().int().min(1).max(600).optional().describe("default 50; some clients time out tool calls after 60 s"),
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
        if (!found.length) return text({ notes: [], hint: "Nothing new. Call wait_for_notes again to keep waiting." });
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
    "Reply on a note thread and resolve it by default after completing and verifying the work. Links the version you created (default: your latest write) and releases your claim. Use Open for unfinished work or questions. Keep the text short (one to three sentences): what changed or what you need, not a recap of the work.",
    { document, id: z.string(), text: z.string().min(1), version: z.string().optional().describe("version id to link (default: your latest)"), status: z.enum(["Resolved", "Open"]).optional().describe("default Resolved; Open for unfinished work or questions") },
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

  tool("claim_note", "Claim a note for this session before working on it. Fails with the holder's name if another session has it.", { document, id: z.string() }, async ({ document: dd, id }) => {
    const documentID = docID(dd);
    await requireMember(db, s.userID, documentID);
    await mutate(mutators.note.claim({ noteID: id }));
    return text({ ok: true, claimed: id });
  });

  tool("release_note", "Release a note you claimed (e.g. if you stop working on it).", { document, id: z.string() }, async ({ document: dd, id }) => {
    const documentID = docID(dd);
    await requireMember(db, s.userID, documentID);
    await mutate(mutators.note.release({ noteID: id }));
    await setStatus("idle", documentID, null);
    return text({ ok: true });
  });

  tool("set_note_status", "Set a note's status and release its claim. Resolve completed, verified work without asking for permission. No completion reply is required. Use reply_to_note only when you have useful information to add.", { document, id: z.string(), status: z.enum(["Open", "Resolved"]) }, async ({ document: dd, id, status }) => {
    await requireMember(db, s.userID, docID(dd));
    await mutate(mutators.note.setStatus({ noteID: id, status }));
    return text({ ok: true });
  });

  tool("delete_note", "Remove a finished note (soft delete; humans can restore it).", { document, id: z.string() }, async ({ document: dd, id }) => {
    await requireMember(db, s.userID, docID(dd));
    await mutate(mutators.note.remove({ noteID: id }));
    return text({ ok: true });
  });

  tool("get_selection", "The human's current selection in the workspace, described like note targets.", { document }, async ({ document: dd }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    const [p] = await db.sql`SELECT selection FROM presence WHERE document_id = ${documentID} AND user_id = ${s.userID} AND agent_session_id IS NULL ORDER BY updated_at DESC LIMIT 1`;
    const sel = (p?.selection ?? []) as any[];
    if (!sel.length) return text({ selection: [], hint: "Nothing is selected in the workspace." });
    return text({ selection: await describeTargets(d, sel.map((e) => ({ ...e, point: [0, 0, 0] }))) });
  }, { readOnlyHint: true });

  // ---------------- scripts ----------------
  tool("list_scripts", "Scripts with their content and current version.", { document }, async ({ document: dd }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    for (const x of d.scripts) recordTouch(s, documentID, x.path, "read", x.version);
    const others = await othersOn(db, s, documentID, d.scripts.map((x) => x.path));
    return text({ scripts: d.scripts.map((x) => ({ path: x.path, version: x.version, content: x.content, ...(others[x.path] ? { otherSessions: others[x.path] } : {}) })) });
  }, { readOnlyHint: true });

  tool("read_script", "One script's content and version (pass the version back as baseVersion when writing). Lists other sessions recently on this file.", { document, path: z.string() }, async ({ document: dd, path }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    const sc = d.scripts.find((x) => x.path === path);
    if (!sc) throw new ToolError(`No script at ${path}. Scripts: ${d.scripts.map((x) => x.path).join(", ") || "none"}`);
    recordTouch(s, documentID, path, "read", sc.version);
    const others = (await othersOn(db, s, documentID, [path]))[path];
    return text({ path, version: sc.version, content: sc.content, ...(others ? { otherSessions: others } : {}) });
  }, { readOnlyHint: true });

  /** "error studios/a.ts:12 message" (the location moved to the front). */
  const problemLine = (p: any) => {
    const at = p.source ? `${p.source.file}:${p.source.line}` : "";
    const message = at ? String(p.message).replace(/\s*\([^()]*:\d+(?::\d+)?\)\s*$/, "") : p.message;
    return `${p.severity}${at ? ` ${at}` : ""} ${message}`;
  };

  /**
   * After a committed write: our version and new script versions, a compact regeneration result
   * per part (full summaries with `verbose`), and who else is on these files. Nothing here may
   * fail the call, since the write already landed: problems come back in the result.
   */
  async function afterWrite(documentID: string, label: string, w: { versionID: string; paths: string[]; verbose?: boolean | undefined }) {
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
    const out: Record<string, unknown> = { ok: true, version, ...(version ? {} : { unchanged: "already up to date (nothing new was written)" }), scripts };
    let failed = false;
    try {
      const d = await loadDoc(db, s.userID, documentID);
      const parts = await partsOf(d);
      const raw = await engine(d, parts.map((part) => ({ op: "regenerate", part })));
      failed = raw.some((r: any) => r && !r.ok);
      out.parts = raw.map((r: any) => ({ part: r.part, ok: r.ok, ...(r.partial && !r.empty ? { showingLastGoodGeometry: true } : {}), ...(r.problems.length ? { problems: r.problems.map(problemLine) } : {}) }));
      if (w.verbose) out.regeneration = raw.map((r: any) => summarize(r));
    } catch (e) {
      failed = true;
      out.parts = [];
      out.problems = [`error regeneration failed after the write was saved: ${(e as Error).message}. The write is committed (see version); call list_problems or retry the check, not the write.`];
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

  const writeId = z.string().min(8).max(200).optional().describe("idempotency key: reuse the same value when retrying this exact write");
  const verbose = z.boolean().optional().describe("include the full regeneration result per part (bounding boxes, faces, timings); default is ok/problems only");

  tool(
    "write_script",
    "Create or replace a script (studios/*.ts or lib/**/*.ts). Pass baseVersion from read_script (null to create). Creates a version, regenerates, and returns per-part ok/problems, the new script version and files others changed under you. Safe to retry.",
    { document, path: z.string(), content: z.string(), baseVersion: z.number().int().nullable(), message: z.string().optional(), note: z.string().optional().describe("note id this change answers"), writeId, verbose },
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
    "Search/replace edits on a script (each search must match exactly once unless all: true). Pass baseVersion. Creates a version and returns a compact regeneration result like write_script. Safe to retry.",
    { document, path: z.string(), edits: z.array(z.object({ search: z.string(), replace: z.string(), all: z.boolean().optional() })).min(1), baseVersion: z.number().int(), message: z.string().optional(), note: z.string().optional(), writeId, verbose },
    async ({ document: dd, path, edits, baseVersion, message, note, writeId, verbose }) => {
      const documentID = docID(dd);
      await requireMember(db, s.userID, documentID, "editor");
      await setStatus("writing", documentID, { path });
      const versionID = writeId ?? newID();
      await mutate(mutators.script.edit({ documentID, path, edits, baseVersion, message, noteID: note, versionID } as any));
      return text(await afterWrite(documentID, `edit ${path}`, { versionID, paths: [path], verbose }));
    },
  );

  tool(
    "write_scripts",
    "Change several scripts atomically: one transaction, one version, one regeneration, so a lib change and the studios that use it land together. Each file gives content, edits or delete: true, plus its own baseVersion (null to create). Any stale baseVersion rejects the whole write and nothing changes.",
    {
      document,
      files: z
        .array(
          z.object({
            path: z.string(),
            content: z.string().optional(),
            edits: z.array(z.object({ search: z.string(), replace: z.string(), all: z.boolean().optional() })).min(1).optional(),
            delete: z.boolean().optional(),
            baseVersion: z.number().int().nullable(),
          }),
        )
        .min(1)
        .max(50),
      message: z.string().optional(),
      note: z.string().optional().describe("note id this change answers"),
      writeId,
      verbose,
    },
    async ({ document: dd, files, message, note, writeId, verbose }) => {
      const documentID = docID(dd);
      await requireMember(db, s.userID, documentID, "editor");
      await setStatus("writing", documentID, { path: files[0]!.path });
      const versionID = writeId ?? newID();
      await mutate(mutators.script.writeMany({ documentID, files, message, noteID: note, versionID } as any));
      return text(await afterWrite(documentID, `write ${files.map((f) => f.path).join(", ")}`, { versionID, paths: files.map((f) => f.path), verbose }));
    },
  );

  tool("delete_script", "Delete a script. Pass baseVersion.", { document, path: z.string(), baseVersion: z.number().int(), writeId, verbose }, async ({ document: dd, path, baseVersion, writeId, verbose }) => {
    const documentID = docID(dd);
    await requireMember(db, s.userID, documentID, "editor");
    const versionID = writeId ?? newID();
    await mutate(mutators.script.delete({ documentID, path, baseVersion, versionID } as any));
    return text(await afterWrite(documentID, `delete ${path}`, { versionID, paths: [path], verbose }));
  });

  // ---------------- geometry ----------------
  const VIEWS = ["iso", "top", "bottom", "front", "back", "left", "right"] as const;
  tool(
    "render",
    'PNG of the model. view: "iso" | "top" | "front" | … or "note:<id>" for a note\'s own view; or a custom camera. up: which model axis points up, "z" (default, as in the workspace viewer: top looks down -Z, front looks along +Y) or "y" (top looks down -Y, front looks along -Z); it also sets the default camera.up and the ground grid. parts: part ids, assembly instance ids (mechanism/box:lid) or an assembly id (all its instances); default every part. Instances render where this session poses them (the shared positions plus your set_pose previews), and your set_param previews apply. highlight: stable names or selectors to mark in orange. section: optional cutting plane for a hatched section view of this render only.',
    {
      document,
      view: z.string().optional(),
      up: z.enum(["z", "y"]).optional().describe('Up axis for named views and the default camera.up: "z" (default, the workspace viewer\'s convention) or "y"'),
      camera: z.object({ position: z.array(z.number()).length(3), target: z.array(z.number()).length(3), up: z.array(z.number()).length(3).optional(), ortho: z.boolean().optional() }).optional(),
      section: z.object({
        origin: z.array(z.number().finite()).length(3).describe("Point on the cutting plane in model coordinates (mm)."),
        normal: z.array(z.number().finite()).length(3).refine((n) => {
          const lengthSquared = n.reduce((sum, x) => sum + x * x, 0);
          return lengthSquared > 0 && Number.isFinite(lengthSquared);
        }, "Section normal must have a finite, nonzero length.").describe("Direction toward the removed side; need not be normalized. Negate to flip the cut."),
      }).optional().describe("Clips points where dot(point - origin, normal) > 0. Omit for the full model. Example: { origin: [0, 0, 5], normal: [0, 0, 1] } keeps z <= 5."),
      highlight: z.array(z.object({ part: z.string(), name: z.string() })).optional(),
      parts: z.array(z.string()).optional().describe("part ids, instance ids or assembly ids; default every part"),
      style: z.enum(["shaded", "shadedEdges", "wireframe", "hiddenLine"]).optional(),
      width: z.number().int().min(128).max(2048).optional(),
      height: z.number().int().min(128).max(2048).optional(),
    },
    async ({ document: dd, view, up, camera, section, highlight, parts, style, width, height }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const asm = await assemblyState(d);
      const all = await partsOf(d);
      let ids = all;
      if (parts) {
        const t = expandTargets(parts, all, asm.infos);
        if (t.unknown.length) throw new ToolError(`Unknown part, instance or assembly: ${t.unknown.join(", ")}. Parts: ${all.join(", ") || "none"}${asm.infos.length ? `. Assemblies: ${asm.infos.map((a) => `${a.id} (${a.instances.map((i) => i.id).join(", ")})`).join("; ")}` : ""}`);
        ids = t.ids;
      }
      await regen(d, ids);
      let cam = camera as any;
      let v: string | undefined = view ?? "iso";
      if (view?.startsWith("note:")) {
        const [n] = await db.sql`SELECT anchor FROM notes WHERE id = ${view.slice(5)} AND document_id = ${documentID}`;
        if (!n) throw new ToolError(`No note ${view.slice(5)}.`);
        cam = n.anchor.camera;
        v = undefined;
        highlight ??= n.anchor.targets.filter((t: NoteTarget) => t.kind === "face" || t.kind === "edge" || t.kind === "vertex").map((t: NoteTarget) => ({ part: t.part, name: t.name }));
      } else if (v && !VIEWS.includes(v as any)) throw new ToolError(`Unknown view "${v}". Use ${VIEWS.join(", ")} or note:<id>.`);
      const refs: any[] = [];
      for (const h of highlight ?? []) {
        try {
          const r = await resolveName(d, h.part, h.name);
          for (const index of r.indices) refs.push({ part: h.part, kind: r.kind, index });
        } catch {}
      }
      const poses = Object.fromEntries(ids.filter((p) => asm.poses[p]).map((p) => [p, asm.poses[p]]));
      const [img] = await engine(d, [{ op: "render", view: v, up: up ?? "z", camera: cam && { ...cam, up: cam.up ?? (up === "y" ? [0, 1, 0] : [0, 0, 1]) }, section, highlight: refs, parts: ids, poses, style, width: width ?? 1024, height: height ?? 768 }]);
      await activity(documentID, `render ${view ?? "iso"}${refs.length ? ` (${refs.length} highlighted)` : ""}`);
      return { content: [{ type: "image", data: (img as any).png, mimeType: "image/png" }] };
    },
    { readOnlyHint: true },
  );

  tool(
    "describe_model",
    "Parts with bounding boxes, volume/area/mass; then every face and edge with name, type, area/length, normal/axis and source location. part may be an assembly instance (mechanism/box:lid) or an assembly id (all its instances): instances are described where this session poses them (world coordinates). Without part, also lists assemblies with their instances and joint values (and whether each value is your session preview, the shared one, or home).",
    { document, part: z.string().optional(), entities: z.boolean().optional().describe("include faces and edges (default true when part is given)") },
    async ({ document: dd, part, entities }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const asm = await assemblyState(d);
      let parts = await partsOf(d);
      if (part) {
        const t = expandTargets([part], parts, asm.infos);
        if (t.unknown.length) throw new ToolError(`No part, instance or assembly "${part}". Parts: ${parts.join(", ") || "none"}${asm.infos.length ? `. Assemblies: ${asm.infos.map((a) => a.id).join(", ")}` : ""}`);
        parts = t.ids;
      }
      const results = await engine(d, parts.map((p) => ({ op: "regenerate", part: p })));
      const out: any[] = [];
      for (const r of results as any[]) {
        // instances: part coordinates -> where this session poses them
        const pose = asm.poses[r.part];
        const place = (e: any) => (pose ? { ...e, center: vec(posedPoint(e.center, pose)), normal: vec(posedDir(e.normal, pose)), axis: vec(posedDir(e.axis, pose)), direction: vec(posedDir(e.direction, pose)), point: vec(posedPoint(e.point, pose)) } : e);
        const summary = summarize(r)!;
        const entry: any = { ...summary, bbox: pose && r.bbox ? (({ min, max }) => ({ min: vec(min), max: vec(max) }))(posedBox(r.bbox, pose)) : summary.bbox, posed: pose ? true : undefined, color: r.color, appearance: r.appearance, material: r.material, mass: r.mass && { volume: round(r.mass.volume, 2), area: round(r.mass.area, 2), massGrams: round(r.mass.mass, 2), centroid: vec(posedPoint(r.mass.centroid, pose)) }, params: r.params.map((p: any) => ({ name: p.name, value: p.value, unit: p.unit, overridden: p.overridden, preview: s.preview?.get(documentID)?.params[sourcePart(r.part)]?.[p.name] !== undefined || undefined })) };
        if ((entities ?? !!part) && !r.empty) {
          const [all] = await engine(d, [{ op: "describeAll", part: r.part }]);
          entry.faces = (all as any).faces.map(describeEntity).map(place);
          entry.edges = (all as any).edges.map(describeEntity).map(place);
        }
        out.push(entry);
      }
      await activity(documentID, `describe_model${part ? ` ${part}` : ""}`);
      const preview = s.preview?.get(documentID);
      return text({
        document: d.name,
        units: d.units,
        configuration: d.configurations.find((c) => c.id === configOf(d))?.name ?? "Default",
        sessionPreview: preview && (Object.keys(preview.params).length || Object.keys(preview.poses).length) ? preview : undefined,
        parts: out,
        assemblies: !part && asm.assemblies.length ? asm.assemblies.map(({ poses: _, ...a }) => a) : undefined,
      });
    },
    { readOnlyHint: true },
  );

  tool(
    "query",
    'Evaluate a selector against the live model and return matching entities, e.g. ">Z", "base.side & |Z", "%circle", "bore".',
    { document, expr: z.string(), part: z.string().optional(), kind: z.enum(["face", "edge", "vertex"]).optional() },
    async ({ document: dd, expr, part, kind }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const p = part ?? (await partsOf(d))[0];
      if (!p) throw new ToolError("This document has no parts.");
      await regen(d, [p]);
      const k = kind ?? "face";
      const [idx] = await engine(d, [{ op: "query", part: p, expr, kind: k }]);
      const descs = await engine(d, (idx as number[]).slice(0, 100).map((index) => ({ op: "describe", part: p, kind: k, index })));
      return text({ part: p, kind: k, count: (idx as number[]).length, entities: descs.map(describeEntity), truncated: (idx as number[]).length > 100 || undefined });
    },
    { readOnlyHint: true },
  );

  const ref = z.object({ part: z.string(), name: z.string().optional().describe("stable name or selector; omit for the whole part") });
  tool("measure", "Distance, angle or minimum clearance between two entities or parts. Assembly instances (mechanism/box:lid) are measured where this session poses them (shared positions plus your set_pose previews).", { document, a: ref, b: ref }, async ({ document: dd, a, b }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    // the engine is shared with other sessions: always set this session's poses (none unless an instance is involved)
    const poses = a.part.includes("/") || b.part.includes("/") ? (await assemblyState(d)).poses : {};
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
      const [, v] = await engine(d, [{ op: "setPoses", poses }, { op: "interference", a: A.part, b: B.part }]);
      out.interferenceVolume = round(v as number, 3);
    }
    await activity(documentID, `measure ${a.part}${a.name ? ` · ${a.name}` : ""} ↔ ${b.part}${b.name ? ` · ${b.name}` : ""}: ${out.distance}`);
    return text(out);
  }, { readOnlyHint: true });

  // ---------------- params & configurations ----------------
  tool("get_params", "Each param's code default, override (if any) and effective value, per part. preview: true marks this session's set_param previews (scope \"session\").", { document, configuration: z.string().optional() }, async ({ document: dd, configuration }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    if (configuration) s.activeConfig.set(documentID, findConfig(d, configuration));
    const results = await engine(d, (await partsOf(d)).map((part) => ({ op: "regenerate", part })));
    return text({
      configuration: d.configurations.find((c) => c.id === configOf(d))?.name ?? "Default",
      parts: (results as any[]).map((r) => ({ part: r.part, params: r.params.map((p: any) => ({ name: p.name, codeDefault: p.default, override: p.overridden ? p.expression : undefined, preview: s.preview?.get(documentID)?.params[r.part]?.[p.name] !== undefined || s.preview?.get(documentID)?.params["*"]?.[p.name] !== undefined || undefined, effective: p.value, unit: p.unit, min: p.min, max: p.max, step: p.step, options: p.options, source: p.source && `${p.source.file}:${p.source.line}`, error: p.error })) })),
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

  tool(
    "set_param",
    'Override a param. scope "session" (default): a preview only this MCP session sees (render, measure, check, describe_model, query, export…); no version, nothing saved, other agents and people are unaffected; use it to try values or pose a mechanism for a picture. scope "shared": save it in your active configuration (creates one named after you if you\'re on Default) as a new version others can see. Never edits source. Returns the regeneration result.',
    {
      document,
      part: z.string().describe('part id (an instance id means its part; "*" for a shared param)'),
      name: z.string(),
      value: z.union([z.number(), z.string()]).describe('number in the param\'s unit, or an expression like "=width/2" or "1/4 in"'),
      scope: z.enum(["session", "shared"]).optional().describe('"session" (default): private preview, no version. "shared": saved to your active configuration (a version).'),
      configuration: z.string().optional().describe("shared scope: the configuration to save in (becomes your active one)"),
    },
    async ({ document: dd, part, name, value, scope, configuration }) => {
      const documentID = docID(dd);
      part = sourcePart(part);
      if ((scope ?? "session") === "session") {
        const d = await loadDoc(db, s.userID, documentID);
        const prev = previewOf(documentID);
        const before = prev.params[part]?.[name];
        (prev.params[part] ??= {})[name] = typeof value === "number" ? value : String(value);
        const targets = part === "*" ? await partsOf(d) : [part];
        let raw: any[];
        try {
          raw = await engine(d, targets.map((p) => ({ op: "regenerate", part: p })));
        } catch (e) {
          raw = [];
          if (!(e instanceof ToolError)) throw e;
        }
        if (!raw.some((r) => r?.params?.some((p: any) => p.name === name))) {
          if (before === undefined) delete prev.params[part][name];
          else prev.params[part][name] = before;
          if (!Object.keys(prev.params[part]).length) delete prev.params[part];
          const known = raw.flatMap((r) => r?.params?.map((p: any) => p.name) ?? []);
          throw new ToolError(`No param "${name}" on ${part}.${known.length ? ` Params: ${[...new Set(known)].join(", ")}` : " Check the part id (get_params)."}`);
        }
        return text({ scope: "session", note: "Preview for this session only: no version, nobody else sees it. Pass scope \"shared\" to save it.", sessionPreview: prev.params, regeneration: raw.map((r) => summarize(r)) });
      }
      await requireMember(db, s.userID, documentID, "editor");
      let d = await loadDoc(db, s.userID, documentID);
      if (configuration) s.activeConfig.set(documentID, findConfig(d, configuration));
      const configurationID = await ensureConfig(d);
      await mutate(mutators.param.set({ documentID, configurationID, part, name, expression: String(value), value: typeof value === "number" ? value : Number.isFinite(+value) ? +value : String(value), versionID: newID() } as any));
      d = await loadDoc(db, s.userID, documentID);
      const [r] = await regen(d, [part]);
      const v = await latestVersion(documentID);
      if (v) s.lastVersion.set(documentID, v.id);
      await activity(documentID, `set ${part}.${name} = ${value}`);
      // the shared value now applies: drop this session's preview of it
      const prev = s.preview?.get(documentID);
      if (prev?.params[part]) (delete prev.params[part][name], !Object.keys(prev.params[part]).length && delete prev.params[part]);
      return text({ scope: "shared", configuration: d.configurations.find((c) => c.id === configurationID)?.name, regeneration: r });
    },
  );

  tool("reset_param", 'Clear an override. scope "session": drop your preview of it. scope "shared": clear it in your active configuration (a version). Default: your session preview if you have one for this param, else shared.', { document, part: z.string(), name: z.string(), scope: z.enum(["session", "shared"]).optional(), configuration: z.string().optional() }, async ({ document: dd, part, name, scope, configuration }) => {
    const documentID = docID(dd);
    part = sourcePart(part);
    const prev = s.preview?.get(documentID);
    if (scope === "session" || (!scope && prev?.params[part]?.[name] !== undefined)) {
      if (prev?.params[part]?.[name] === undefined) throw new ToolError(`No session preview for ${part}.${name}.`);
      delete prev.params[part][name];
      if (!Object.keys(prev.params[part]).length) delete prev.params[part];
      const d = await loadDoc(db, s.userID, documentID);
      return text({ scope: "session", regeneration: await regen(d, part === "*" ? undefined : [part]) });
    }
    await requireMember(db, s.userID, documentID, "editor");
    let d = await loadDoc(db, s.userID, documentID);
    if (configuration) s.activeConfig.set(documentID, findConfig(d, configuration));
    const configurationID = configOf(d);
    if (!configurationID) throw new ToolError("You're on Default, which has no overrides.");
    await mutate(mutators.param.reset({ documentID, configurationID, part, name, versionID: newID() } as any));
    d = await loadDoc(db, s.userID, documentID);
    const [r] = await regen(d, [part]);
    return text({ regeneration: r });
  });

  tool("list_configurations", "Configurations (named sets of overrides) and this session's active one.", { document }, async ({ document: dd }) => {
    const d = await loadDoc(db, s.userID, docID(dd));
    return text({ active: d.configurations.find((c) => c.id === configOf(d))?.name ?? "Default", configurations: [{ name: "Default", overrides: [] }, ...d.configurations.map((c) => ({ id: c.id, name: c.name, overrides: c.overrides.map((o) => ({ part: o.part, name: o.name, expression: o.expression })) }))] });
  }, { readOnlyHint: true });

  tool("set_configuration", "Switch this session's active configuration (each session and user has its own).", { document, name: z.string() }, async ({ document: dd, name }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    s.activeConfig.set(documentID, findConfig(d, name));
    return text({ active: name });
  });

  // ---------------- assembly poses ----------------
  tool(
    "set_pose",
    'Set assembly joint values (degrees for angles, mm for lengths; 0 is where the parts are modeled; limits clamp) to pose a mechanism. scope "session" (default): a preview only this MCP session sees: render, measure, check, describe_model and export use it; nothing is saved and other agents and people are unaffected. scope "shared": save the resulting positions to the document, where everyone sees them (like dragging in the workspace; no version). Joints you don\'t name keep their current value or settle around the ones you set. reset: true first drops your session values for this assembly (or, shared, the saved positions). scope "shared" without joints saves your current session preview of it. Returns every joint\'s value and where it comes from (session, shared or home). describe_model lists assemblies and joints.',
    {
      document,
      assembly: z.string().describe("assembly id (e.g. mechanism) or name"),
      joints: z.record(z.string(), z.union([z.number(), z.array(z.number())])).optional().describe('joint name -> value, e.g. { lid: 90 } or { base: [10, 0, 45] } for multi-variable joints'),
      scope: z.enum(["session", "shared"]).optional(),
      reset: z.boolean().optional(),
    },
    async ({ document: dd, assembly, joints, scope, reset }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      if (scope === "shared") await requireMember(db, s.userID, documentID, "editor");
      let state = await assemblyState(d);
      const info = findAssembly(state.infos, assembly);
      if (!info) throw new ToolError(`No assembly "${assembly}". Assemblies: ${state.infos.map((a) => `${a.id} (${a.name})`).join(", ") || "none"}`);
      let values: Record<string, number[]>;
      try {
        values = jointValues(info, joints ?? {});
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      const prev = previewOf(documentID);
      const mine = reset ? {} : (prev.poses[info.id] ?? {});
      if (scope === "shared") {
        if (reset) await mutate(mutators.document.setPose({ id: documentID, assembly: info.id, joints: null }));
        // solve from the shared positions (plus any preview kept) with the new values on top, then save the whole pose
        prev.poses[info.id] = { ...mine, ...values };
        state = await assemblyState(await loadDoc(db, s.userID, documentID));
        const solved = state.assemblies.find((a) => a.id === info.id)!;
        if (Object.keys(values).length || !reset) await mutate(mutators.document.setPose({ id: documentID, assembly: info.id, joints: Object.fromEntries(solved.joints.map((j) => [j.name, j.value])) }));
        delete prev.poses[info.id];
      } else {
        prev.poses[info.id] = { ...mine, ...values };
        if (!Object.keys(prev.poses[info.id]).length) delete prev.poses[info.id];
      }
      state = await assemblyState(await loadDoc(db, s.userID, documentID));
      const { poses: _, ...out } = state.assemblies.find((a) => a.id === info.id)!;
      if (scope === "shared") await activity(documentID, `set pose ${info.name}`);
      return text({ scope: scope ?? "session", ...(scope === "shared" ? {} : { note: 'Preview for this session only: nothing saved, nobody else sees it. Pass scope "shared" to save the positions to the document.' }), ...out, render: `render({ parts: ["${info.id}"] })` });
    },
  );

  // ---------------- problems & checks ----------------
  tool(
    "list_problems",
    "Current errors and warnings per part, with the version and author that introduced them. Check at the start of a session and after each write.",
    { document },
    async ({ document: dd }) => {
      const documentID = docID(dd);
      const d = await loadDoc(db, s.userID, documentID);
      const results = await regen(d);
      const versions = await db.sql`SELECT v.id, v.number, v.kind, v.message, v.snapshot, v.created_at, u.name AS user_name, a.client_name FROM versions v LEFT JOIN users u ON u.id = v.author_user_id LEFT JOIN agent_sessions a ON a.id = v.author_agent_id WHERE v.document_id = ${documentID} ORDER BY v.number DESC LIMIT 200`;
      const introduced = (file: string | undefined, kind: string) => {
        // the most recent version that changed this script (or params, for param problems)
        for (let i = 0; i < versions.length; i++) {
          const v = versions[i],
            prev = versions[i + 1];
          const changed = kind === "param" ? v.kind === "params" : !file || !prev || v.snapshot.scripts[file] !== prev.snapshot.scripts[file];
          if (changed) return { version: Number(v.number), id: v.id, message: v.message, author: v.client_name ?? v.user_name ?? "someone", at: new Date(Number(v.created_at)).toISOString() };
        }
        return undefined;
      };
      const problems = results.flatMap((r: any) => r.problems.map((p: any) => ({ part: r.part, ...p, introducedBy: introduced(p.source?.file, p.kind) })));
      return text({ problems, parts: results.map((r: any) => ({ part: r.part, ok: r.ok })) });
    },
    { readOnlyHint: true },
  );

  tool("check", "Validity (BRepCheck) of each part, and interference between parts (as modeled), plus between each assembly's instances where this session poses them.", { document, part: z.string().optional() }, async ({ document: dd, part }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    const parts = part ? [part] : await partsOf(d);
    await regen(d);
    const checks = await engine(d, parts.map((p) => ({ op: "check", part: p })));
    const out: any = { validity: parts.map((p, i) => ({ part: p, valid: !(checks[i] as any[]).length, problems: checks[i] })) };
    const all = await partsOf(d);
    const pairs: any[] = [];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (!part || all[i] === part || all[j] === part) pairs.push([all[i], all[j]]);
    const [, ...vols] = await engine(d, [{ op: "setPoses", poses: {} }, ...pairs.map(([a, b]) => ({ op: "interference", a, b }))]);
    out.interference = pairs.map(([a, b], i) => ({ a, b, volume: round(vols[i] as number, 3) })).filter((x) => x.volume > 1e-6);
    const asm = await assemblyState(d);
    if (asm.infos.length) {
      out.assemblies = [];
      for (const a of asm.infos) {
        const ids = a.instances.map((i) => i.id);
        const ignore = a.joints.filter((j) => j.overlap).map((j) => [j.a, j.b]);
        const [, hits] = await engine(d, [{ op: "setPoses", poses: asm.poses }, { op: "interferences", parts: ids, ignore, poses: asm.poses }]);
        const overlaps = ((hits as any[]) ?? []).filter((h) => !part || [h.a, h.b].some((x) => x === part || sourcePart(x) === part)).map((h) => ({ a: h.a, b: h.b, volume: round(h.volume, 3) }));
        out.assemblies.push({ assembly: a.id, interference: overlaps, problems: asm.assemblies.find((x) => x.id === a.id)?.problems.length ? asm.assemblies.find((x) => x.id === a.id)!.problems : undefined });
      }
    }
    return text(out);
  }, { readOnlyHint: true });

  // ---------------- versions ----------------
  tool("list_versions", "Version history (newest first).", { document, limit: z.number().int().min(1).max(200).optional() }, async ({ document: dd, limit }) => {
    const documentID = docID(dd);
    await requireMember(db, s.userID, documentID);
    const rows = await db.sql`SELECT v.id, v.number, v.kind, v.message, v.note_id, v.created_at, u.name AS user_name, a.client_name, a.label FROM versions v LEFT JOIN users u ON u.id = v.author_user_id LEFT JOIN agent_sessions a ON a.id = v.author_agent_id WHERE v.document_id = ${documentID} ORDER BY v.number DESC LIMIT ${limit ?? 50}`;
    return text({ versions: rows.map((v: any) => ({ id: v.id, number: Number(v.number), kind: v.kind, message: v.message, note: v.note_id ?? undefined, author: v.client_name ? `${v.client_name}${v.label ? ` (${v.label})` : ""}` : v.user_name, at: new Date(Number(v.created_at)).toISOString() })) });
  }, { readOnlyHint: true });

  tool("read_version", "Scripts as they were at a version (optionally one path).", { document, id: z.string(), path: z.string().optional() }, async ({ document: dd, id, path }) => {
    await requireMember(db, s.userID, docID(dd));
    const v = await readVersion(db, id, s.userID, path).catch((e) => {
      throw new ToolError((e as Error).message);
    });
    return text({ version: v.version.number, message: v.version.message, scripts: v.scripts });
  }, { readOnlyHint: true });

  tool("restore_version", "Copy a version to the tip as a new version (nothing is overwritten).", { document, id: z.string(), verbose }, async ({ document: dd, id, verbose }) => {
    const documentID = docID(dd);
    await requireMember(db, s.userID, documentID, "editor");
    const versionID = newID();
    await mutate(mutators.version.restore({ documentID, versionID: id, newVersionID: versionID } as any));
    const paths = (await db.sql`SELECT path FROM scripts WHERE document_id = ${documentID} ORDER BY path`).map((r: any) => r.path as string);
    return text(await afterWrite(documentID, `restore version`, { versionID, paths, verbose }));
  });

  // ---------------- export / import ----------------
  tool("export", "Export a part as STEP, STL or 3MF; returns a signed download URL (valid 1 hour).", { document, part: z.string(), format: z.enum(["step", "stl", "3mf"]) }, async ({ document: dd, part, format }) => {
    const documentID = docID(dd);
    const d = await loadDoc(db, s.userID, documentID);
    const poses = part.includes("/") ? (await assemblyState(d)).poses : {};
    await regen(d, [part]);
    const [, f] = await engine(d, [{ op: "setPoses", poses }, { op: "export", part, format }]);
    const bytes = Buffer.from((f as any).base64, "base64");
    const type = ({ step: "model/step", stl: "model/stl", "3mf": "model/3mf" } as Record<string, string>)[format as string];
    const url = await storeFile(documentID, new Uint8Array(bytes), type);
    return text({ url: downloadURL(url), bytes: bytes.length, format });
  }, { readOnlyHint: true });

  tool("export_document", "The whole document as the plain-file zip format; returns a signed download URL (valid 1 hour). Pass base64: true to get the zip inline instead.", { document, notes: z.boolean().optional(), base64: z.boolean().optional().describe("return the zip inline as base64 instead of a URL") }, async ({ document: dd, notes, base64 }) => {
    const documentID = docID(dd);
    const payload = await exportDocument(db, documentID, s.userID, { notes: notes ?? true });
    const zip = buildDocumentZip(payload);
    const filename = `${payload.manifest.name}.zip`;
    if (base64) return text({ filename, base64: Buffer.from(zip).toString("base64") });
    const url = await storeFile(documentID, zip, "application/zip");
    return text({ filename, url: downloadURL(url), bytes: zip.length });
  }, { readOnlyHint: true });

  tool("import_document", "Create a document from a plain-file zip (base64).", { zip: z.string().describe("base64 zip"), name: z.string().optional() }, async ({ zip, name }) => {
    const payload = parseDocumentZip(new Uint8Array(Buffer.from(zip, "base64")));
    const { documentID } = await importDocument(db, payload, ctx(), { name });
    s.defaultDocument ??= documentID;
    return text({ id: documentID, name: name ?? payload.manifest.name, url: documentURL(documentID) });
  });
}
