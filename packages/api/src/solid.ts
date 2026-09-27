// Solids: finishing, booleans, transforms, patterns, inspection (PLAN §5 v1 surface).
import { fillet as kFillet, booleanMany as kBooleanMany, chamfer as kChamfer, boolean as kBoolean, transform as kTransform, box as kBox, cylinder as kCylinder, compound, massProps as kMass, boundingBox as kBBox, isValid as kValid, distance as kDistance, identityHistory, faceInfo, type Vec3, type KernelError, type BBox, type EntityKind } from "@parasocial/kernel";
import { entityShape, entityName, faceOf, edgeOf, vertexOf, type OpRecord } from "@parasocial/naming";
import { runOp, userError } from "./op";
import { EntitySet } from "./selection";
import { Plane, axisVec, vec, type AxisLike } from "./plane";
import type { ColorSpec, Material } from "./types";

type EdgesArg = EntitySet | EntitySet[] | string;
type FacesArg = EntitySet | EntitySet[] | string;
type OpOpts = { tag?: string };

export class Solid {
  /** @internal */ readonly record: OpRecord;
  /** @internal */ readonly meta: { color?: ColorSpec; material?: Material };

  constructor(record: OpRecord, meta: Solid["meta"] = {}) {
    this.record = record;
    this.meta = meta;
    Object.freeze(this);
  }

  /** Stable id of the operation that produced this solid. */
  get id() {
    return this.record.id;
  }

  // ---------- selection ----------
  faces(selector?: string): EntitySet {
    return EntitySet.fromSelector(this.record, "face", selector);
  }
  edges(selector?: string): EntitySet {
    return EntitySet.fromSelector(this.record, "edge", selector);
  }
  vertices(selector?: string): EntitySet {
    return EntitySet.fromSelector(this.record, "vertex", selector);
  }

  // ---------- finishing ----------
  /** Constant-radius fillet on `edges` (a selection, or a selector string evaluated on this solid). */
  fillet(edges: EdgesArg, radius: number, opts: OpOpts = {}): Solid {
    positive(radius, "fillet radius");
    const idx = this.resolve(edges, "edge", "fillet");
    const input = this.record;
    const rec = runOp({
      type: "fillet",
      tag: opts.tag,
      params: { edges: idx, radius },
      inputs: [input],
      build: () => ({
        built: kFillet(input.shape, idx.map((i) => entityShape(input, "edge", i)), radius),
        historyOptions: { generatedFrom: ["edge", "vertex"] },
        roles: ({ history }) => ({ face: history.face.map((o) => (o.some((x) => x.rel === "generated" && x.kind === "edge") ? "fillet" : o.some((x) => x.rel === "generated" && x.kind === "vertex") ? "fillet.corner" : undefined)) }),
      }),
      highlight: () => ({ kind: "edge", names: idx.map((i) => entityName(input, "edge", i).str) }),
      explain: () => explainRadius("fillet radius", radius, input, idx),
    });
    return new Solid(rec, this.meta);
  }

  /** Chamfer `edges` by `distance` (optionally a second distance, or a distance and an `angle` in degrees). */
  chamfer(edges: EdgesArg, distance: number, opts: OpOpts & { distance2?: number; angle?: number } = {}): Solid {
    positive(distance, "chamfer distance");
    const idx = this.resolve(edges, "edge", "chamfer");
    const input = this.record;
    const rec = runOp({
      type: "chamfer",
      tag: opts.tag,
      params: { edges: idx, distance, distance2: opts.distance2, angle: opts.angle },
      inputs: [input],
      build: () => ({
        built: kChamfer(input.shape, idx.map((i) => entityShape(input, "edge", i)), distance, opts.distance2, opts.angle === undefined ? undefined : (opts.angle * Math.PI) / 180),
        historyOptions: { generatedFrom: ["edge", "vertex"] },
        roles: ({ history }) => ({ face: history.face.map((o) => (o.some((x) => x.rel === "generated") ? "chamfer" : undefined)) }),
      }),
      highlight: () => ({ kind: "edge", names: idx.map((i) => entityName(input, "edge", i).str) }),
      explain: () => explainRadius("chamfer distance", distance, input, idx),
    });
    return new Solid(rec, this.meta);
  }

  // ---------- booleans ----------
  union(...others: (Solid | OpOpts)[]): Solid {
    return booleanOp("union", this, ...splitOpts(others));
  }
  subtract(...others: (Solid | OpOpts)[]): Solid {
    return booleanOp("subtract", this, ...splitOpts(others));
  }
  /** Alias of subtract (CadQuery). */
  cut(...others: (Solid | OpOpts)[]): Solid {
    return this.subtract(...others);
  }
  intersect(...others: (Solid | OpOpts)[]): Solid {
    return booleanOp("intersect", this, ...splitOpts(others));
  }

  // ---------- transforms ----------
  translate(v: Vec3, opts: OpOpts = {}): Solid {
    return transformOp(this, "translate", { translate: v }, opts);
  }
  /** Alias of translate. */
  move(v: Vec3, opts: OpOpts = {}): Solid {
    return this.translate(v, opts);
  }
  /** Rotate by `angle` degrees about `axis` (default Z) through `origin` (default world origin). */
  rotate(angle: number, opts: OpOpts & { axis?: AxisLike; origin?: Vec3 } = {}): Solid {
    return transformOp(this, "rotate", { rotate: { origin: opts.origin ?? [0, 0, 0], axis: axisVec(opts.axis ?? "Z"), angleRad: (angle * Math.PI) / 180 } }, opts);
  }
  /** Mirror across a plane. `union: true` keeps the original and fuses the mirror image to it. */
  mirror(p: Plane | "XY" | "XZ" | "YZ", opts: OpOpts & { union?: boolean } = {}): Solid {
    const pl = typeof p === "string" ? ({ XY: new Plane([0, 0, 0], [0, 0, 1]), XZ: new Plane([0, 0, 0], [0, 1, 0]), YZ: new Plane([0, 0, 0], [1, 0, 0]) } as const)[p] : p;
    const m = transformOp(this, "mirror", { mirror: { origin: pl.origin, normal: pl.normal } }, opts.union ? {} : opts, "mirrored");
    return opts.union ? booleanOp("union", this, [m], { tag: opts.tag }) : m;
  }
  /** `count` copies spaced `spacing` along `direction`, fused (instance 0 keeps its names; others get `#k`). */
  linearPattern(direction: AxisLike, count: number, spacing: number, opts: OpOpts = {}): Solid {
    const d = axisVec(direction);
    return patternOp(this, count, (k) => ({ translate: vec.scale(d, spacing * k) }), opts);
  }
  /** `count` copies around `axis` (default Z through origin) over `angle` degrees (default 360, evenly spaced). */
  circularPattern(count: number, opts: OpOpts & { axis?: AxisLike; origin?: Vec3; angle?: number } = {}): Solid {
    const total = opts.angle ?? 360;
    const step = Math.abs(total - 360) < 1e-9 ? total / count : total / Math.max(1, count - 1);
    return patternOp(this, count, (k) => ({ rotate: { origin: opts.origin ?? [0, 0, 0], axis: axisVec(opts.axis ?? "Z"), angleRad: (step * k * Math.PI) / 180 } }), opts);
  }

  // ---------- appearance ----------
  color(c: ColorSpec | string): Solid {
    const spec: ColorSpec = typeof c === "string" ? { kind: "rgb", hex: c } : c;
    if (spec.kind === "rgb" && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(spec.hex)) userError(`color "${spec.hex}" must be a hex color like "#4a7bd0"`);
    return new Solid(this.record, { ...this.meta, color: spec });
  }
  material(m: Material | string): Solid {
    const mat = typeof m === "string" ? (MATERIALS[m.toLowerCase()] ?? userError(`unknown material "${m}"; use one of ${Object.keys(MATERIALS).join(", ")} or { density }`)) : m;
    return new Solid(this.record, { ...this.meta, material: mat });
  }

  // ---------- inspection ----------
  volume(): number {
    return kMass(this.record.shape).volume;
  }
  area(): number {
    return kMass(this.record.shape).area;
  }
  centerOfMass(): Vec3 {
    return kMass(this.record.shape).centroid;
  }
  boundingBox(): BBox & { size: Vec3 } {
    const b = kBBox(this.record.shape);
    return { ...b, size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] };
  }
  /** Mass in grams, from the material density (g/cm³; default 1). */
  mass(): number {
    return (this.volume() / 1000) * (this.meta.material?.density ?? 1);
  }
  isValid(): boolean {
    return kValid(this.record.shape);
  }

  /** @internal resolve an edges/faces argument to indices on this solid */
  resolve(arg: EdgesArg | FacesArg, kind: EntityKind, what: string): number[] {
    let idx: number[];
    if (typeof arg === "string") idx = [...EntitySet.fromSelector(this.record, kind, arg).indices];
    else if (Array.isArray(arg)) idx = [...new Set(arg.flatMap((s) => checkKind(s, kind, what).in(this.record)))];
    else if (arg instanceof EntitySet) idx = checkKind(arg, kind, what).in(this.record);
    else return userError(`${what} expects ${kind}s: a selection like base.${kind}s(">Z") or a selector string`);
    if (!idx.length) userError(`${what}: no ${kind}s selected`);
    return idx;
  }
}

function checkKind(s: EntitySet, kind: EntityKind, what: string) {
  if (!(s instanceof EntitySet)) userError(`${what} expects ${kind}s`);
  if (s.kind !== kind) userError(`${what} expects ${kind}s but got ${s.kind}s`);
  return s;
}

function positive(v: number, what: string) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) userError(`${what} must be a positive number (got ${v})`);
}

function splitOpts(args: (Solid | OpOpts)[]): [Solid[], OpOpts] {
  const solids = args.filter((a): a is Solid => a instanceof Solid);
  const opts = (args.find((a) => !(a instanceof Solid)) as OpOpts) ?? {};
  if (!solids.length) userError("boolean needs at least one other solid");
  return [solids, opts];
}

export function booleanOp(kind: "union" | "subtract" | "intersect", a: Solid, others: Solid[], opts: OpOpts): Solid {
  for (const b of others) if (!(b instanceof Solid)) userError(`${kind} expects solids`);
  const A = a.record;
  const tools = others.map((o) => o.record);
  const rec = runOp({
    type: kind,
    tag: opts.tag,
    params: {},
    inputs: [A, ...tools],
    build: () => ({ built: kBooleanMany(kind, A.shape, tools.map((t) => t.shape)), historyOptions: { generatedFrom: ["edge"] } }),
  });
  return new Solid(rec, a.meta);
}

function transformOp(s: Solid, type: string, t: Parameters<typeof kTransform>[1], opts: OpOpts, role?: string): Solid {
  const input = s.record;
  const rec = runOp({
    type,
    tag: opts.tag,
    params: { t, role },
    inputs: [input],
    build: () => {
      const built = kTransform(input.shape, t);
      built.maker?.delete?.();
      return {
        built: { shape: built.shape, maker: null },
        // a transform maps entity i to entity i; plain moves keep names, copies get a role
        history: (topo) => {
          const h = identityHistory(topo);
          if (role) for (const k of ["face", "edge", "vertex"] as const) for (const o of h[k]) for (const x of o) x.rel = "generated";
          return h;
        },
        roles: role ? ({ topo }) => ({ face: topo.faces.items.map(() => role) }) : undefined,
      };
    },
  });
  return new Solid(rec, s.meta);
}

function patternOp(s: Solid, count: number, trsf: (k: number) => Parameters<typeof kTransform>[1], opts: OpOpts): Solid {
  if (!Number.isInteger(count) || count < 1) userError(`pattern count must be a positive integer (got ${count})`);
  if (count === 1) return s;
  // instance 0 keeps its names; instance k is a copy whose faces are named `copy · #k · (original)`
  const copies = [...Array(count - 1)].map((_, i) => transformOp(s, "copy", trsf(i + 1), {}, `#${i + 1}`));
  return booleanOp("union", s, copies, opts);
}

/** Heuristic, agent-friendly explanation when a fillet/chamfer is too big. */
function explainRadius(what: string, r: number, rec: OpRecord, edges: number[]): string | undefined {
  let minWidth = Infinity;
  for (const e of edges) {
    const ei = edgeOf(rec, e);
    for (const f of rec.topo.edgeFaces[e] ?? []) {
      const fi = faceOf(rec, f);
      if (fi.surface !== "plane" || !ei.direction) continue;
      // width of the face measured perpendicular to the edge, within the face plane
      const across = vec.unit(vec.cross(fi.normal, ei.direction));
      const vs = new Set<number>();
      for (const fe of rec.topo.faceEdges[f] ?? []) for (const v of rec.topo.edgeVertices[fe] ?? []) vs.add(v);
      const proj = [...vs].map((v) => vec.dot(vertexOf(rec, v), across));
      if (proj.length >= 2) minWidth = Math.min(minWidth, Math.max(...proj) - Math.min(...proj));
    }
  }
  if (Number.isFinite(minWidth) && r >= minWidth - 1e-9) return `${what} ${fmt(r)} exceeds adjacent face width ${fmt(minWidth)}; use a value below ${fmt(minWidth)}`;
  if (Number.isFinite(minWidth)) return `${what} ${fmt(r)} failed (adjacent faces are at least ${fmt(minWidth)} wide); try a smaller value or fewer edges`;
  return `${what} ${fmt(r)} failed; try a smaller value or select fewer edges`;
}

const fmt = (x: number) => String(Math.round(x * 1000) / 1000);

export const MATERIALS: Record<string, Material> = {
  pla: { name: "PLA", density: 1.24 },
  petg: { name: "PETG", density: 1.27 },
  abs: { name: "ABS", density: 1.04 },
  nylon: { name: "Nylon", density: 1.14 },
  aluminum: { name: "Aluminum 6061", density: 2.7 },
  steel: { name: "Steel", density: 7.85 },
  stainless: { name: "Stainless steel", density: 8.0 },
  brass: { name: "Brass", density: 8.5 },
  wood: { name: "Wood (pine)", density: 0.5 },
};

// ---------- primitives ----------
export function box(w: number, d: number, h: number, opts: OpOpts & { center?: boolean | "xy" } = {}): Solid {
  const corner: Vec3 = opts.center === true ? [-w / 2, -d / 2, -h / 2] : opts.center === "xy" ? [-w / 2, -d / 2, 0] : [0, 0, 0];
  const rec = runOp({
    type: "box",
    tag: opts.tag,
    params: { w, d, h, corner },
    inputs: [],
    build: () => ({ built: kBox(w, d, h, corner), roles: ({ topo }) => ({ face: topo.faces.items.map((f: any) => dirRole(faceOfShape(f))) }) }),
  });
  return new Solid(rec);
}

export function cylinder(radius: number, height: number, opts: OpOpts & { at?: Vec3; axis?: AxisLike; center?: boolean } = {}): Solid {
  const ax = axisVec(opts.axis ?? "Z");
  const base = opts.at ?? [0, 0, 0];
  const origin: Vec3 = opts.center ? vec.add(base, vec.scale(ax, -height / 2)) : base;
  const rec = runOp({
    type: "cylinder",
    tag: opts.tag,
    params: { radius, height, origin, ax },
    inputs: [],
    build: () => ({
      built: kCylinder(radius, height, origin, ax),
      roles: ({ topo }) => ({ face: topo.faces.items.map((f: any) => { const i = faceOfShape(f); return i.surface === "plane" ? (vec.dot(i.normal, ax) > 0 ? "cap.end" : "cap.start") : "side"; }) }),
    }),
  });
  return new Solid(rec);
}

const faceOfShape = (f: any) => faceInfo(f);
function dirRole(i: ReturnType<typeof faceInfo>): string {
  const n = i.normal;
  const ax = ["x", "y", "z"][[0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0)];
  const sign = n[[0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0)] > 0 ? "+" : "-";
  return `${ax}${sign === "+" ? "max" : "min"}`;
}

/** Distance / clearance between two solids or entity sets. */
export function measure(a: Solid | EntitySet, b: Solid | EntitySet): { distance: number; a: Vec3; b: Vec3 } {
  const shapeOf = (x: Solid | EntitySet) => (x instanceof Solid ? x.record.shape : x.indices.length === 1 ? entityShape(x.record, x.kind, x.indices[0]) : compound(x.indices.map((i) => entityShape(x.record, x.kind, i))));
  return kDistance(shapeOf(a), shapeOf(b));
}

export type { KernelError };
