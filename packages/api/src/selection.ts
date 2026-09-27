// Entity sets: selectors, filters (.planar(), .parallelTo(), .largest()) and set operations.
// A set belongs to one op result; used on a downstream solid it is re-resolved by stable name.
import type { EntityKind, Vec3 } from "@parasocial/kernel";
import { entityName, nameIndex, select, faceOf, edgeOf, vertexOf, centerOf, directionOf, dot, dist, SelectorError, type OpRecord } from "@parasocial/naming";
import { axisVec, type AxisLike } from "./plane";
import { userError, warn } from "./op";

/** A read-only view of one entity for filter/sort callbacks. */
export type Entity = {
  kind: EntityKind;
  index: number;
  name: string;
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

export function entityView(r: OpRecord, kind: EntityKind, i: number): Entity {
  const base = { kind, index: i, get name() { return entityName(r, kind, i).str; } } as Entity;
  if (kind === "face") {
    const f = faceOf(r, i);
    return Object.assign(base, { center: f.center, area: f.area, normal: f.normal, surface: f.surface, radius: f.radius, axis: f.axis });
  }
  if (kind === "edge") {
    const e = edgeOf(r, i);
    return Object.assign(base, { center: e.mid, length: e.length, curve: e.curve, direction: e.direction, radius: e.radius, axis: e.axis });
  }
  const p = vertexOf(r, i);
  return Object.assign(base, { center: p, point: p });
}

type SortKey = "area" | "length" | "radius" | "x" | "y" | "z" | ((e: Entity) => number);

export class EntitySet {
  /** @internal */ readonly record: OpRecord;
  readonly kind: EntityKind;
  /** @internal */ readonly indices: readonly number[];
  /** Selector that produced this set, when it came from a string (kept for notes / describe). */
  readonly query?: string;

  constructor(record: OpRecord, kind: EntityKind, indices: readonly number[], query?: string) {
    this.record = record;
    this.kind = kind;
    this.indices = Object.freeze([...new Set(indices)].sort((a, b) => a - b));
    this.query = query;
    Object.freeze(this);
  }

  static fromSelector(r: OpRecord, kind: EntityKind, selector?: string): EntitySet {
    if (selector === undefined || selector === "*") return new EntitySet(r, kind, [...Array(countOf(r, kind)).keys()], selector);
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

  get length() {
    return this.indices.length;
  }
  get count() {
    return this.indices.length;
  }

  private derive(idx: number[]) {
    return new EntitySet(this.record, this.kind, idx, this.query);
  }

  /** Narrow with another selector string. */
  query_(selector: string): EntitySet {
    return this.derive(select(this.record, this.kind, selector, [...this.indices]));
  }
  /** Narrow with another selector string (alias of `.filter(selector)`). */
  where(selector: string): EntitySet {
    return this.query_(selector);
  }

  filterBy(pred: string | ((e: Entity) => boolean)): EntitySet {
    if (typeof pred === "string") return this.query_(pred);
    return this.derive(this.indices.filter((i) => pred(entityView(this.record, this.kind, i))));
  }
  filter(pred: string | ((e: Entity) => boolean)) {
    return this.filterBy(pred);
  }

  planar() {
    return this.derive(this.indices.filter((i) => (this.kind === "face" ? faceOf(this.record, i).surface === "plane" : this.kind === "edge" ? edgeOf(this.record, i).curve === "line" : true)));
  }
  ofType(type: string) {
    return this.query_(`%${type}`);
  }
  parallelTo(axis: AxisLike) {
    const a = axisVec(axis);
    return this.derive(this.indices.filter((i) => {
      const d = directionOf(this.record, this.kind, i);
      return !!d && Math.abs(dot(d, a)) > 1 - 1e-6;
    }));
  }
  perpendicularTo(axis: AxisLike) {
    const a = axisVec(axis);
    return this.derive(this.indices.filter((i) => {
      const d = directionOf(this.record, this.kind, i);
      return !!d && Math.abs(dot(d, a)) < 1e-6;
    }));
  }

  sortBy(key: SortKey, dir: "asc" | "desc" = "asc"): EntitySet {
    const f = typeof key === "function" ? key : keyFn(key);
    const vals = new Map(this.indices.map((i) => [i, f(entityView(this.record, this.kind, i))]));
    const sorted = [...this.indices].sort((a, b) => (vals.get(a)! - vals.get(b)!) * (dir === "asc" ? 1 : -1));
    // sorted sets keep their order for first()/at(); store order via a fresh ordered set
    return new OrderedSet(this.record, this.kind, sorted, this.query);
  }
  largest(n = 1) {
    return this.sortBy(this.kind === "edge" ? "length" : "area", "desc").first(n);
  }
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
  first(n = 1) {
    return this.derive(this.ordered().slice(0, n));
  }
  last(n = 1) {
    return this.derive(this.ordered().slice(-n));
  }
  at(i: number) {
    const o = this.ordered();
    const j = i < 0 ? o.length + i : i;
    if (j < 0 || j >= o.length) userError(`index ${i} is out of range: the set has ${o.length} ${this.kind}s`);
    return this.derive([o[j]]);
  }
  /** Entity closest to a point. */
  nearest(p: Vec3) {
    let best = -1,
      bd = Infinity;
    for (const i of this.indices) {
      const d = dist(centerOf(this.record, this.kind, i), p);
      if (d < bd) (bd = d), (best = i);
    }
    return this.derive(best >= 0 ? [best] : []);
  }

  and(o: EntitySet) {
    const other = new Set(o.in(this.record));
    return this.derive(this.indices.filter((i) => other.has(i)));
  }
  or(o: EntitySet) {
    return this.derive([...this.indices, ...o.in(this.record)]);
  }
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
