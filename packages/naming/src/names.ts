// Stable names from element maps (PLAN §4):
//   face:   `opId · role · sourceName`       e.g. `bracket/base · side · outline/right`
//           inherited unchanged through ops that only modify it (fillet, boolean, ...)
//   edge:   `(faceA) & (faceB)`              named by the faces around it (sorted)
//   vertex: `(faceA) & (faceB) & (faceC)`
// Names are built lazily and memoized per record. Splits share a name: a name resolves
// to all of its descendants.
import type { EntityKind } from "@parasocial/kernel";
import { entityCount, type EntityName, type OpRecord } from "./record";

const SEP = " · ";

export function tokenize(s: string): string[] {
  return s
    .split(/[\s·/.()&]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const isCompound = (s: string) => s.includes(SEP) || s.includes("&");
const wrap = (s: string) => (isCompound(s) ? `(${s})` : s);

export function names(r: OpRecord, kind: EntityKind): EntityName[] {
  r._names ??= {};
  let arr = r._names[kind];
  if (!arr) {
    arr = new Array(entityCount(r, kind));
    r._names[kind] = arr;
  }
  for (let i = 0; i < arr.length; i++) if (!arr[i]) arr[i] = compute(r, kind, i);
  return arr;
}

export function entityName(r: OpRecord, kind: EntityKind, i: number): EntityName {
  r._names ??= {};
  let arr = r._names[kind];
  if (!arr) {
    arr = new Array(entityCount(r, kind));
    r._names[kind] = arr;
  }
  return (arr[i] ??= compute(r, kind, i));
}

function opHead(r: OpRecord) {
  return tokenize(r.id);
}

function compute(r: OpRecord, kind: EntityKind, i: number): EntityName {
  // explicit names; for edges/vertices, roles are explicit names too (sketch segments)
  const explicit = r.explicit?.[kind]?.[i] ?? (kind !== "face" ? r.roles[kind]?.[i] : undefined);
  if (explicit) return { str: explicit, head: tokenize(explicit), creator: r.id };
  if (kind === "face") return faceName(r, i);
  if (kind === "edge") return edgeName(r, i);
  return vertexName(r, i);
}

function faceName(r: OpRecord, i: number): EntityName {
  const origins = r.history.face[i] ?? [];
  const role = r.roles.face?.[i];
  if (role) {
    const gen = origins.find((o) => o.rel === "generated");
    if (gen) {
      const src = entityName(r.inputs[gen.slot], gen.kind, gen.index);
      const srcHead = isCompound(src.str) ? [] : src.head;
      return { str: `${r.id}${SEP}${role}${SEP}${wrap(src.str)}`, head: [...opHead(r), ...tokenize(role), ...srcHead], creator: r.id };
    }
    return { str: `${r.id}${SEP}${role}`, head: [...opHead(r), ...tokenize(role)], creator: r.id };
  }
  // inherit through same/modified, preferring the primary input (slot 0)
  const inh = [...origins].filter((o) => o.kind === "face" && o.rel !== "generated").sort((a, b) => a.slot - b.slot || a.index - b.index)[0];
  if (inh) return entityName(r.inputs[inh.slot], "face", inh.index);
  const gen = origins.find((o) => o.rel === "generated");
  if (gen) {
    const src = entityName(r.inputs[gen.slot], gen.kind, gen.index);
    return { str: `${r.id}${SEP}${r.type}${SEP}${wrap(src.str)}`, head: [...opHead(r), r.type], creator: r.id };
  }
  return { str: `${r.id}${SEP}face${i}`, head: [...opHead(r), `face${i}`], creator: r.id };
}

function edgeName(r: OpRecord, i: number): EntityName {
  const faces = r.topo.edgeFaces[i] ?? [];
  const fnames = [...new Set(faces.map((f) => entityName(r, "face", f).str))].sort();
  if (fnames.length >= 2) {
    return { str: fnames.map((n) => `(${n})`).join(" & "), head: [], creator: commonCreator(r, faces) };
  }
  // seam / boundary / wire edges: inherit if possible, else qualify the single face
  const origins = r.history.edge[i] ?? [];
  const inh = origins.filter((o) => o.kind === "edge").sort((a, b) => a.slot - b.slot || a.index - b.index)[0];
  if (inh) {
    const n = entityName(r.inputs[inh.slot], "edge", inh.index);
    if (fnames.length === 0) return n;
  }
  if (fnames.length === 1) {
    // in a solid every edge bounds two face-sides; a single adjacent face means a seam
    const seam = faces.length === 1;
    return { str: `(${fnames[0]})${SEP}${seam ? "seam" : "boundary"}`, head: [], creator: commonCreator(r, faces) };
  }
  return { str: `${r.id}${SEP}edge${i}`, head: [...opHead(r), `edge${i}`], creator: r.id };
}

function vertexName(r: OpRecord, i: number): EntityName {
  const faces = new Set<number>();
  for (const e of r.topo.vertexEdges[i] ?? []) for (const f of r.topo.edgeFaces[e] ?? []) faces.add(f);
  const fnames = [...new Set([...faces].map((f) => entityName(r, "face", f).str))].sort();
  if (fnames.length) return { str: fnames.map((n) => `(${n})`).join(" & "), head: [], creator: commonCreator(r, [...faces]) };
  const origins = r.history.vertex[i] ?? [];
  const inh = origins.find((o) => o.kind === "vertex");
  if (inh) return entityName(r.inputs[inh.slot], "vertex", inh.index);
  return { str: `${r.id}${SEP}vertex${i}`, head: [...opHead(r), `vertex${i}`], creator: r.id };
}

/** The most recent op among the adjacent faces' creators (edges belong to whoever last shaped them). */
function commonCreator(r: OpRecord, faces: number[]): string {
  const creators = faces.map((f) => entityName(r, "face", f).creator);
  // prefer a creator that isn't the root primitive: the latest op in input order
  const order = opOrder(r);
  let best = creators[0] ?? r.id;
  for (const c of creators) if ((order.get(c) ?? -1) > (order.get(best) ?? -1)) best = c;
  return best;
}

const orderCache = new WeakMap<OpRecord, Map<string, number>>();
/** Topological order of ops feeding `r` (later = larger). */
export function opOrder(r: OpRecord): Map<string, number> {
  let m = orderCache.get(r);
  if (m) return m;
  m = new Map();
  let n = 0;
  const visit = (x: OpRecord) => {
    if (m!.has(x.id)) return;
    for (const i of x.inputs) visit(i);
    m!.set(x.id, n++);
  };
  visit(r);
  orderCache.set(r, m);
  return m;
}

/** All ops feeding `r`, including itself, in topological order. */
const lineageCache = new WeakMap<OpRecord, OpRecord[]>();
export function lineage(r: OpRecord): OpRecord[] {
  const cached = lineageCache.get(r);
  if (cached) return cached;
  const seen = new Set<OpRecord>();
  const out: OpRecord[] = [];
  const visit = (x: OpRecord) => {
    if (seen.has(x)) return;
    seen.add(x);
    for (const i of x.inputs) visit(i);
    out.push(x);
  };
  visit(r);
  lineageCache.set(r, out);
  return out;
}

/** Map from name string -> entity indices (splits give several). */
export function nameIndex(r: OpRecord, kind: EntityKind): Map<string, number[]> {
  const m = new Map<string, number[]>();
  names(r, kind).forEach((n, i) => {
    const l = m.get(n.str);
    if (l) l.push(i);
    else m.set(n.str, [i]);
  });
  return m;
}
