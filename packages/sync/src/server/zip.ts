/**
 * Plain-file import/export (PLAN §3 Import and export):
 *
 *   bracket.zip
 *   ├─ parasocial.json   settings, units, configurations and overrides
 *   ├─ studios/*.ts
 *   ├─ lib/**\/*.ts
 *   └─ notes.json        optional: threads and anchors
 *
 * Versions and blobs are not exported. Import goes through the
 * `document.import` mutator, so it gets the same validation and a single
 * "Imported" version. The same payload shape can be read from a directory
 * (`readDocumentDir`), which is how `examples/` gets seeded.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { mutators } from "../mutators.ts";
import { zql } from "../schema.ts";
import type { MutatorContext, NoteAnchor, NoteStatus, ParamValue } from "../types.ts";
import { newID, validateScriptPath } from "../util.ts";
import type { ServerConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { checkOrigin, error, handle, HttpError, json } from "./http.ts";
import { runMutator } from "./zero.ts";

export const FORMAT = "parasocial/1";
export const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;

export type Manifest = {
  format: typeof FORMAT;
  name: string;
  units: string;
  settings?: Record<string, unknown>;
  configurations: { name: string; overrides: { part: string; name: string; expression: string; value: ParamValue }[] }[];
};

export type ExportedNote = {
  anchor: Omit<NoteAnchor, "snapshot" | "markup"> & { snapshot?: string };
  status: NoteStatus;
  orphaned: boolean;
  messages: { author: string; kind: "message" | "activity"; text: string; createdAt: string }[];
  markup: { part: string; points: [number, number, number][]; color: string; width: number }[];
};

export type DocumentPayload = {
  manifest: Manifest;
  scripts: { path: string; content: string }[];
  notes?: ExportedNote[] | undefined;
};

// ───────────────────────────── build / parse ─────────────────────────────

const FIXED_MTIME = new Date("2000-01-01T00:00:00Z"); // deterministic zips

export function buildDocumentZip(p: DocumentPayload): Uint8Array {
  const files: Zippable = {};
  const add = (path: string, text: string) => {
    files[path] = [strToU8(text), { mtime: FIXED_MTIME }];
  };
  add("parasocial.json", JSON.stringify(p.manifest, null, 2) + "\n");
  for (const s of [...p.scripts].sort((a, b) => a.path.localeCompare(b.path))) add(s.path, s.content);
  if (!p.scripts.some((s) => s.path.startsWith("lib/"))) files["lib/"] = [new Uint8Array(0), { mtime: FIXED_MTIME }];
  if (p.notes && p.notes.length) add("notes.json", JSON.stringify(p.notes, null, 2) + "\n");
  return zipSync(files, { level: 6 });
}

/** Parses and validates a document zip. Throws HttpError(400) with a readable message. */
export function parseDocumentZip(bytes: Uint8Array): DocumentPayload {
  if (bytes.length > MAX_ZIP_BYTES) throw new HttpError(413, "Zip too large");
  let entries: Record<string, Uint8Array>;
  let total = 0;
  let count = 0;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        count++;
        total += f.originalSize;
        if (count > MAX_FILES) throw new HttpError(400, "Too many files in zip");
        if (total > MAX_UNCOMPRESSED) throw new HttpError(413, "Zip expands too large");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "Not a valid zip file");
  }
  // Tolerate a single top-level folder (e.g. "bracket/parasocial.json" from zipping a directory).
  const names = Object.keys(entries).filter((n) => !n.endsWith("/") && !n.startsWith("__MACOSX/") && !n.endsWith(".DS_Store"));
  const root = names.includes("parasocial.json") ? "" : commonRoot(names);
  const files = new Map<string, Uint8Array>();
  for (const n of names) files.set(n.slice(root.length), entries[n]!);
  return payloadFromFiles(files);
}

function commonRoot(names: string[]): string {
  const m = names.find((n) => n.endsWith("/parasocial.json"));
  if (!m) return "";
  const root = m.slice(0, -"parasocial.json".length);
  return root.split("/").length === 2 && names.every((n) => n.startsWith(root)) ? root : "";
}

function payloadFromFiles(files: Map<string, Uint8Array>): DocumentPayload {
  const manifestBytes = files.get("parasocial.json");
  if (!manifestBytes) throw new HttpError(400, "parasocial.json is missing");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new HttpError(400, "parasocial.json is not valid JSON");
  }
  if (manifest.format && manifest.format !== FORMAT) throw new HttpError(400, `Unsupported format ${manifest.format}`);
  if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new HttpError(400, "parasocial.json: name is required");
  manifest = {
    format: FORMAT,
    name: manifest.name.trim().slice(0, 200),
    units: typeof manifest.units === "string" ? manifest.units : "mm",
    settings: manifest.settings ?? {},
    configurations: Array.isArray(manifest.configurations) ? manifest.configurations : [],
  };

  const scripts: DocumentPayload["scripts"] = [];
  const ignored: string[] = [];
  for (let [path, data] of files) {
    if (path === "parasocial.json" || path === "notes.json") continue;
    // studios/ was parts/ before multi-part studios; older exports still import
    if (path.startsWith("parts/")) path = `studios/${path.slice("parts/".length)}`;
    if (path.startsWith("studios/") || path.startsWith("lib/")) {
      const err = validateScriptPath(path);
      if (err) throw new HttpError(400, err);
      scripts.push({ path, content: strFromU8(data) });
    } else {
      ignored.push(path);
    }
  }
  if (ignored.length) throw new HttpError(400, `Unexpected files outside studios/ and lib/: ${ignored.slice(0, 5).join(", ")}`);

  let notes: ExportedNote[] | undefined;
  const notesBytes = files.get("notes.json");
  if (notesBytes) {
    try {
      notes = JSON.parse(strFromU8(notesBytes));
    } catch {
      throw new HttpError(400, "notes.json is not valid JSON");
    }
    if (!Array.isArray(notes)) throw new HttpError(400, "notes.json must be an array");
  }
  scripts.sort((a, b) => a.path.localeCompare(b.path));
  return { manifest, scripts, notes };
}

/** Reads the same layout from a directory (examples/ seeding, regression corpus). */
export async function readDocumentDir(dir: string): Promise<DocumentPayload> {
  const files = new Map<string, Uint8Array>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    const rel = relative(dir, abs).split(sep).join("/");
    if (rel.split("/").some((seg) => seg.startsWith("."))) continue;
    files.set(rel, new Uint8Array(await Bun.file(abs).arrayBuffer()));
  }
  return payloadFromFiles(files);
}

// ───────────────────────────── DB ↔ payload ─────────────────────────────

export async function exportDocument(db: Db, documentID: string, userID: string, opts: { notes?: boolean } = {}): Promise<DocumentPayload> {
  const [m] = await db.sql`SELECT 1 FROM document_members WHERE document_id = ${documentID} AND user_id = ${userID}`;
  if (!m) throw new HttpError(403, "Not a member of this document");
  const doc = await db.zql.run(zql.documents.where("id", documentID).one());
  if (!doc) throw new HttpError(404, "Document not found");
  const scripts = await db.zql.run(zql.scripts.where("documentID", documentID).orderBy("path", "asc"));
  const configs = await db.zql.run(zql.configurations.where("documentID", documentID).related("overrides").orderBy("createdAt", "asc"));
  const manifest: Manifest = {
    format: FORMAT,
    name: doc.name,
    units: doc.units,
    settings: doc.settings as Record<string, unknown>,
    configurations: configs.map((c) => ({
      name: c.name,
      overrides: [...c.overrides]
        .sort((a, b) => (a.part + a.name).localeCompare(b.part + b.name))
        .map((o) => ({ part: o.part, name: o.name, expression: o.expression, value: o.value as ParamValue })),
    })),
  };
  let notes: ExportedNote[] | undefined;
  if (opts.notes !== false) {
    const rows = await db.zql.run(
      zql.notes
        .where("documentID", documentID)
        .where("removedAt", "IS", null)
        .related("messages", (q) => q.orderBy("createdAt", "asc").related("authorUser").related("authorAgent"))
        .related("strokes", (q) => q.orderBy("createdAt", "asc"))
        .orderBy("createdAt", "asc"),
    );
    notes = rows.map((n) => {
      const { snapshot: _s, markup: _m, ...anchor } = n.anchor;
      return {
        anchor,
        status: n.status,
        orphaned: n.orphaned,
        messages: n.messages.map((msg) => ({
          author:
            (msg.data as { importedAuthor?: string } | null)?.importedAuthor ??
            msg.authorAgent?.clientName ??
            msg.authorUser?.name ??
            "unknown",
          kind: msg.kind,
          text: msg.text,
          createdAt: new Date(msg.createdAt).toISOString(),
        })),
        markup: n.strokes.map((s) => ({ part: s.part, points: s.points, color: s.color, width: s.width })),
      };
    });
  }
  return { manifest, scripts: scripts.map((s) => ({ path: s.path, content: s.content })), notes };
}

/** Imports a payload as a new document owned by ctx.userID. */
export async function importDocument(
  db: Db,
  payload: DocumentPayload,
  ctx: MutatorContext,
  opts: { documentID?: string; name?: string } = {},
): Promise<{ documentID: string }> {
  const documentID = opts.documentID ?? newID();
  const r = await runMutator(
    db,
    mutators.document.import({
      id: documentID,
      name: opts.name ?? payload.manifest.name,
      units: payload.manifest.units,
      settings: (payload.manifest.settings ?? {}) as never,
      scripts: payload.scripts,
      configurations: payload.manifest.configurations,
      notes: (payload.notes ?? []).map((n) => ({
        anchor: n.anchor as never,
        status: n.status,
        orphaned: n.orphaned,
        messages: n.messages.map((m) => ({ text: m.text, author: m.author, kind: m.kind })),
        markup: n.markup,
      })),
    }),
    ctx,
  );
  if (!r.ok) throw new HttpError(400, r.message, { details: r.details });
  return { documentID };
}

// ───────────────────────────── HTTP ─────────────────────────────

/**
 *   GET  {base}/:id/export  → application/zip
 *   POST {base}/import      (zip body, optional ?name=) → { documentID }
 */
export function createZipHandlers(deps: {
  db: Db;
  config: Pick<ServerConfig, "appOrigin" | "engineOrigins">;
  resolveUser: (req: Request) => Promise<{ userID: string } | null>;
  basePath?: string;
}) {
  const basePath = deps.basePath ?? "/api/documents";
  const handleReq = handle(async (req) => {
    const denied = checkOrigin(req, deps.config);
    if (denied) return denied;
    const user = await deps.resolveUser(req);
    if (!user) return error(401, "Not signed in");
    const url = new URL(req.url);
    const sub = url.pathname.slice(basePath.length).replace(/^\/+|\/+$/g, "");
    if (req.method === "POST" && sub === "import") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const payload = parseDocumentZip(bytes);
      const out = await importDocument(deps.db, payload, { userID: user.userID }, { name: url.searchParams.get("name") ?? undefined });
      return json(out);
    }
    const m = /^([^/]+)\/export$/.exec(sub);
    if (req.method === "GET" && m) {
      const payload = await exportDocument(deps.db, decodeURIComponent(m[1]!), user.userID);
      const zip = buildDocumentZip(payload);
      const filename = payload.manifest.name.replace(/[^A-Za-z0-9 _.-]+/g, "").trim().replace(/\s+/g, "-") || "document";
      return new Response(zip as Uint8Array<ArrayBuffer>, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${filename}.zip"`,
          "cache-control": "no-store",
        },
      });
    }
    return error(404, "Not found");
  });
  return { handle: handleReq };
}
