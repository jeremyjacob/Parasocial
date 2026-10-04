/**
 * Custom mutators, shared by the browser client (optimistic), the app server
 * (authoritative, via the Zero push endpoint) and MCP (server-side, via
 * `runMutator` in server/mutate.ts).
 *
 * Rules of the road:
 *  - Every id a row gets is passed in `args` (or derived deterministically), so
 *    the optimistic row and the authoritative row match.
 *  - Authorization and anything that needs server-only tables (blobs,
 *    script_contents) happen only when `tx.location === "server"`. The client
 *    has a partial view of the data, so client-side checks only reject what
 *    they can *prove* is wrong (bad path, stale baseVersion seen locally, a
 *    claim held by someone else). A client-side throw aborts the mutation
 *    before it is ever pushed.
 *  - On the server, document-scoped writes take a row lock on the document
 *    first (`SELECT … FOR UPDATE`) so version numbers are allocated serially.
 *  - Errors meant for callers are `ApplicationError`s with
 *    `details: { code, ... }` (see `MutationErrorCode`).
 */
import {
  ApplicationError,
  type JSONObject,
  defineMutator,
  defineMutators,
  type ServerTransaction,
  type Transaction,
} from "@rocicorp/zero";
import { z } from "zod";
import { zql, type Configuration, type Script } from "./schema.ts";
import type {
  ChangeEntry,
  MutatorContext,
  NoteAnchor,
  NoteStatus,
  ParamValue,
  Role,
  SnapshotConfiguration,
  VersionChanges,
  VersionKind,
  VersionSnapshot,
} from "./types.ts";
import { newID, sha256Hex, SHA256_RE, SHARE_TOKEN_RE, validateScriptPath } from "./util.ts";

type Tx = Transaction;
type Ctx = MutatorContext | undefined;

/** A burst of param/config changes by the same author within this window becomes one version. */
export const PARAMS_COALESCE_MS = 10_000;

export type MutationErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "invalid_path"
  | "stale"
  | "exists"
  | "edit_failed"
  | "claimed"
  | "not_claimed"
  | "blob_missing";

export function fail(code: MutationErrorCode, message: string, details: Record<string, unknown> = {}): never {
  throw new ApplicationError(message, { details: { code, ...details } as never });
}

// ───────────────────────────── helpers ─────────────────────────────

const isServer = (tx: Tx): tx is ServerTransaction => tx.location === "server";

async function pg(tx: Tx, text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (!isServer(tx)) throw new Error("pg() is server-only");
  return [...(await tx.dbTransaction.query(text, params))] as Record<string, unknown>[];
}

/** Postgres channel for note activity agents may need to act on (see NoteEvent). */
export const NOTE_EVENTS_CHANNEL = "parasocial_note_events";
/**
 * Payload on NOTE_EVENTS_CHANNEL: a note was created, a human replied on one, a note was handed to
 * the built-in agent, or a document's auto hand-off was switched on (no note).
 */
export type NoteEvent = { documentID: string; noteID: string | null; kind: "created" | "reply" | "assigned" | "auto-handoff" };

/** Wakes MCP sessions waiting on the document. Delivered on commit, so rolled-back mutations never announce. */
async function notifyNote(tx: Tx, event: NoteEvent) {
  if (isServer(tx)) await pg(tx, "SELECT pg_notify($1, $2)", [NOTE_EVENTS_CHANNEL, JSON.stringify(event)]);
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

function requireUser(ctx: Ctx): MutatorContext {
  if (!ctx?.userID) fail("unauthenticated", "Sign in first");
  return ctx;
}

/**
 * Server: checks membership (and that an agent session, if any, belongs to the
 * user) and locks the document row. Client: no-op beyond requiring a user.
 */
async function authorize(tx: Tx, ctx: Ctx, documentID: string, min: Role): Promise<MutatorContext> {
  const c = requireUser(ctx);
  if (!isServer(tx)) return c;
  const locked = await pg(tx, "SELECT id FROM documents WHERE id = $1 FOR UPDATE", [documentID]);
  if (locked.length === 0) fail("not_found", "Document not found", { documentID });
  const m = await tx.run(zql.documentMembers.where("documentID", documentID).where("userID", c.userID).one());
  if (!m) fail("forbidden", "You are not a member of this document", { documentID });
  if (ROLE_RANK[m.role] < ROLE_RANK[min]) fail("forbidden", `This needs the ${min} role`, { documentID, role: m.role });
  if (c.agentSessionID) {
    const s = await tx.run(zql.agentSessions.where("id", c.agentSessionID).one());
    if (!s || s.userID !== c.userID) fail("forbidden", "Unknown agent session");
  }
  return c;
}

const author = (c: MutatorContext) => ({
  userID: c.userID,
  agentID: c.agentSessionID ?? null,
});

/** Loads a row. Server: fails if missing. Client: returns undefined (caller skips the optimistic write). */
async function need<T>(tx: Tx, row: T | undefined, what: string, details: Record<string, unknown> = {}): Promise<T | undefined> {
  if (row === undefined && isServer(tx)) fail("not_found", `${what} not found`, details);
  return row;
}

/**
 * Script edits (edit_script). Search/replace: each `search` must match exactly once unless `all` is
 * set. Line ranges: `lines: [first, last]` (1-based, inclusive) replaced by `replace`'s lines ("" deletes
 * them; [n, n - 1] inserts before line n), numbered as in the content the edits apply to (the
 * caller's baseVersion), so they go first, bottom-up, and must not overlap.
 */
export type ScriptEdit = { search: string; replace: string; all?: boolean | undefined } | { lines: readonly number[]; replace: string };
export const scriptEditSchema = z.union([
  z.object({ search: z.string(), replace: z.string(), all: z.boolean().optional() }),
  z.object({ lines: z.array(z.number().int()).length(2), replace: z.string() }),
]);
export function applyEdits(
  content: string,
  edits: readonly ScriptEdit[],
): { ok: true; content: string } | { ok: false; index: number; reason: string } {
  let out = content;
  const ranges = edits.flatMap((e, index) => ("lines" in e ? [{ first: e.lines[0]!, last: e.lines[1]!, replace: e.replace, index }] : []));
  if (ranges.length) {
    const lines = content.split("\n");
    const n = lines.length;
    let above = Infinity; // first line of the range below this one (ranges go bottom-up)
    for (const r of ranges.sort((a, b) => b.first - a.first || b.last - a.last)) {
      if (r.first < 1 || r.first > n + 1 || r.last < r.first - 1 || r.last > n) return { ok: false, index: r.index, reason: `lines [${r.first}, ${r.last}] are outside the file (lines 1–${n}; [k, k - 1] inserts before line k)` };
      if (r.last >= above) return { ok: false, index: r.index, reason: "line ranges overlap" };
      lines.splice(r.first - 1, r.last - r.first + 1, ...(r.replace === "" ? [] : r.replace.replace(/\n$/, "").split("\n")));
      above = r.first;
    }
    out = lines.join("\n");
  }
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    if ("lines" in e) continue;
    const { search, replace, all } = e;
    if (search.length === 0) return { ok: false, index: i, reason: "search text is empty" };
    const first = out.indexOf(search);
    if (first === -1) return { ok: false, index: i, reason: "search text not found" };
    if (all) {
      out = out.split(search).join(replace);
    } else {
      if (out.indexOf(search, first + 1) !== -1)
        return { ok: false, index: i, reason: "search text matches more than once; add surrounding context or set all: true" };
      out = out.slice(0, first) + replace + out.slice(first + search.length);
    }
  }
  return { ok: true, content: out };
}

export const scriptID = (documentID: string, path: string) => `${documentID}:${path}`;

async function snapshotOf(tx: Tx, documentID: string): Promise<VersionSnapshot> {
  const scripts = await tx.run(zql.scripts.where("documentID", documentID));
  const configs = await tx.run(
    zql.configurations.where("documentID", documentID).related("overrides").orderBy("createdAt", "asc"),
  );
  const s: Record<string, string> = {};
  for (const r of [...scripts].sort((a, b) => a.path.localeCompare(b.path))) s[r.path] = r.contentHash;
  return {
    scripts: s,
    params: {
      configurations: configs.map((c) => ({
        id: c.id,
        name: c.name,
        overrides: [...c.overrides]
          .sort((a, b) => (a.part + a.name).localeCompare(b.part + b.name))
          .map((o) => ({ part: o.part, name: o.name, expression: o.expression, value: o.value as ParamValue })),
      })),
    },
  };
}

async function storeContent(tx: Tx, hash: string, content: string) {
  if (!isServer(tx)) return;
  await pg(tx, "INSERT INTO script_contents (hash, content) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING", [hash, content]);
}

/** Allocates the next version number and inserts the version row. */
async function createVersion(
  tx: Tx,
  c: MutatorContext,
  v: {
    id: string;
    documentID: string;
    kind: VersionKind;
    message: string;
    noteID?: string | null | undefined;
    restoredFrom?: string | null;
    changes?: VersionChanges | null;
  },
): Promise<number | undefined> {
  const doc = await need(tx, await tx.run(zql.documents.where("id", v.documentID).one()), "Document");
  if (!doc) return undefined;
  const number = doc.headVersion + 1;
  const now = Date.now();
  await tx.mutate.documents.update({ id: v.documentID, headVersion: number, updatedAt: now });
  const a = author(c);
  await tx.mutate.versions.insert({
    id: v.id,
    documentID: v.documentID,
    number,
    kind: v.kind,
    authorUserID: a.userID,
    authorAgentID: a.agentID,
    message: v.message,
    noteID: v.noteID ?? null,
    restoredFrom: v.restoredFrom ?? null,
    snapshot: await snapshotOf(tx, v.documentID),
    changes: v.changes ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return number;
}

function renderChange(e: ChangeEntry): string {
  if (e.kind === "config") {
    if (e.from === "") return `+${e.to}`;
    if (e.to === "") return `−${e.from}`;
    return `${e.from} → ${e.to}`;
  }
  return `${e.label} ${e.from} → ${e.to}`;
}

export function paramsMessage(changes: VersionChanges): string {
  const parts = Object.values(changes.params)
    .filter((e) => e.from !== e.to)
    .map(renderChange);
  return parts.length ? `Params: ${parts.join(", ")}` : "Params: no net change";
}

/**
 * Records param/configuration changes. Consecutive changes by the same author
 * within PARAMS_COALESCE_MS, with nothing else committed in between (the params
 * version is still the tip), are folded into one version: the first "from" is
 * kept and "to" is updated, e.g. "Params: thickness 3 → 5".
 */
async function recordParamsChange(
  tx: Tx,
  c: MutatorContext,
  documentID: string,
  entries: Record<string, ChangeEntry>,
  versionID: string | undefined,
) {
  const doc = await tx.run(zql.documents.where("id", documentID).one());
  if (!doc) return;
  const now = Date.now();
  const a = author(c);
  const tip = doc.headVersion
    ? await tx.run(zql.versions.where("documentID", documentID).where("number", doc.headVersion).one())
    : undefined;
  if (
    tip &&
    tip.kind === "params" &&
    tip.authorUserID === a.userID &&
    (tip.authorAgentID ?? null) === a.agentID &&
    now - tip.updatedAt < PARAMS_COALESCE_MS
  ) {
    const merged: VersionChanges = { params: { ...(tip.changes?.params ?? {}) } };
    for (const [k, e] of Object.entries(entries)) {
      const prev = merged.params[k];
      merged.params[k] = prev ? { ...e, from: prev.from } : e;
    }
    await tx.mutate.versions.update({
      id: tip.id,
      changes: merged,
      message: paramsMessage(merged),
      snapshot: await snapshotOf(tx, documentID),
      updatedAt: now,
    });
    await tx.mutate.documents.update({ id: documentID, updatedAt: now });
    return;
  }
  const changes: VersionChanges = { params: entries };
  await createVersion(tx, c, {
    id: versionID ?? newID(),
    documentID,
    kind: "params",
    message: paramsMessage(changes),
    changes,
  });
}

// ───────────────────────────── arg schemas ─────────────────────────────

const id = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(200);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const paramValue = z.union([z.number(), z.string(), z.boolean()]);
const paramKey = z.object({ part: z.string().min(1), name: z.string().min(1) });
const overrideInput = paramKey.extend({
  expression: z.string().min(1).max(500),
  value: paramValue,
  codeDefault: z.string().optional(), // the code default at the time (version message; "code default changed" hint)
  rebase: z.boolean().optional(), // "keep": accept the new code default under this override
});
const snapshotOverride = paramKey.extend({ expression: z.string(), value: paramValue });

const anchorSchema = z.object({
  targets: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.enum(["face", "edge", "vertex", "part", "point"]),
          name: z.string(),
          query: z.string().optional(),
          part: z.string().optional(),
          point: vec3,
          normal: vec3.optional(),
        }),
        z.object({
          kind: z.literal("studio"),
          studio: z.string().refine((path) => path.startsWith("studios/") && validateScriptPath(path) === null, "Invalid studio script path"),
          name: z.string(),
          point: vec3,
        }),
      ]),
    )
    .min(1),
  camera: z.object({ position: vec3, target: vec3, up: vec3, fov: z.number(), ortho: z.boolean() }),
  version: z.string(),
  configuration: z.string(),
  sectionPlane: z.object({ origin: vec3, normal: vec3, xDir: vec3.optional() }).optional(),
  markup: z.array(z.any()).optional(),
  snapshot: z.string(),
});

const strokeInput = z.object({
  id,
  part: z.string().min(1),
  points: z.array(vec3).min(1).max(10_000),
  color: z.string().min(1).max(32),
  width: z.number().positive().max(50).optional(),
});

/** Images pasted into a message: uploaded blobs (upload first, then reference), kept in `data.images`. */
export const MAX_NOTE_IMAGES = 8;
const images = z.array(z.string().regex(SHA256_RE, "must be a sha256 blob hash")).max(MAX_NOTE_IMAGES).default([]);

/** Server: every image blob must exist; each reference bumps its refcount (the sweep recomputes it anyway). */
async function referenceImages(tx: Tx, hashes: readonly string[]) {
  if (!isServer(tx) || !hashes.length) return;
  for (const hash of new Set(hashes)) {
    const rows = await pg(tx, "UPDATE blobs SET refcount = refcount + 1 WHERE hash = $1 AND content_type LIKE 'image/%' RETURNING hash", [hash]);
    if (rows.length === 0) fail("blob_missing", "Upload the image before posting it", { hash });
  }
}

const scriptFile = z.object({ path: z.string(), content: z.string().max(1_000_000) });

// ───────────────────────────── implementations ─────────────────────────────

/** One file in a script write: full `content`, `edits` against the current content, or `content: null` to delete. */
export type ScriptChange = {
  path: string;
  content: string | null; // null = delete
  baseVersion: number | null;
  edits?: readonly ScriptEdit[] | undefined;
};

/** Server: a script's content as of document version `number` (from that version's snapshot), if known. */
async function contentAtVersion(tx: Tx, documentID: string, number: number, path: string): Promise<string | undefined> {
  if (!isServer(tx)) return undefined;
  const rows = await pg(
    tx,
    "SELECT c.content FROM versions v JOIN script_contents c ON c.hash = v.snapshot->'scripts'->>$3::text WHERE v.document_id = $1 AND v.number = $2",
    [documentID, number, path],
  );
  return rows[0]?.content as string | undefined;
}

function scriptsMessage(changes: readonly { path: string; verb: string }[]): string {
  if (changes.length === 1) return `${changes[0]!.verb} ${changes[0]!.path}`;
  const verb = new Set(changes.map((x) => x.verb)).size === 1 ? changes[0]!.verb : "Edit";
  const names = changes.slice(0, 3).map((x) => x.path);
  return `${verb} ${names.join(", ")}${changes.length > 3 ? ` and ${changes.length - 3} more` : ""}`;
}

/**
 * Script writes (write, edit, delete, writeMany). Every change in one call lands in one
 * transaction as one version, or none does.
 *
 * Concurrency is a strict compare-and-swap: on the server each change claims its row with
 * `UPDATE … WHERE id = $id AND version = $baseVersion` (`INSERT … ON CONFLICT DO NOTHING` for
 * creates, `DELETE … WHERE version = $baseVersion` for deletes) and fails stale when no row
 * matched, so two writers holding the same baseVersion can never both succeed, whatever the
 * isolation level or locking around it.
 *
 * Retries are safe: a change whose result is already the current content (a full write of the
 * same text, an edit whose effect is already there, a delete of a missing file) is skipped
 * whatever its baseVersion, and a `versionID` that already committed returns without writing.
 */
async function writeScriptsImpl(
  tx: Tx,
  ctx: Ctx,
  a: {
    documentID: string;
    files: readonly ScriptChange[];
    message?: string | undefined;
    noteID?: string | undefined;
    versionID?: string | undefined;
  },
) {
  const seen = new Set<string>();
  for (const f of a.files) {
    const pathError = validateScriptPath(f.path);
    if (pathError) fail("invalid_path", pathError, { path: f.path });
    if (seen.has(f.path)) fail("invalid", `${f.path} appears more than once`, { path: f.path });
    seen.add(f.path);
  }
  const c = await authorize(tx, ctx, a.documentID, "editor");

  // Idempotent retry: this exact write (same version id) already committed.
  if (a.versionID) {
    const done = await tx.run(zql.versions.where("id", a.versionID).one());
    if (done) {
      if (done.documentID !== a.documentID) fail("invalid", "versionID belongs to another document");
      return;
    }
  }

  type Planned = { path: string; current: Script | undefined; content: string | null; verb: string };
  const planned: Planned[] = [];
  for (const f of a.files) {
    const current = await tx.run(zql.scripts.where("documentID", a.documentID).where("path", f.path).one());
    const staleDetails = (s: Script | undefined) => ({
      path: f.path,
      baseVersion: f.baseVersion,
      current: s ? { content: s.content, version: s.version, contentHash: s.contentHash } : null,
    });

    // Already in the wanted state (e.g. a retry of a write that committed): nothing to do, whatever the base.
    if (!f.edits) {
      const done = f.content === null ? !current && f.baseVersion !== null && isServer(tx) : current?.content === f.content;
      if (done) continue;
    }

    // Optimistic concurrency. baseVersion null means "this script must not exist yet".
    if (f.baseVersion === null) {
      if (current) fail("exists", `${f.path} already exists (version ${current.version}); pass its version as baseVersion`, staleDetails(current));
      if (f.content === null || f.edits) fail("not_found", `${f.path} does not exist`, staleDetails(current));
    } else if (!current) {
      // Client may simply not have it synced; only the server can prove it's gone.
      if (isServer(tx)) fail("stale", `${f.path} no longer exists`, staleDetails(undefined));
      return;
    } else if (current.version !== f.baseVersion) {
      // A retried edit whose effect is already there (it committed before the caller saw the result).
      if (f.edits) {
        const base = await contentAtVersion(tx, a.documentID, f.baseVersion, f.path);
        const replay = base === undefined ? undefined : applyEdits(base, f.edits);
        if (replay?.ok && replay.content === current.content) continue;
      }
      // Search/replace edits don't depend on line numbers: when each still matches, they apply on top
      // of the newer content (a rebase). Line edits and full writes can't tell, so they're stale.
      const rebases = f.edits && !f.edits.some((e) => "lines" in e) && applyEdits(current.content, f.edits).ok;
      if (!rebases) fail("stale", `${f.path} changed since version ${f.baseVersion} (now ${current.version}); re-read and retry`, staleDetails(current));
    }

    let content = f.content;
    if (f.edits && current) {
      const r = applyEdits(current.content, f.edits);
      if (!r.ok) fail("edit_failed", `Edit ${r.index + 1} failed${a.files.length > 1 ? ` on ${f.path}` : ""}: ${r.reason}`, { ...staleDetails(current), index: r.index });
      content = r.content;
    }
    if (content !== null && current && content === current.content) continue; // no-op
    planned.push({ path: f.path, current, content, verb: content === null ? "Delete" : current ? "Edit" : "Create" });
  }
  if (planned.length === 0) return; // nothing changed: no version

  const versionID = a.versionID ?? newID();
  const doc = await tx.run(zql.documents.where("id", a.documentID).one());
  if (!doc) return;
  const number = doc.headVersion + 1;
  const now = Date.now();
  const who = author(c);

  for (const p of planned) {
    const id = p.current?.id ?? scriptID(a.documentID, p.path);
    if (isServer(tx)) {
      // Claim the row with a conditional write; zero rows means a concurrent writer got there first.
      const claimed = !p.current
        ? await pg(tx, "INSERT INTO scripts (id, document_id, path, content, content_hash, version) VALUES ($1, $2, $3, '', '', $4) ON CONFLICT DO NOTHING RETURNING id", [id, a.documentID, p.path, number])
        : p.content === null
          ? await pg(tx, "DELETE FROM scripts WHERE id = $1 AND version = $2 RETURNING id", [id, p.current.version])
          : await pg(tx, "UPDATE scripts SET version = $3 WHERE id = $1 AND version = $2 RETURNING id", [id, p.current.version, number]);
      if (claimed.length === 0) {
        const [row] = await pg(tx, "SELECT content, version, content_hash FROM scripts WHERE document_id = $1 AND path = $2", [a.documentID, p.path]);
        fail(p.current ? "stale" : "exists", `${p.path} was changed by a concurrent write; re-read and retry`, {
          path: p.path,
          baseVersion: p.current?.version ?? null,
          current: row ? { content: row.content as string, version: Number(row.version), contentHash: row.content_hash as string } : null,
        });
      }
      if (p.content === null) continue; // the conditional DELETE already removed it
    }

    if (p.content === null) {
      await tx.mutate.scripts.delete({ id });
      continue;
    }
    const hash = await sha256Hex(p.content);
    await storeContent(tx, hash, p.content);
    await tx.mutate.scripts.upsert({
      id,
      documentID: a.documentID,
      path: p.path,
      content: p.content,
      contentHash: hash,
      version: number,
      updatedAt: now,
      updatedByUser: who.userID,
      updatedByAgent: who.agentID,
    });
  }
  await createVersion(tx, c, {
    id: versionID,
    documentID: a.documentID,
    kind: "script",
    message: a.message?.trim() || scriptsMessage(planned),
    noteID: a.noteID,
  });
}

async function writeScriptImpl(
  tx: Tx,
  ctx: Ctx,
  a: ScriptChange & { documentID: string; message?: string | undefined; noteID?: string | undefined; versionID?: string | undefined },
) {
  const { documentID, message, noteID, versionID, ...file } = a;
  await writeScriptsImpl(tx, ctx, { documentID, message, noteID, versionID, files: [file] });
}

type OverrideInput = z.infer<typeof overrideInput>;
type ParamKey = z.infer<typeof paramKey>;

async function applyParamsImpl(
  tx: Tx,
  ctx: Ctx,
  a: {
    documentID: string;
    configurationID: string;
    set: readonly OverrideInput[];
    reset: readonly (ParamKey & { codeDefault?: string | undefined })[];
    versionID?: string | undefined;
  },
) {
  const c = await authorize(tx, ctx, a.documentID, "editor");
  const config = await need(tx, await tx.run(zql.configurations.where("id", a.configurationID).one()), "Configuration", {
    configurationID: a.configurationID,
  });
  if (!config) return;
  if (config.documentID !== a.documentID) fail("invalid", "Configuration belongs to another document");
  const existing = await tx.run(zql.paramOverrides.where("configurationID", a.configurationID));
  const byKey = new Map(existing.map((o) => [`${o.part}\u0000${o.name}`, o]));
  const entries: Record<string, ChangeEntry> = {};
  const now = Date.now();
  const label = (k: ParamKey) => k.name;
  const key = (k: ParamKey) => `param:${a.configurationID}:${k.part}:${k.name}`;

  for (const s of a.set) {
    const prev = byKey.get(`${s.part}\u0000${s.name}`);
    await tx.mutate.paramOverrides.upsert({
      id: prev?.id ?? `${a.configurationID}:${s.part}:${s.name}`,
      documentID: a.documentID,
      configurationID: a.configurationID,
      part: s.part,
      name: s.name,
      expression: s.expression,
      value: s.value,
      // keep the default the override was first made against; an explicit "keep" re-bases it
      codeDefault: (s as { rebase?: boolean }).rebase ? (s.codeDefault ?? null) : (prev?.codeDefault ?? s.codeDefault ?? null),
      updatedAt: now,
    });
    entries[key(s)] = { kind: "param", label: label(s), from: prev?.expression ?? s.codeDefault ?? "default", to: s.expression };
  }
  for (const r of a.reset) {
    const prev = byKey.get(`${r.part}\u0000${r.name}`);
    if (!prev) continue;
    await tx.mutate.paramOverrides.delete({ id: prev.id });
    entries[key(r)] = { kind: "param", label: label(r), from: prev.expression, to: r.codeDefault ?? "default" };
  }
  if (Object.keys(entries).length === 0) return;
  await recordParamsChange(tx, c, a.documentID, entries, a.versionID);
}

async function createConfigurationImpl(
  tx: Tx,
  ctx: Ctx,
  a: { id: string; documentID: string; name: string; overrides: readonly z.infer<typeof snapshotOverride>[]; versionID?: string | undefined },
) {
  if (a.name === "Default") fail("invalid", '"Default" is reserved: it is the configuration with no overrides');
  const c = await authorize(tx, ctx, a.documentID, "editor");
  const clash = await tx.run(zql.configurations.where("documentID", a.documentID).where("name", a.name).one());
  if (clash) fail("exists", `A configuration named "${a.name}" already exists`);
  const now = Date.now();
  await tx.mutate.configurations.insert({ id: a.id, documentID: a.documentID, name: a.name, createdAt: now });
  for (const o of a.overrides) {
    await tx.mutate.paramOverrides.insert({
      id: `${a.id}:${o.part}:${o.name}`,
      documentID: a.documentID,
      configurationID: a.id,
      part: o.part,
      name: o.name,
      expression: o.expression,
      value: o.value,
      updatedAt: now,
    });
  }
  await recordParamsChange(tx, c, a.documentID, { [`config:${a.id}`]: { kind: "config", label: "configuration", from: "", to: a.name } }, a.versionID);
}

/** Replaces scripts + param state of a document with a snapshot (restore_version). */
async function applySnapshot(tx: Tx, c: MutatorContext, documentID: string, snap: VersionSnapshot, number: number) {
  const now = Date.now();
  const who = author(c);
  const current = await tx.run(zql.scripts.where("documentID", documentID));
  const currentByPath = new Map(current.map((s) => [s.path, s]));
  for (const s of current) if (!(s.path in snap.scripts)) await tx.mutate.scripts.delete({ id: s.id });

  const wanted = Object.entries(snap.scripts).filter(([p, h]) => currentByPath.get(p)?.contentHash !== h);
  if (wanted.length) {
    let contents = new Map<string, string>();
    if (isServer(tx)) {
      const rows = await pg(tx, "SELECT hash, content FROM script_contents WHERE hash = ANY($1)", [wanted.map(([, h]) => h)]);
      contents = new Map(rows.map((r) => [r.hash as string, r.content as string]));
    }
    for (const [path, hash] of wanted) {
      const content = contents.get(hash);
      if (content === undefined) {
        if (isServer(tx)) fail("not_found", `Contents for ${path} (${hash.slice(0, 12)}) are missing`);
        continue; // client doesn't have version contents; server fills in
      }
      await tx.mutate.scripts.upsert({
        id: currentByPath.get(path)?.id ?? scriptID(documentID, path),
        documentID,
        path,
        content,
        contentHash: hash,
        version: number,
        updatedAt: now,
        updatedByUser: who.userID,
        updatedByAgent: who.agentID,
      });
    }
  }

  // Param state: configurations and overrides exactly as in the snapshot.
  const configs = await tx.run(zql.configurations.where("documentID", documentID));
  const wantConfigs = new Map(snap.params.configurations.map((cfg) => [cfg.id, cfg]));
  for (const cfg of configs) if (!wantConfigs.has(cfg.id)) await tx.mutate.configurations.delete({ id: cfg.id });
  const overrides = await tx.run(zql.paramOverrides.where("documentID", documentID));
  for (const o of overrides) await tx.mutate.paramOverrides.delete({ id: o.id });
  const byID = new Map(configs.map((cfg) => [cfg.id, cfg]));
  for (const cfg of snap.params.configurations) {
    const have = byID.get(cfg.id);
    if (!have) await tx.mutate.configurations.insert({ id: cfg.id, documentID, name: cfg.name, createdAt: now });
    else if (have.name !== cfg.name) await tx.mutate.configurations.update({ id: cfg.id, name: cfg.name });
    for (const o of cfg.overrides) {
      await tx.mutate.paramOverrides.insert({
        id: `${cfg.id}:${o.part}:${o.name}`,
        documentID,
        configurationID: cfg.id,
        part: o.part,
        name: o.name,
        expression: o.expression,
        value: o.value,
        updatedAt: now,
      });
    }
  }
}

async function loadNote(tx: Tx, ctx: Ctx, noteID: string, min: Role = "viewer") {
  const note = await need(tx, await tx.run(zql.notes.where("id", noteID).one()), "Note", { noteID });
  if (!note) return undefined;
  const c = await authorize(tx, ctx, note.documentID, min);
  return { note, c };
}

async function holderName(tx: Tx, sessionID: string) {
  const s = await tx.run(zql.agentSessions.where("id", sessionID).one());
  return { id: sessionID, name: s ? (s.label ? `${s.clientName} (${s.label})` : s.clientName) : "another agent session" };
}

async function setAgentStatus(tx: Tx, sessionID: string | null | undefined, status: "idle" | "working" | "writing", detail: JSONObject | null) {
  if (!sessionID) return;
  const s = await tx.run(zql.agentSessions.where("id", sessionID).one());
  if (!s) return;
  await tx.mutate.agentSessions.update({ id: sessionID, status, detail, lastSeenAt: Date.now() });
}

/** New documents start with agent pickup on, run as their creator (see setAgentAutoHandoff). */
function defaultAgent(c: MutatorContext) {
  return c.agentSessionID ? { autoHandoff: false } : { autoHandoff: true, runAs: c.userID };
}

// ───────────────────────────── the registry ─────────────────────────────

export const mutators = defineMutators({
  document: {
    create: defineMutator(
      z.object({ id, name, units: z.string().max(16).optional() }),
      async ({ tx, ctx, args }) => {
        const c = requireUser(ctx);
        const now = Date.now();
        await tx.mutate.documents.insert({
          id: args.id,
          name: args.name,
          ownerID: c.userID,
          units: args.units ?? "mm",
          settings: { agent: defaultAgent(c) },
          headVersion: 0,
          createdAt: now,
          updatedAt: now,
        });
        await tx.mutate.documentMembers.insert({ documentID: args.id, userID: c.userID, role: "owner", createdAt: now });
      },
    ),

    rename: defineMutator(z.object({ id, name }), async ({ tx, ctx, args }) => {
      await authorize(tx, ctx, args.id, "editor");
      const doc = await need(tx, await tx.run(zql.documents.where("id", args.id).one()), "Document");
      if (!doc) return;
      await tx.mutate.documents.update({ id: args.id, name: args.name, updatedAt: Date.now() });
    }),

    updateSettings: defineMutator(
      z.object({ id, units: z.string().max(16).optional(), settings: z.record(z.string(), z.any()).optional() }),
      async ({ tx, ctx, args }) => {
        await authorize(tx, ctx, args.id, "editor");
        const doc = await need(tx, await tx.run(zql.documents.where("id", args.id).one()), "Document");
        if (!doc) return;
        // settings.agent names whose provider pays for the built-in agent: only setAgentAutoHandoff writes it
        const { agent: _agent, ...settings } = args.settings ?? {};
        await tx.mutate.documents.update({
          id: args.id,
          ...(args.units ? { units: args.units } : {}),
          ...(args.settings ? { settings: { ...doc.settings, ...settings } } : {}),
          updatedAt: Date.now(),
        });
      },
    ),

    /**
     * Auto hand-off: open notes go to the built-in agent without anyone handing them over. It runs
     * as (and on the provider of) whoever switched it on, recorded server-side as settings.agent.runAs.
     */
    setAgentAutoHandoff: defineMutator(z.object({ id, enabled: z.boolean() }), async ({ tx, ctx, args }) => {
      const c = await authorize(tx, ctx, args.id, "editor");
      if (c.agentSessionID) fail("forbidden", "Only people can change agent hand-off");
      const doc = await need(tx, await tx.run(zql.documents.where("id", args.id).one()), "Document");
      if (!doc) return;
      const agent = args.enabled ? { autoHandoff: true, runAs: c.userID } : { autoHandoff: false };
      await tx.mutate.documents.update({ id: args.id, settings: { ...doc.settings, agent }, updatedAt: Date.now() });
      if (args.enabled) await notifyNote(tx, { documentID: args.id, noteID: null, kind: "auto-handoff" });
    }),

    /**
     * Where an assembly's joints were dragged to (`settings.poses[assembly][joint] = values`), or
     * null to clear. Shared by everyone in the document; not a version (it moves parts, not geometry).
     */
    setPose: defineMutator(
      z.object({
        id,
        assembly: z.string().min(1).max(200),
        joints: z.record(z.string().min(1).max(200), z.array(z.number().finite()).max(6)).nullable(),
      }),
      async ({ tx, ctx, args }) => {
        await authorize(tx, ctx, args.id, "editor");
        const doc = await need(tx, await tx.run(zql.documents.where("id", args.id).one()), "Document");
        if (!doc) return;
        const settings = (doc.settings ?? {}) as Record<string, any>;
        const poses: Record<string, unknown> = { ...(settings.poses ?? {}) };
        if (args.joints) poses[args.assembly] = args.joints;
        else delete poses[args.assembly];
        await tx.mutate.documents.update({ id: args.id, settings: { ...settings, poses } as any });
      },
    ),

    /**
     * Records the documents-list thumbnail (blobs uploaded first). Not an edit: updatedAt stays,
     * no version. Any member who can see the geometry may refresh it; an older render never
     * replaces a newer one.
     */
    setThumbnail: defineMutator(
      z.object({ id, light: z.string().regex(SHA256_RE), dark: z.string().regex(SHA256_RE), version: z.number().int().min(0) }),
      async ({ tx, ctx, args }) => {
        await authorize(tx, ctx, args.id, "viewer");
        const doc = await tx.run(zql.documents.where("id", args.id).one());
        if (!doc || (doc.thumbVersion ?? -1) > args.version) return;
        if (isServer(tx)) {
          const rows = await pg(tx, "SELECT hash FROM blobs WHERE hash = ANY($1)", [[args.light, args.dark]]);
          if (rows.length < new Set([args.light, args.dark]).size) fail("blob_missing", "Upload the thumbnail before referencing it");
        }
        await tx.mutate.documents.update({ id: args.id, thumbLight: args.light, thumbDark: args.dark, thumbVersion: args.version });
      },
    ),

    /**
     * Turns the view-only link on (a fresh token, made by the caller like any id), or off (null).
     * A new token revokes the previous link. Not an edit: no version, updatedAt stays.
     */
    setShareToken: defineMutator(
      z.object({ id, token: z.string().regex(SHARE_TOKEN_RE).nullable() }),
      async ({ tx, ctx, args }) => {
        const c = await authorize(tx, ctx, args.id, "editor");
        if (c.agentSessionID) fail("forbidden", "Only people can change link sharing");
        const doc = await need(tx, await tx.run(zql.documents.where("id", args.id).one()), "Document");
        if (!doc) return;
        await tx.mutate.documents.update({ id: args.id, shareToken: args.token });
      },
    ),

    delete: defineMutator(z.object({ id }), async ({ tx, ctx, args }) => {
      await authorize(tx, ctx, args.id, "owner");
      if (isServer(tx)) {
        // ON DELETE CASCADE removes everything document-scoped; blob refcounts are fixed by the sweep.
        await pg(tx, "DELETE FROM documents WHERE id = $1", [args.id]);
        return;
      }
      const doc = await tx.run(zql.documents.where("id", args.id).one());
      if (doc) await tx.mutate.documents.delete({ id: args.id });
    }),

    /** Creates a document from the plain-file format (server/zip.ts). One "import" version. */
    import: defineMutator(
      z.object({
        id,
        name,
        units: z.string().max(16).optional(),
        settings: z.record(z.string(), z.any()).optional(),
        scripts: z.array(scriptFile).max(1000),
        configurations: z.array(z.object({ id: id.optional(), name, overrides: z.array(snapshotOverride) })).default([]),
        notes: z
          .array(
            z.object({
              id: id.optional(),
              anchor: anchorSchema.extend({ snapshot: z.string().optional() }),
              // AwaitingReview: accepted from older exports, imported as Resolved
              status: z.enum(["Open", "AgentWorking", "AwaitingReview", "Resolved"]).optional(),
              orphaned: z.boolean().optional(),
              messages: z.array(z.object({ text: z.string(), author: z.string().optional(), kind: z.enum(["message", "activity"]).optional() })).default([]),
              markup: z.array(strokeInput.extend({ id: id.optional() })).default([]),
            }),
          )
          .default([]),
        versionID: id.optional(),
      }),
      async ({ tx, ctx, args }) => {
        const c = requireUser(ctx);
        for (const s of args.scripts) {
          const err = validateScriptPath(s.path);
          if (err) fail("invalid_path", err, { path: s.path });
        }
        const now = Date.now();
        await tx.mutate.documents.insert({
          id: args.id,
          name: args.name,
          ownerID: c.userID,
          units: args.units ?? "mm",
          settings: { ...(args.settings ?? {}), agent: defaultAgent(c) },
          headVersion: 0,
          createdAt: now,
          updatedAt: now,
        });
        await tx.mutate.documentMembers.insert({ documentID: args.id, userID: c.userID, role: "owner", createdAt: now });
        for (const s of args.scripts) {
          const hash = await sha256Hex(s.content);
          await storeContent(tx, hash, s.content);
          await tx.mutate.scripts.insert({
            id: scriptID(args.id, s.path),
            documentID: args.id,
            path: s.path,
            content: s.content,
            contentHash: hash,
            version: 1,
            updatedAt: now,
            updatedByUser: c.userID,
            updatedByAgent: c.agentSessionID ?? null,
          });
        }
        for (const cfg of args.configurations) {
          if (cfg.name === "Default") continue;
          const cid = cfg.id ?? `${args.id}:cfg:${cfg.name}`;
          await tx.mutate.configurations.insert({ id: cid, documentID: args.id, name: cfg.name, createdAt: now });
          for (const o of cfg.overrides) {
            await tx.mutate.paramOverrides.insert({
              id: `${cid}:${o.part}:${o.name}`,
              documentID: args.id,
              configurationID: cid,
              part: o.part,
              name: o.name,
              expression: o.expression,
              value: o.value,
              updatedAt: now,
            });
          }
        }
        let n = 0;
        for (const note of args.notes) {
          const nid = note.id ?? `${args.id}:note:${n++}`;
          const { markup: _m, ...anchor } = note.anchor;
          await tx.mutate.notes.insert({
            id: nid,
            documentID: args.id,
            authorUserID: c.userID,
            authorAgentID: null,
            anchor: anchor as NoteAnchor,
            snapshotHash: null,
            status: note.status === "AgentWorking" ? "Open" : note.status === "AwaitingReview" ? "Resolved" : (note.status ?? "Open"),
            orphaned: note.orphaned ?? false,
            claimedBy: null,
            removedAt: null,
            createdAt: now,
            updatedAt: now,
          });
          let m = 0;
          for (const msg of note.messages) {
            await tx.mutate.noteMessages.insert({
              id: `${nid}:msg:${m++}`,
              noteID: nid,
              documentID: args.id,
              authorUserID: c.userID,
              authorAgentID: null,
              kind: msg.kind ?? "message",
              text: msg.text,
              data: msg.author ? { importedAuthor: msg.author } : null,
              versionID: null,
              createdAt: now + m,
            });
          }
          let k = 0;
          for (const st of note.markup) {
            await tx.mutate.markupStrokes.insert({
              id: st.id ?? `${nid}:stroke:${k++}`,
              documentID: args.id,
              noteID: nid,
              authorUserID: c.userID,
              part: st.part,
              points: st.points,
              color: st.color,
              width: st.width ?? 2,
              createdAt: now,
            });
          }
        }
        await createVersion(tx, c, { id: args.versionID ?? newID(), documentID: args.id, kind: "import", message: "Imported" });
      },
    ),
  },

  script: {
    /** write_script: full content. baseVersion = the script's `version`, or null to create. */
    write: defineMutator(
      z.object({
        documentID: id,
        path: z.string(),
        content: z.string().max(1_000_000),
        baseVersion: z.number().int().nullable(),
        message: z.string().max(500).optional(),
        noteID: id.optional(),
        versionID: id.optional(),
      }),
      async ({ tx, ctx, args }) => writeScriptImpl(tx, ctx, args),
    ),

    /** edit_script: search/replace edits applied to the current content. */
    edit: defineMutator(
      z.object({
        documentID: id,
        path: z.string(),
        edits: z.array(scriptEditSchema).min(1).max(200),
        baseVersion: z.number().int(),
        message: z.string().max(500).optional(),
        noteID: id.optional(),
        versionID: id.optional(),
      }),
      async ({ tx, ctx, args }) => writeScriptImpl(tx, ctx, { ...args, content: "", edits: args.edits }),
    ),

    delete: defineMutator(
      z.object({
        documentID: id,
        path: z.string(),
        baseVersion: z.number().int(),
        message: z.string().max(500).optional(),
        noteID: id.optional(),
        versionID: id.optional(),
      }),
      async ({ tx, ctx, args }) => writeScriptImpl(tx, ctx, { ...args, content: null }),
    ),

    /**
     * write_scripts: several files in one transaction and one version (a lib change and the
     * studios that use it). Each file gives `content`, `edits` or `delete: true`, plus its own
     * baseVersion; any stale base rejects the whole write.
     */
    writeMany: defineMutator(
      z.object({
        documentID: id,
        files: z
          .array(
            z.object({
              path: z.string(),
              content: z.string().max(1_000_000).optional(),
              edits: z.array(scriptEditSchema).min(1).max(200).optional(),
              delete: z.boolean().optional(),
              baseVersion: z.number().int().nullable(),
            }),
          )
          .min(1)
          .max(50),
        message: z.string().max(500).optional(),
        noteID: id.optional(),
        versionID: id.optional(),
      }),
      async ({ tx, ctx, args }) => {
        const files = args.files.map((f): ScriptChange => {
          const given = [f.content !== undefined, f.edits !== undefined, f.delete === true].filter(Boolean).length;
          if (given !== 1) fail("invalid", `${f.path}: give exactly one of content, edits or delete`, { path: f.path });
          if (f.delete || f.edits) {
            if (f.baseVersion === null) fail("invalid", `${f.path}: ${f.delete ? "delete" : "edits"} need the script's baseVersion`, { path: f.path });
          }
          return { path: f.path, baseVersion: f.baseVersion, content: f.delete ? null : (f.content ?? ""), edits: f.edits };
        });
        await writeScriptsImpl(tx, ctx, { documentID: args.documentID, files, message: args.message, noteID: args.noteID, versionID: args.versionID });
      },
    ),
  },

  version: {
    /** restore_version: copies a version's scripts + param state to the tip as a new version. */
    restore: defineMutator(
      z.object({ documentID: id, versionID: id, newVersionID: id.optional(), noteID: id.optional() }),
      async ({ tx, ctx, args }) => {
        const c = await authorize(tx, ctx, args.documentID, "editor");
        const target = await need(tx, await tx.run(zql.versions.where("id", args.versionID).one()), "Version", { versionID: args.versionID });
        if (!target) return;
        if (target.documentID !== args.documentID) fail("invalid", "Version belongs to another document");
        const doc = await tx.run(zql.documents.where("id", args.documentID).one());
        if (!doc) return;
        await applySnapshot(tx, c, args.documentID, target.snapshot, doc.headVersion + 1);
        await createVersion(tx, c, {
          id: args.newVersionID ?? newID(),
          documentID: args.documentID,
          kind: "restore",
          message: `Restored from v${target.number}`,
          restoredFrom: target.id,
          noteID: args.noteID,
        });
      },
    ),
  },

  param: {
    /** General form: set some overrides and reset others in one change (what undo emits). */
    apply: defineMutator(
      z.object({
        documentID: id,
        configurationID: id,
        set: z.array(overrideInput).default([]),
        reset: z.array(paramKey.extend({ codeDefault: z.string().optional() })).default([]),
        versionID: id.optional(),
      }),
      async ({ tx, ctx, args }) => applyParamsImpl(tx, ctx, args),
    ),

    set: defineMutator(
      overrideInput.extend({ documentID: id, configurationID: id, versionID: id.optional() }),
      async ({ tx, ctx, args }) => {
        const { documentID, configurationID, versionID, ...o } = args;
        await applyParamsImpl(tx, ctx, { documentID, configurationID, versionID, set: [o], reset: [] });
      },
    ),

    reset: defineMutator(
      paramKey.extend({ documentID: id, configurationID: id, codeDefault: z.string().optional(), versionID: id.optional() }),
      async ({ tx, ctx, args }) => {
        const { documentID, configurationID, versionID, ...k } = args;
        await applyParamsImpl(tx, ctx, { documentID, configurationID, versionID, set: [], reset: [k] });
      },
    ),

    /** "Reset all", for a configuration or for one part within it. */
    resetAll: defineMutator(
      z.object({ documentID: id, configurationID: id, part: z.string().optional(), versionID: id.optional() }),
      async ({ tx, ctx, args }) => {
        const all = await tx.run(zql.paramOverrides.where("configurationID", args.configurationID));
        const reset = all.filter((o) => !args.part || o.part === args.part).map((o) => ({ part: o.part, name: o.name }));
        await applyParamsImpl(tx, ctx, { documentID: args.documentID, configurationID: args.configurationID, versionID: args.versionID, set: [], reset });
      },
    ),
  },

  configuration: {
    create: defineMutator(
      z.object({ id, documentID: id, name, overrides: z.array(snapshotOverride).default([]), versionID: id.optional() }),
      async ({ tx, ctx, args }) => createConfigurationImpl(tx, ctx, args),
    ),

    duplicate: defineMutator(
      z.object({ id, sourceID: id, name, versionID: id.optional() }),
      async ({ tx, ctx, args }) => {
        const src = await need(tx, await tx.run(zql.configurations.where("id", args.sourceID).related("overrides").one()), "Configuration");
        if (!src) return;
        await createConfigurationImpl(tx, ctx, {
          id: args.id,
          documentID: src.documentID,
          name: args.name,
          versionID: args.versionID,
          overrides: src.overrides.map((o) => ({ part: o.part, name: o.name, expression: o.expression, value: o.value as ParamValue })),
        });
      },
    ),

    rename: defineMutator(z.object({ id, name, versionID: id.optional() }), async ({ tx, ctx, args }) => {
      const cfg = await need(tx, await tx.run(zql.configurations.where("id", args.id).one()), "Configuration");
      if (!cfg) return;
      const c = await authorize(tx, ctx, cfg.documentID, "editor");
      if (args.name === "Default") fail("invalid", '"Default" is reserved');
      if (cfg.name === args.name) return;
      const clash = await tx.run(zql.configurations.where("documentID", cfg.documentID).where("name", args.name).one());
      if (clash) fail("exists", `A configuration named "${args.name}" already exists`);
      await tx.mutate.configurations.update({ id: args.id, name: args.name });
      await recordParamsChange(tx, c, cfg.documentID, { [`config:${cfg.id}`]: { kind: "config", label: "configuration", from: cfg.name, to: args.name } }, args.versionID);
    }),

    delete: defineMutator(z.object({ id, versionID: id.optional() }), async ({ tx, ctx, args }) => {
      const cfg = await need(tx, await tx.run(zql.configurations.where("id", args.id).one()), "Configuration");
      if (!cfg) return;
      const c = await authorize(tx, ctx, cfg.documentID, "editor");
      const overrides = await tx.run(zql.paramOverrides.where("configurationID", args.id));
      for (const o of overrides) await tx.mutate.paramOverrides.delete({ id: o.id });
      await tx.mutate.configurations.delete({ id: args.id });
      // Anyone whose active configuration this was falls back to Default.
      const pres = await tx.run(zql.presence.where("documentID", cfg.documentID).where("activeConfigurationID", args.id));
      for (const p of pres) await tx.mutate.presence.update({ id: p.id, activeConfigurationID: null });
      await recordParamsChange(tx, c, cfg.documentID, { [`config:${cfg.id}`]: { kind: "config", label: "configuration", from: cfg.name, to: "" } }, args.versionID);
    }),
  },

  note: {
    /**
     * Creates a note. The snapshot blob must already be uploaded (upload first,
     * then reference). Draft strokes (`strokeIDs`) are attached; `strokes` are
     * inserted attached. `assignAgent` hands it to the built-in agent in the same transaction, so
     * the agent can't claim it in between (a separate assignAgent would clobber the claim's status).
     */
    create: defineMutator(
      z.object({
        id,
        documentID: id,
        anchor: anchorSchema,
        text: z.string().max(20_000).default(""),
        messageID: id.optional(),
        strokeIDs: z.array(id).default([]),
        strokes: z.array(strokeInput).default([]),
        assignAgent: z.boolean().default(false),
        images,
      }),
      async ({ tx, ctx, args }) => {
        const c = await authorize(tx, ctx, args.documentID, args.assignAgent ? "editor" : "viewer");
        if (args.assignAgent && c.agentSessionID) fail("forbidden", "Only people can hand notes to the agent");
        const hash = args.anchor.snapshot;
        if (!SHA256_RE.test(hash)) fail("invalid", "anchor.snapshot must be a sha256 blob hash");
        if (isServer(tx)) {
          const rows = await pg(tx, "UPDATE blobs SET refcount = refcount + 1 WHERE hash = $1 RETURNING hash", [hash]);
          if (rows.length === 0) fail("blob_missing", "Upload the snapshot before creating the note", { hash });
        }
        await referenceImages(tx, args.images);
        const now = Date.now();
        const who = author(c);
        const { markup: _markup, ...anchor } = args.anchor;
        await tx.mutate.notes.insert({
          id: args.id,
          documentID: args.documentID,
          authorUserID: who.userID,
          authorAgentID: who.agentID,
          anchor: anchor as NoteAnchor,
          snapshotHash: hash,
          status: "Open",
          orphaned: false,
          claimedBy: null,
          ...(args.assignAgent ? { agentAssignedBy: c.userID, agentAssignedAt: now } : {}),
          removedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        if (args.text.trim() || args.images.length) {
          await tx.mutate.noteMessages.insert({
            id: args.messageID ?? `${args.id}:0`,
            noteID: args.id,
            documentID: args.documentID,
            authorUserID: who.userID,
            authorAgentID: who.agentID,
            kind: "message",
            text: args.text,
            data: args.images.length ? { images: args.images } : null,
            versionID: null,
            createdAt: now,
          });
        }
        for (const sid of args.strokeIDs) {
          const s = await tx.run(zql.markupStrokes.where("id", sid).one());
          if (!s) continue;
          if (s.documentID !== args.documentID || s.noteID) fail("invalid", "Stroke belongs elsewhere", { strokeID: sid });
          await tx.mutate.markupStrokes.update({ id: sid, noteID: args.id });
        }
        for (const s of args.strokes) {
          await tx.mutate.markupStrokes.insert({
            id: s.id,
            documentID: args.documentID,
            noteID: args.id,
            authorUserID: who.userID,
            part: s.part,
            points: s.points,
            color: s.color,
            width: s.width ?? 2,
            createdAt: now,
          });
        }
        await notifyNote(tx, { documentID: args.documentID, noteID: args.id, kind: "created" });
      },
    ),

    /**
     * Reply, or (kind "activity") an agent activity-log entry. A human reply
     * moves a Resolved note back to Open. It does not yank an
     * active agent claim: the agent sees the reply in its thread.
     */
    reply: defineMutator(
      z.object({
        id,
        noteID: id,
        text: z.string().max(20_000),
        versionID: id.optional(),
        kind: z.enum(["message", "activity"]).default("message"),
        data: z.record(z.string(), z.any()).optional(),
        images,
      }),
      async ({ tx, ctx, args }) => {
        const l = await loadNote(tx, ctx, args.noteID);
        if (!l) return;
        const { note, c } = l;
        if (args.kind === "message" && !args.text.trim() && !args.images.length) fail("invalid", "Write something or attach an image");
        await referenceImages(tx, args.images);
        // images live only in `images`: a caller's data can't reference blobs it didn't upload
        const { images: _i, ...extra } = args.data ?? {};
        const data = args.images.length ? { ...extra, images: args.images } : args.data ? extra : null;
        const who = author(c);
        const now = Date.now();
        await tx.mutate.noteMessages.insert({
          id: args.id,
          noteID: note.id,
          documentID: note.documentID,
          authorUserID: who.userID,
          authorAgentID: who.agentID,
          kind: args.kind,
          text: args.text,
          data,
          versionID: args.versionID ?? null,
          createdAt: now,
        });
        const humanReply = args.kind === "message" && !who.agentID;
        if (humanReply && note.status === "Resolved") {
          await tx.mutate.notes.update({ id: note.id, status: "Open", updatedAt: now });
        } else {
          await tx.mutate.notes.update({ id: note.id, updatedAt: now });
        }
        if (humanReply) await notifyNote(tx, { documentID: note.documentID, noteID: note.id, kind: "reply" });
      },
    ),

    /** Deletes one of your own messages (used by undo of a reply). */
    deleteMessage: defineMutator(z.object({ id }), async ({ tx, ctx, args }) => {
      const msg = await need(tx, await tx.run(zql.noteMessages.where("id", args.id).one()), "Message");
      if (!msg) return;
      const c = await authorize(tx, ctx, msg.documentID, "viewer");
      const who = author(c);
      if (msg.authorUserID !== who.userID || (msg.authorAgentID ?? null) !== who.agentID)
        fail("forbidden", "You can only delete your own messages");
      await tx.mutate.noteMessages.delete({ id: args.id });
    }),

    /** claim_note: fails with the holder's name if another session has it. Agent sessions only. */
    claim: defineMutator(z.object({ noteID: id }), async ({ tx, ctx, args }) => {
      const l = await loadNote(tx, ctx, args.noteID, "editor");
      if (!l) return;
      const { note, c } = l;
      if (!c.agentSessionID) fail("forbidden", "Only agent sessions can claim notes");
      if (note.removedAt) fail("invalid", "This note was removed");
      if (note.claimedBy && note.claimedBy !== c.agentSessionID) {
        const holder = await holderName(tx, note.claimedBy);
        fail("claimed", `Claimed by ${holder.name}`, { holder });
      }
      await tx.mutate.notes.update({ id: note.id, claimedBy: c.agentSessionID, status: "AgentWorking", updatedAt: Date.now() });
      await setAgentStatus(tx, c.agentSessionID, "working", { noteID: note.id });
    }),

    /** release_note: by the holder, or by a human editor (to take a note back). */
    release: defineMutator(z.object({ noteID: id }), async ({ tx, ctx, args }) => {
      const l = await loadNote(tx, ctx, args.noteID, "editor");
      if (!l) return;
      const { note, c } = l;
      if (!note.claimedBy) {
        if (isServer(tx)) fail("not_claimed", "This note is not claimed");
        return;
      }
      if (c.agentSessionID && note.claimedBy !== c.agentSessionID) {
        const holder = await holderName(tx, note.claimedBy);
        fail("claimed", `Claimed by ${holder.name}`, { holder });
      }
      await tx.mutate.notes.update({
        id: note.id,
        claimedBy: null,
        status: note.status === "AgentWorking" ? "Open" : note.status,
        // a person taking a note back also takes it off the built-in agent's list
        ...(c.agentSessionID ? {} : { agentAssignedBy: null, agentAssignedAt: null }),
        updatedAt: Date.now(),
      });
      await setAgentStatus(tx, note.claimedBy, "idle", null);
    }),

    /**
     * Hand a note to the built-in agent (it runs on your provider), or take it back. Taking it back
     * releases the agent's claim, which stops a run in progress.
     */
    assignAgent: defineMutator(z.object({ noteID: id, assign: z.boolean() }), async ({ tx, ctx, args }) => {
      const l = await loadNote(tx, ctx, args.noteID, "editor");
      if (!l) return;
      const { note, c } = l;
      if (c.agentSessionID) fail("forbidden", "Only people can hand notes to the agent");
      if (note.removedAt) fail("invalid", "This note was removed");
      const now = Date.now();
      if (args.assign) {
        if (note.claimedBy) {
          const holder = await holderName(tx, note.claimedBy);
          fail("claimed", `Claimed by ${holder.name}`, { holder });
        }
        // only reopens a resolved note: never overwrite AgentWorking from a claim that raced in
        const reopen = note.status === "Resolved" ? { status: "Open" as const } : {};
        await tx.mutate.notes.update({ id: note.id, agentAssignedBy: c.userID, agentAssignedAt: now, ...reopen, updatedAt: now });
        await notifyNote(tx, { documentID: note.documentID, noteID: note.id, kind: "assigned" });
        return;
      }
      const holder = note.claimedBy ? await tx.run(zql.agentSessions.where("id", note.claimedBy).one()) : undefined;
      const release = holder?.builtin ? { claimedBy: null, status: note.status === "AgentWorking" ? ("Open" as const) : note.status } : {};
      await tx.mutate.notes.update({ id: note.id, agentAssignedBy: null, agentAssignedAt: null, ...release, updatedAt: now });
      if (holder?.builtin) await setAgentStatus(tx, holder.id, "idle", null);
    }),

    /** set_note_status. AgentWorking is only entered through claim; any other status releases the claim. */
    setStatus: defineMutator(
      z.object({ noteID: id, status: z.enum(["Open", "Resolved"]) }),
      async ({ tx, ctx, args }) => {
        const l = await loadNote(tx, ctx, args.noteID, "viewer");
        if (!l) return;
        const { note, c } = l;
        if (c.agentSessionID && note.claimedBy && note.claimedBy !== c.agentSessionID) {
          const holder = await holderName(tx, note.claimedBy);
          fail("claimed", `Claimed by ${holder.name}`, { holder });
        }
        await tx.mutate.notes.update({ id: note.id, status: args.status, claimedBy: null, updatedAt: Date.now() });
        if (note.claimedBy) await setAgentStatus(tx, note.claimedBy, "idle", null);
      },
    ),

    /** delete_note: soft delete (removed notes are hidden by default and can be restored). */
    remove: defineMutator(z.object({ noteID: id }), async ({ tx, ctx, args }) => {
      const l = await loadNote(tx, ctx, args.noteID, "viewer");
      if (!l) return;
      const { note } = l;
      if (note.removedAt) return;
      const now = Date.now();
      await tx.mutate.notes.update({ id: note.id, removedAt: now, claimedBy: null, updatedAt: now });
      if (note.claimedBy) await setAgentStatus(tx, note.claimedBy, "idle", null);
    }),

    restore: defineMutator(z.object({ noteID: id }), async ({ tx, ctx, args }) => {
      const l = await loadNote(tx, ctx, args.noteID, "viewer");
      if (!l) return;
      await tx.mutate.notes.update({ id: l.note.id, removedAt: null, updatedAt: Date.now() });
    }),

    reanchor: defineMutator(z.object({ noteID: id, anchor: anchorSchema.partial({ snapshot: true }) }), async ({ tx, ctx, args }) => {
      const l = await loadNote(tx, ctx, args.noteID, "viewer");
      if (!l) return;
      const { markup: _m, ...anchor } = args.anchor;
      const merged = { ...anchor, snapshot: anchor.snapshot ?? l.note.anchor.snapshot } as NoteAnchor;
      if (merged.snapshot !== l.note.anchor.snapshot && isServer(tx)) {
        const rows = await pg(tx, "UPDATE blobs SET refcount = refcount + 1 WHERE hash = $1 RETURNING hash", [merged.snapshot]);
        if (rows.length === 0) fail("blob_missing", "Upload the snapshot before re-anchoring", { hash: merged.snapshot });
      }
      await tx.mutate.notes.update({ id: l.note.id, anchor: merged, snapshotHash: merged.snapshot, orphaned: false, updatedAt: Date.now() });
    }),

    /** Set by anchor resolution after a regeneration (PLAN §6). */
    setOrphaned: defineMutator(z.object({ noteID: id, orphaned: z.boolean() }), async ({ tx, ctx, args }) => {
      const l = await loadNote(tx, ctx, args.noteID, "viewer");
      if (!l || l.note.orphaned === args.orphaned) return;
      await tx.mutate.notes.update({ id: l.note.id, orphaned: args.orphaned });
    }),
  },

  markup: {
    /** Adds a pencil stroke: a draft stroke (no noteID) or one attached to a note. */
    add: defineMutator(
      strokeInput.extend({ documentID: id, noteID: id.nullable().optional() }),
      async ({ tx, ctx, args }) => {
        const c = await authorize(tx, ctx, args.documentID, "viewer");
        await tx.mutate.markupStrokes.insert({
          id: args.id,
          documentID: args.documentID,
          noteID: args.noteID ?? null,
          authorUserID: c.userID,
          part: args.part,
          points: args.points,
          color: args.color,
          width: args.width ?? 2,
          createdAt: Date.now(),
        });
      },
    ),

    remove: defineMutator(z.object({ id }), async ({ tx, ctx, args }) => {
      const s = await need(tx, await tx.run(zql.markupStrokes.where("id", args.id).one()), "Stroke");
      if (!s) return;
      await authorize(tx, ctx, s.documentID, "viewer");
      await tx.mutate.markupStrokes.delete({ id: args.id });
    }),
  },

  presence: {
    /** Upsert this tab's (or agent session's) selection / active configuration. Not versioned, not undoable. */
    set: defineMutator(
      z.object({
        id,
        documentID: id,
        selection: z
          .array(z.object({ kind: z.enum(["face", "edge", "vertex", "part"]), name: z.string(), part: z.string().optional() }))
          .max(5000)
          .optional(),
        activeConfigurationID: id.nullable().optional(),
      }),
      async ({ tx, ctx, args }) => {
        const c = await authorize(tx, ctx, args.documentID, "viewer");
        const existing = await tx.run(zql.presence.where("id", args.id).one());
        if (existing && existing.userID !== c.userID) fail("forbidden", "Presence row belongs to someone else");
        if (args.activeConfigurationID) {
          const cfg = await tx.run(zql.configurations.where("id", args.activeConfigurationID).one());
          if (cfg && cfg.documentID !== args.documentID) fail("invalid", "Configuration belongs to another document");
        }
        await tx.mutate.presence.upsert({
          id: args.id,
          documentID: args.documentID,
          userID: c.userID,
          agentSessionID: c.agentSessionID ?? null,
          selection: args.selection ?? existing?.selection ?? [],
          activeConfigurationID:
            args.activeConfigurationID !== undefined ? args.activeConfigurationID : (existing?.activeConfigurationID ?? null),
          updatedAt: Date.now(),
        });
      },
    ),

    clear: defineMutator(z.object({ id }), async ({ tx, ctx, args }) => {
      const c = requireUser(ctx);
      const existing = await tx.run(zql.presence.where("id", args.id).one());
      if (!existing) return;
      if (existing.userID !== c.userID) fail("forbidden", "Presence row belongs to someone else");
      await tx.mutate.presence.delete({ id: args.id });
    }),
  },

  /** Agent sessions are created by the MCP server (server-side runMutator) after OAuth. */
  agent: {
    start: defineMutator(
      z.object({
        id,
        clientName: z.string().min(1).max(100),
        label: z.string().max(100).optional(),
        documentID: id.optional(),
        oauthClientID: id.optional(),
      }),
      async ({ tx, ctx, args }) => {
        const c = requireUser(ctx);
        if (args.documentID) await authorize(tx, { userID: c.userID }, args.documentID, "viewer");
        const existing = await tx.run(zql.agentSessions.where("id", args.id).one());
        if (existing && existing.userID !== c.userID) fail("forbidden", "Agent session belongs to someone else");
        const now = Date.now();
        await tx.mutate.agentSessions.upsert({
          id: args.id,
          userID: c.userID,
          oauthClientID: args.oauthClientID ?? null,
          clientName: args.clientName,
          label: args.label ?? null,
          avatarSeed: existing?.avatarSeed ?? args.id,
          status: "idle",
          documentID: args.documentID ?? null,
          detail: null,
          createdAt: existing?.createdAt ?? now,
          lastSeenAt: now,
        });
      },
    ),

    setStatus: defineMutator(
      z.object({
        id,
        status: z.enum(["idle", "working", "writing", "disconnected"]),
        detail: z.record(z.string(), z.any()).nullable().optional(),
        documentID: id.nullable().optional(),
      }),
      async ({ tx, ctx, args }) => {
        const c = requireUser(ctx);
        const s = await need(tx, await tx.run(zql.agentSessions.where("id", args.id).one()), "Agent session");
        if (!s) return;
        if (s.userID !== c.userID) fail("forbidden", "Agent session belongs to someone else");
        if (args.documentID) await authorize(tx, { userID: c.userID }, args.documentID, "viewer");
        await tx.mutate.agentSessions.update({
          id: args.id,
          status: args.status,
          ...(args.detail !== undefined ? { detail: args.detail } : {}),
          ...(args.documentID !== undefined ? { documentID: args.documentID } : {}),
          lastSeenAt: Date.now(),
        });
      },
    ),
  },
});

export type Mutators = typeof mutators;

// Re-exported for server-side helpers and tests.
export type { Configuration, NoteStatus, SnapshotConfiguration };
