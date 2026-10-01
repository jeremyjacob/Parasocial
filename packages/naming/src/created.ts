// History-based queries (Onshape's qCreatedBy): which operation first made each entity.
// An entity's creator is found by walking its history back through ops that only kept or modified
// it (booleans trimming a face, fillets shortening an edge, moves, pattern copies) until an op made
// it from something else or from nothing: an extrude's side faces (from profile edges), a fillet's
// faces and their boundary edges, the new edges where a boolean's inputs intersect.
import type { EntityKind } from "@parasocial/kernel";
import type { OpRecord } from "./record";
import { lineage } from "./names";
import { SelectorError } from "./query";

/** Ops whose inputs are 2D/wire construction geometry: entities coming from them are created by the consumer. */
const CONSTRUCTION = new Set(["sketch", "offset", "path"]);
/** Pure transforms map entity i to entity i (copies mark it "generated" to rename it): same entity. */
const TRANSFORMS = new Set(["translate", "rotate", "mirror", "copy"]);

const memo = new WeakMap<OpRecord, Partial<Record<EntityKind, string[][]>>>();

/** Ids of the op(s) that created entity `i` of `kind` in `r` (several when a merge joined entities from different ops). */
export function creatorsOf(r: OpRecord, kind: EntityKind, i: number): string[] {
  let m = memo.get(r);
  if (!m) memo.set(r, (m = {}));
  const arr = (m[kind] ??= []);
  const hit = arr[i];
  if (hit) return hit;
  const out = new Set<string>();
  for (const o of r.history[kind][i] ?? []) {
    if (o.kind !== kind) continue;
    if (o.rel === "generated" && !TRANSFORMS.has(r.type)) continue;
    const src = r.inputs[o.slot];
    if (!src || CONSTRUCTION.has(src.type)) continue;
    for (const c of creatorsOf(src, kind, o.index)) out.add(c);
  }
  if (!out.size) out.add(r.id);
  return (arr[i] = [...out]);
}

/** Does op id `id` answer to `q` (full id `part/tag`, its tag, or a trailing path like `helper/union1`)? */
export function opMatches(id: string, q: string): boolean {
  return id === q || id.endsWith("/" + q);
}

/**
 * Ids of the ops feeding `r` (itself included) that `q` names. Throws a SelectorError listing the
 * tagged ops when nothing matches, so a typo doesn't silently select nothing.
 */
export function resolveOps(r: OpRecord, q: string): Set<string> {
  const ops = lineage(r).filter((x) => !CONSTRUCTION.has(x.type));
  const ids = new Set(ops.filter((x) => opMatches(x.id, q)).map((x) => x.id));
  if (!ids.size) {
    const tags = [...new Set(ops.map((x) => x.tag).filter(Boolean))];
    throw new SelectorError(`no operation "${q}" made this solid${tags.length ? `; tagged operations: ${tags.slice(0, 12).join(", ")}` : "; give the operation a { tag } to refer to it"}`);
  }
  return ids;
}

/** Indices of `kind` entities in `r` created by any op in `ops` (ids), optionally within `domain`. */
export function createdBy(r: OpRecord, kind: EntityKind, ops: Set<string>, domain?: number[]): number[] {
  const all = domain ?? [...Array(kind === "face" ? r.topo.faces.size : kind === "edge" ? r.topo.edges.size : r.topo.vertices.size).keys()];
  return all.filter((i) => creatorsOf(r, kind, i).some((c) => ops.has(c)));
}
