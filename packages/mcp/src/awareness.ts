// Who else is on a script, and what changed under you. Several agents (and people) can work one
// document at once; reads and writes of scripts by MCP sessions are recorded here (in memory, per
// server process) so read/write results can say "Codex edited lib/size.ts 2 min ago" and flag
// files that others changed since this session last read them, especially lib files that the
// studios being written import.
import type { Db } from "@parasocial/sync/server";

/** How long a read or write counts as "recent". */
export const RECENT_MS = 10 * 60_000;

type Touch = { sessionID: string; who: string; kind: "read" | "write"; at: number };
type Who = { id: string; clientName: string; label?: string };

/** documentID → path → sessionID → latest touch */
const touches = new Map<string, Map<string, Map<string, Touch>>>();
/** session → documentID → path → version it last saw (read, or wrote) */
const seen = new WeakMap<object, Map<string, Map<string, number>>>();

const nameOf = (s: Who) => (s.label ? `${s.clientName} (${s.label})` : s.clientName);
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : `${Math.round(ms / 60_000)} min ago`);

/** Record that `s` read or wrote `path` at `version`. */
export function recordTouch(s: Who, documentID: string, path: string, kind: "read" | "write", version: number) {
  let byPath = touches.get(documentID);
  if (!byPath) touches.set(documentID, (byPath = new Map()));
  let bySession = byPath.get(path);
  if (!bySession) byPath.set(path, (bySession = new Map()));
  const prev = bySession.get(s.id);
  // a write stays the headline for the window even if the session reads the file again afterwards
  const kept = prev && prev.kind === "write" && kind === "read" && Date.now() - prev.at < RECENT_MS ? "write" : kind;
  bySession.set(s.id, { sessionID: s.id, who: nameOf(s), kind: kept, at: Date.now() });

  let docs = seen.get(s);
  if (!docs) seen.set(s, (docs = new Map()));
  let paths = docs.get(documentID);
  if (!paths) docs.set(documentID, (paths = new Map()));
  paths.set(path, version);
}

export type OtherSession = { who: string; did: "edited" | "read"; when: string };

/**
 * Other sessions recently on `path`: MCP sessions in this process (reads and writes), plus the
 * last writer recorded on the script row (covers people in the browser and other processes).
 */
export async function othersOn(db: Db, s: Who & { userID: string }, documentID: string, paths: string[]): Promise<Record<string, OtherSession[]>> {
  const now = Date.now();
  const out: Record<string, OtherSession[]> = {};
  const rows = paths.length
    ? await db.sql`SELECT s.path, s.updated_at, s.updated_by_agent, s.updated_by_user, u.name AS user_name, a.client_name, a.label
        FROM scripts s LEFT JOIN users u ON u.id = s.updated_by_user LEFT JOIN agent_sessions a ON a.id = s.updated_by_agent
        WHERE s.document_id = ${documentID} AND s.path = ANY(${paths})`
    : [];
  for (const path of paths) {
    const list = new Map<string, { did: "edited" | "read"; at: number }>();
    for (const t of touches.get(documentID)?.get(path)?.values() ?? []) {
      if (t.sessionID === s.id || now - t.at > RECENT_MS) continue;
      list.set(t.who, { did: t.kind === "write" ? "edited" : "read", at: t.at });
    }
    const r = rows.find((x: any) => x.path === path) as any;
    const at = r ? new Date(r.updated_at).getTime() : 0;
    if (r && now - at < RECENT_MS && r.updated_by_agent !== s.id && (r.updated_by_agent || r.updated_by_user)) {
      const who = r.client_name ? nameOf({ id: "", clientName: r.client_name, label: r.label ?? undefined }) : (r.user_name ?? "someone");
      const prev = list.get(who);
      if (!prev || prev.did === "read" || prev.at < at) list.set(who, { did: "edited", at: Math.max(at, prev?.at ?? 0) });
    }
    if (list.size) out[path] = [...list].sort((a, b) => b[1].at - a[1].at).map(([who, x]) => ({ who, did: x.did, when: ago(now - x.at) }));
  }
  return out;
}

/** Relative imports of a script, resolved to document paths (`../lib/size` → `lib/size.ts`). Commented-out imports don't count. */
export function importsOf(path: string, content: string): string[] {
  const dir = path.split("/").slice(0, -1);
  const out = new Set<string>();
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const m of code.matchAll(/(?:import|export)\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|import\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const spec = m[1] ?? m[2] ?? m[3]!;
    const parts = [...dir];
    for (const seg of spec.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    const p = parts.join("/");
    out.add(p.endsWith(".ts") ? p : `${p}.ts`);
  }
  return [...out];
}

export type ChangedUnderYou = { path: string; youSaw: number | null; now: number; by: string; importedBy?: string[] };

/**
 * Files others changed since this session last saw them. Covers every file the session read in
 * this document, plus the lib files the given scripts import (transitively) — those are listed
 * even if never read when another session changed them recently, with the importing scripts.
 */
export async function changedUnderYou(db: Db, s: Who, documentID: string, writtenPaths: string[] = []): Promise<ChangedUnderYou[]> {
  const rows = (await db.sql`SELECT s.path, s.content, s.version, s.updated_at, s.updated_by_agent, s.updated_by_user, u.name AS user_name, a.client_name, a.label
    FROM scripts s LEFT JOIN users u ON u.id = s.updated_by_user LEFT JOIN agent_sessions a ON a.id = s.updated_by_agent
    WHERE s.document_id = ${documentID}`) as any[];
  const byPath = new Map(rows.map((r) => [r.path as string, r]));
  const mine = seen.get(s)?.get(documentID) ?? new Map<string, number>();

  // lib files reachable from what was just written
  const importedBy = new Map<string, Set<string>>();
  const queue = writtenPaths.map((p) => ({ path: p, root: p }));
  const visited = new Set<string>();
  while (queue.length) {
    const { path, root } = queue.shift()!;
    if (visited.has(`${root}\0${path}`)) continue;
    visited.add(`${root}\0${path}`);
    const r = byPath.get(path);
    if (!r) continue;
    for (const dep of importsOf(path, r.content)) {
      if (!byPath.has(dep)) continue;
      let set = importedBy.get(dep);
      if (!set) importedBy.set(dep, (set = new Set()));
      set.add(root);
      queue.push({ path: dep, root });
    }
  }

  const now = Date.now();
  const out: ChangedUnderYou[] = [];
  for (const r of rows) {
    const version = Number(r.version);
    const saw = mine.get(r.path);
    const byOther = r.updated_by_agent !== s.id && !!(r.updated_by_agent || r.updated_by_user);
    if (!byOther) continue;
    const deps = importedBy.get(r.path);
    const changed = saw !== undefined ? version > saw : !!deps && now - new Date(r.updated_at).getTime() < RECENT_MS;
    if (!changed) continue;
    const by = r.client_name ? nameOf({ id: "", clientName: r.client_name, label: r.label ?? undefined }) : (r.user_name ?? "someone");
    out.push({ path: r.path, youSaw: saw ?? null, now: version, by, ...(deps ? { importedBy: [...deps].filter((p) => p !== r.path).sort() } : {}) });
  }
  return out;
}
