// Entity sets: selectors, filters (.planar(), .parallelTo(), .largest()) and set operations.
// A set belongs to one op result; used on a downstream solid it is re-resolved by stable name.
import type { EntityKind, Vec3 } from "@parasocial/kernel";
import { entityName, nameIndex, select, isSeamEdge, faceOf, edgeOf, vertexOf, centerOf, edgeCenter, directionOf, dot, dist, SelectorError, createdBy, resolveOps, lineage, type OpRecord } from "@parasocial/naming";
import { axisVec, type AxisLike } from "./plane";
import { userError, warn } from "./op";

/** A read-only view of one entity for filter/sort callbacks. */
export type Entity = {
  kind: EntityKind;
  index: number;
  name: string;
  /** Face centroid, edge midpoint (a full circle's center), vertex point. Used by nearest, sortBy "x"/"y"/"z" and ">Z". */
  center: Vec3;
  /** faces */
  area?: number;
  normal?: Vec3;
  surface?: string;
  /** edges */
  length?: number;
  curve?: string;
  direction?: Vec3;
  radius?: number;
  axis?: Vec3;
  /** vertices */
  point?: Vec3;
};

/** @internal */
export function entityView(r: OpRecord, kind: EntityKind, i: number): Entity {
  const base = { kind, index: i, get name() { return entityName(r, kind, i).str; } } as Entity;
  if (kind === "face") {
    const f = faceOf(r, i);
    return Object.assign(base, { center: f.center, area: f.area, normal: f.normal, surface: f.surface, radius: f.radius, axis: f.axis });
  }
  if (kind === "edge") {
    const e = edgeOf(r, i);
    return Object.assign(base, { center: edgeCenter(e), length: e.length, curve: e.curve, direction: e.direction, radius: e.radius, axis: e.axis });
  }
  const p = vertexOf(r, i);
  return Object.assign(base, { center: p, point: p });
}

/** An operation to query history by: its tag (`"finUnion"`), its id (`"winch/finUnion"`), or the solid it returned. */
export type OpRef = string | { readonly id: string };

/** @internal Op ids named by `op` among the ops feeding `r`; a user error when one names nothing. */
export function opIds(r: OpRecord, op: OpRef | OpRef[]): Set<string> {
  const ids = new Set<string>();
  const lin = lineage(r);
  for (const o of Array.isArray(op) ? op : [op]) {
    if (typeof o === "string") {
      if (o.startsWith("@")) userError(`createdBy takes the tag without "@" (got "${o}"); "@${o.slice(1)}" is the selector-string form`);
      try {
        for (const id of resolveOps(r, o)) ids.add(id);
      } catch (e) {
        if (e instanceof SelectorError) userError(`createdBy: ${e.message}`);
        throw e;
      }
    } else if (o && typeof o === "object" && typeof o.id === "string") {
      if (!lin.some((x) => x.id === o.id)) userError(`createdBy: operation ${o.id} did not go into this solid`);
      ids.add(o.id);
    } else userError(`createdBy expects an operation tag like "finUnion" or a solid (got ${JSON.stringify(o)})`);
  }
  return ids;
}

type SortKey ="area" | "length" | "radius" | "x" | "y" | "z" | ((e: Entity) => number);

/**
 * An immutable set of faces, edges or vertices of one solid, from `solid.faces(selector)`,
 * `solid.edges(selector)` or `solid.vertices(selector)`. Every filter returns a new set; pass a set
 * to `fillet`, `chamfer`, `shell`, `draft`, `thicken`, `connector` or `measure`. A set taken from an
 * earlier solid still works on a later one: it is matched by stable name.
 *
 * Selector strings (also accepted by `.filter("…")`):
 * - names: `"base.side"`, `"bore"`, `"base.cap.end & bore"` — tags and roles in stable names. An
 *   edge or vertex matches when a face around it does, so `edges("bore & plate.cap.end")` is the rim
 *   where the two named faces meet (qualify a role like `cap.end` with its op tag).
 * - extremes: `">Z"` (largest center z), `"<X"` (smallest x), `">Z[1]"` (second highest), `">(1,1,0)"`.
 * - direction: `"|Z"` faces whose normal is parallel to Z (top and bottom) / edges along Z;
 *   `"#Z"` faces whose normal is perpendicular to Z (the sides) / edges perpendicular to Z;
 *   `"+Z"` / `"-Z"` planar faces facing +Z / −Z.
 * - type: `"%plane"`, `"%cylinder"`, `"%cone"`, `"%sphere"`, `"%torus"`, `"%bspline"` (faces);
 *   `"%line"`, `"%circle"`, `"%ellipse"`, `"%bspline"` (edges). `"*"` is everything.
 * - set operations: `a & b`, `a | b`, `a - b` (spaces around `-`), `not a`, parentheses.
 * @example base.fillet(base.edges("|Z"), 3) // round the 4 vertical edges of a box
 * @example const top = body.faces(">Z"); body.edges().filter((e) => e.center[2] > 9 && e.curve === "circle")
 */
export class EntitySet {
  /** @internal */ readonly record: OpRecord;
  /** "face", "edge" or "vertex". */
  readonly kind: EntityKind;
  /** @internal */ readonly indices: readonly number[];
  /** Selector that produced this set, when it came from a string (kept for notes / describe). */
  readonly query?: string;

  /** @internal */
  constructor(record: OpRecord, kind: EntityKind, indices: readonly number[], query?: string) {
    this.record = record;
    this.kind = kind;
    this.indices = Object.freeze([...new Set(indices)].sort((a, b) => a - b));
    this.query = query;
    Object.freeze(this);
  }

  /** @internal */
  static fromSelector(r: OpRecord, kind: EntityKind, selector?: string): EntitySet {
    if (selector === undefined || selector === "*") return new EntitySet(r, kind, [...Array(countOf(r, kind)).keys()].filter((i) => kind !== "edge" || !isSeamEdge(r, i)), selector);
    let idx: number[];
    try {
      idx = select(r, kind, selector);
    } catch (e) {
      if (e instanceof SelectorError) userError(e.message);
      throw e;
    }
    if (!idx.length) warn(`selector "${selector}" matched no ${kind}s`);
    return new EntitySet(r, kind, idx, selector);
  }

  /** Number of entities in the set (0 when nothing matched; an empty selector match also warns). */
  get length() {
    return this.indices.length;
  }
  /** Alias of `length`. */
  get count() {
    return this.indices.length;
  }

  private derive(idx: number[]) {
    return new EntitySet(this.record, this.kind, idx, this.query);
  }

  /** @internal Narrow with another selector string (use `.filter(selector)`). */
  query_(selector: string): EntitySet {
    return this.derive(select(this.record, this.kind, selector, [...this.indices]));
  }
  /** Narrow with another selector string (same as `.filter(selector)`). */
  where(selector: string): EntitySet {
    return this.query_(selector);
  }

  /** Alias of `.filter(pred)`. */
  filterBy(pred: string | ((e: Entity) => boolean)): EntitySet {
    if (typeof pred === "string") return this.query_(pred);
    return this.derive(this.indices.filter((i) => pred(entityView(this.record, this.kind, i))));
  }
  /**
   * Keep the entities that match a selector string (see `EntitySet`), or for which `pred` returns
   * true. `pred` gets an `Entity` view: `center`, plus `area`/`normal`/`surface` (faces),
   * `length`/`direction`/`curve` (edges), `radius`/`axis` (circular ones), `point` (vertices), `name`.
   * @example body.edges().filter((e) => e.curve === "circle" && Math.abs((e.radius ?? 0) - 3) < 1e-6)
   * @example body.faces().filter("%plane & not >Z")
   */
  filter(pred: string | ((e: Entity) => boolean)) {
    return this.filterBy(pred);
  }

  /** Planar faces (surface "plane"), or straight edges (curve "line"); vertices pass through. */
  planar() {
    return this.derive(this.indices.filter((i) => (this.kind === "face" ? faceOf(this.record, i).surface === "plane" : this.kind === "edge" ? edgeOf(this.record, i).curve === "line" : true)));
  }
  /** Faces of a surface type ("plane", "cylinder", "cone", "sphere", "torus", "bspline") or edges of a curve type ("line", "circle", "ellipse", "bspline"); same as `.filter("%type")`. */
  ofType(type: string) {
    return this.query_(`%${type}`);
  }
  /**
   * Edges whose direction is parallel to `axis` (either sense); faces whose **normal** is parallel to
   * it (planar: the faces facing ±axis) or whose axis is (cylinders around it). Same as `"|Z"`.
   * @example box(10, 20, 30).faces().parallelTo("Z") // top and bottom
   */
  parallelTo(axis: AxisLike) {
    const a = axisVec(axis);
    return this.derive(this.indices.filter((i) => {
      const d = directionOf(this.record, this.kind, i);
      return !!d && Math.abs(dot(d, a)) > 1 - 1e-6;
    }));
  }
  /** Edges perpendicular to `axis`; faces whose normal (or axis) is perpendicular to it (for "Z": the side walls). Same as `"#Z"`. */
  perpendicularTo(axis: AxisLike) {
    const a = axisVec(axis);
    return this.derive(this.indices.filter((i) => {
      const d = directionOf(this.record, this.kind, i);
      return !!d && Math.abs(dot(d, a)) < 1e-6;
    }));
  }

  /**
   * Order by "area", "length", "radius", center "x" / "y" / "z", or a function of the `Entity`;
   * `first`/`last`/`at` then follow that order.
   * @example body.faces("%plane").sortBy("z", "desc").at(1) // second-highest planar face
   */
  sortBy(key: SortKey, dir: "asc" | "desc" = "asc"): EntitySet {
    const f = typeof key === "function" ? key : keyFn(key);
    const vals = new Map(this.indices.map((i) => [i, f(entityView(this.record, this.kind, i))]));
    const sorted = [...this.indices].sort((a, b) => (vals.get(a)! - vals.get(b)!) * (dir === "asc" ? 1 : -1));
    // sorted sets keep their order for first()/at(); store order via a fresh ordered set
    return new OrderedSet(this.record, this.kind, sorted, this.query);
  }
  /** The `n` largest faces by area (edges: by length). */
  largest(n = 1) {
    return this.sortBy(this.kind === "edge" ? "length" : "area", "desc").first(n);
  }
  /** The `n` smallest faces by area (edges: by length). */
  smallest(n = 1) {
    return this.sortBy(this.kind === "edge" ? "length" : "area", "asc").first(n);
  }
  /** Group by a numeric key (tolerance 1e-6) -> sets, in ascending key order. */
  groupBy(key: SortKey, tolerance = 1e-6): EntitySet[] {
    const f = typeof key === "function" ? key : keyFn(key);
    const vals = this.indices.map((i) => ({ i, v: f(entityView(this.record, this.kind, i)) })).sort((a, b) => a.v - b.v);
    const groups: number[][] = [];
    let last = NaN;
    for (const x of vals) {
      if (groups.length && Math.abs(x.v - last) <= tolerance) groups[groups.length - 1].push(x.i);
      else groups.push([x.i]);
      last = x.v;
    }
    return groups.map((g) => this.derive(g));
  }
  /** The first `n` (in `sortBy` order, else by internal index — sort first when order matters). */
  first(n = 1) {
    return this.derive(this.ordered().slice(0, n));
  }
  /** The last `n` (in `sortBy` order, else by internal index). */
  last(n = 1) {
    return this.derive(this.ordered().slice(-n));
  }
  /** The `i`-th entity (negative counts from the end) as a one-entity set; sort first when order matters. */
  at(i: number) {
    const o = this.ordered();
    const j = i < 0 ? o.length + i : i;
    if (j < 0 || j >= o.length) userError(`index ${i} is out of range: the set has ${o.length} ${this.kind}s`);
    return this.derive([o[j]]);
  }
  /** The one entity whose center is closest to world point `p`. */
  nearest(p: Vec3) {
    let best = -1,
      bd = Infinity;
    for (const i of this.indices) {
      const d = dist(centerOf(this.record, this.kind, i), p);
      if (d < bd) (bd = d), (best = i);
    }
    return this.derive(best >= 0 ? [best] : []);
  }

  // ---------- history ----------
  /**
   * Keep the entities that operation `op` created (Onshape's qCreatedBy). `op` is a tag
   * (`"finUnion"`), an op id (`"winch/finUnion"`), or the solid that op returned; several are OR-ed.
   * What an op creates: extrude/revolve/sweep/loft — side faces, caps and their edges; fillet/chamfer —
   * the new faces and their boundary edges; union/subtract/intersect — the new edges where the inputs
   * intersect (faces and edges they only trimmed keep their original creator); pattern copies count
   * as the op that made the original. Survives later edits: it reads OCCT history, not coordinates.
   * Selector form: `"@finUnion"` or `"createdBy(finUnion)"`, e.g. `body.fillet("@finUnion", 1.5)`.
   * @example body.union(boss, { tag: "finUnion" }).edges().createdBy("finUnion") // where the boss meets the body
   */
  createdBy(op: OpRef | OpRef[]): EntitySet {
    return this.derive(createdBy(this.record, this.kind, opIds(this.record, op), [...this.indices]));
  }

  // ---------- adjacency ----------
  /** Faces touching these entities: the faces of an edge or vertex; for faces, their neighbours across an edge. */
  faces(): EntitySet {
    return this.neighbours("face");
  }
  /** Edges touching these entities: a face's boundary edges, a vertex's edges; for edges, those sharing a vertex. */
  edges(): EntitySet {
    return this.neighbours("edge");
  }
  /** Vertices of these faces or edges; for vertices, those one edge away. */
  vertices(): EntitySet {
    return this.neighbours("vertex");
  }
  /**
   * Keep the entities touching `other` (a selection on this solid or upstream of it): edges of the
   * given faces, faces along the given edges, faces sharing an edge with the given faces, …
   * Members of `other` itself are left out. Alias: `.of(other)`.
   * @example body.edges().adjacentTo(body.faces("fin.side")) // every edge around the fin's sides
   */
  adjacentTo(other: EntitySet): EntitySet {
    if (!(other instanceof EntitySet)) userError("adjacentTo(other) expects a selection like solid.faces(\">Z\")");
    const near = new Set(other.neighbourIndices(this.kind, this.record));
    return this.derive(this.indices.filter((i) => near.has(i)));
  }
  /** Alias of `adjacentTo`: `solid.edges().of(solid.faces(">Z"))` reads "the edges of the top face". */
  of(other: EntitySet): EntitySet {
    return this.adjacentTo(other);
  }

  private neighbours(kind: EntityKind): EntitySet {
    return new EntitySet(this.record, kind, this.neighbourIndices(kind));
  }

  /** @internal indices of `kind` entities on this set's record touching any member (members excluded when same kind) */
  neighbourIndices(kind: EntityKind, target: OpRecord = this.record): number[] {
    const t = target.topo;
    const mine = target === this.record ? [...this.indices] : this.in(target);
    const facesOfV = (v: number) => (t.vertexEdges[v] ?? []).flatMap((e) => t.edgeFaces[e] ?? []);
    const vertsOfF = (f: number) => (t.faceEdges[f] ?? []).flatMap((e) => t.edgeVertices[e] ?? []);
    const step = (from: EntityKind, i: number): number[] => {
      if (from === "face") return kind === "edge" ? (t.faceEdges[i] ?? []) : kind === "vertex" ? vertsOfF(i) : (t.faceEdges[i] ?? []).flatMap((e) => t.edgeFaces[e] ?? []);
      if (from === "edge") return kind === "face" ? (t.edgeFaces[i] ?? []) : kind === "vertex" ? (t.edgeVertices[i] ?? []) : (t.edgeVertices[i] ?? []).flatMap((v) => t.vertexEdges[v] ?? []);
      return kind === "edge" ? (t.vertexEdges[i] ?? []) : kind === "face" ? facesOfV(i) : (t.vertexEdges[i] ?? []).flatMap((e) => t.edgeVertices[e] ?? []);
    };
    const out = new Set(mine.flatMap((i) => step(this.kind, i)));
    if (kind === this.kind) for (const i of mine) out.delete(i);
    if (kind === "edge") for (const e of [...out]) if (isSeamEdge(target, e)) out.delete(e);
    return [...out];
  }

  /** Entities in both sets (intersection). */
  and(o: EntitySet) {
    const other = new Set(o.in(this.record));
    return this.derive(this.indices.filter((i) => other.has(i)));
  }
  /** Entities in either set (union). */
  or(o: EntitySet) {
    return this.derive([...this.indices, ...o.in(this.record)]);
  }
  /** Entities in this set but not in `o`. */
  minus(o: EntitySet) {
    const other = new Set(o.in(this.record));
    return this.derive(this.indices.filter((i) => !other.has(i)));
  }

  /** Stable names of the entities. */
  names(): string[] {
    return this.indices.map((i) => entityName(this.record, this.kind, i).str);
  }
  /** Entity views, for inspection in scripts. */
  list(): Entity[] {
    return this.ordered().map((i) => entityView(this.record, this.kind, i));
  }

  /** @internal ordered indices (sorted sets keep sort order) */
  ordered(): number[] {
    return [...this.indices];
  }

  /**
   * Indices of the same entities in `target` (a downstream result), matched by stable name.
   * A name that split resolves to all of its descendants.
   * @internal
   */
  in(target: OpRecord): number[] {
    if (target === this.record) return [...this.indices];
    const idx = nameIndex(target, this.kind);
    const out: number[] = [];
    const missing: string[] = [];
    for (const i of this.indices) {
      const n = entityName(this.record, this.kind, i).str;
      const hit = idx.get(n);
      if (hit) out.push(...hit);
      else missing.push(n);
    }
    if (missing.length) {
      userError(`${missing.length} selected ${this.kind}${missing.length > 1 ? "s" : ""} no longer exist${missing.length > 1 ? "" : "s"} on this solid (${missing.slice(0, 2).join("; ")}). Select them from the solid you are modifying`);
    }
    return [...new Set(out)];
  }
}

/** A set that remembers an explicit order (after sortBy). */
class OrderedSet extends EntitySet {
  #order: number[];
  constructor(r: OpRecord, k: EntityKind, order: number[], q?: string) {
    super(r, k, order, q);
    this.#order = order;
  }
  override ordered() {
    return [...this.#order];
  }
}

function keyFn(k: Exclude<SortKey, Function>): (e: Entity) => number {
  switch (k) {
    case "area":
      return (e) => e.area ?? 0;
    case "length":
      return (e) => e.length ?? 0;
    case "radius":
      return (e) => e.radius ?? 0;
    case "x":
      return (e) => e.center[0];
    case "y":
      return (e) => e.center[1];
    case "z":
      return (e) => e.center[2];
  }
}

function countOf(r: OpRecord, kind: EntityKind) {
  return kind === "face" ? r.topo.faces.size : kind === "edge" ? r.topo.edges.size : r.topo.vertices.size;
}
