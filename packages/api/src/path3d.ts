// 3D sweep paths: polylines, arcs and splines through space, and helices (springs, threads, coils).
// Each segment gets a stable name (`path1/line2`, `coil`) that flows into the swept faces' names.
import { lineEdge, arcEdge3, splineEdge, helixEdges, helixXDir, edgeTangent, wireFromEdges, type Vec3 } from "@parasocial/kernel";
import type { OpRecord } from "@parasocial/naming";
import { ctx } from "./context";
import { runOp, userError } from "./op";
import { axisVec, vec, type AxisLike } from "./plane";
import { namer } from "./sketch";

type Seg3 =
  | { kind: "line"; a: Vec3; b: Vec3; name?: string }
  | { kind: "arc"; a: Vec3; m: Vec3; b: Vec3; name?: string }
  | { kind: "spline"; pts: Vec3[]; startTangent?: Vec3; endTangent?: Vec3; name?: string }
  | { kind: "helix"; radius: number; pitch: number; height: number; origin: Vec3; axis: Vec3; xDir: Vec3; leftHanded: boolean; taper: number; name?: string };

export type HelixOpts = {
  radius: number;
  /** Axial distance per turn. */
  pitch: number;
  /** Axial length of the helix; give this or `turns`. */
  height?: number;
  /** Number of turns (may be fractional); give this or `height`. */
  turns?: number;
  /** Point on the axis where the helix starts. Default [0, 0, 0]. */
  origin?: Vec3;
  /** Helix axis: "X" / "Y" / "Z" or a vector. Default "Z". */
  axis?: AxisLike;
  /** Direction from the axis to the start point. Default: axis Z → +X, X → +Y, Y → +Z. */
  startDirection?: AxisLike;
  /** Wind clockwise (looking down the axis) instead of counter-clockwise. */
  leftHanded?: boolean;
  /** Cone half-angle in degrees: positive widens the helix along the axis. Default 0. */
  taper?: number;
  tag?: string;
};

const finite = (p: unknown, what: string): Vec3 => {
  if (!Array.isArray(p) || p.length !== 3 || !p.every((c) => typeof c === "number" && Number.isFinite(c))) userError(`${what} must be a 3D point [x, y, z] (got ${JSON.stringify(p)})`);
  return [...(p as Vec3)] as Vec3;
};
const same = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** A path through 3D space for `sketch.sweep(path)`. Make one with `path3d(start)` or `helix({...})`. */
export class Path3d {
  readonly tag?: string;
  private segs: Seg3[] = [];
  private cursor: Vec3 | null;
  private counters = new Map<string, number>();
  private segTags = new Set<string>();

  constructor(start: Vec3, opts: { tag?: string } = {}) {
    this.cursor = finite(start, "path3d start");
    this.tag = opts.tag;
  }

  /** @internal */
  static helix(o: HelixOpts): Path3d {
    if (!o || typeof o !== "object") userError("helix needs options, e.g. helix({ radius: 5, pitch: 2, turns: 10 })");
    for (const k of ["radius", "pitch"] as const) if (typeof o[k] !== "number" || !(o[k] > 0)) userError(`helix ${k} must be a positive number (got ${o[k]})`);
    if ((o.height === undefined) === (o.turns === undefined)) userError("helix needs exactly one of height or turns, e.g. helix({ radius: 5, pitch: 2, turns: 10 })");
    const height = o.height ?? o.turns! * o.pitch;
    if (typeof height !== "number" || !(height > 0)) userError(`helix ${o.height === undefined ? "turns" : "height"} must be a positive number (got ${o.height ?? o.turns})`);
    const taper = o.taper ?? 0;
    if (typeof taper !== "number" || !(Math.abs(taper) < 89)) userError(`helix taper is a cone half-angle in degrees between -89 and 89 (got ${taper})`);
    const origin = o.origin ? finite(o.origin, "helix origin") : ([0, 0, 0] as Vec3);
    const axis = axisVec(o.axis ?? "Z");
    let xDir = helixXDir(axis);
    if (o.startDirection !== undefined) {
      const s = axisVec(o.startDirection);
      const x = vec.add(s, vec.scale(axis, -vec.dot(s, axis)));
      if (Math.hypot(...x) < 1e-9) userError("helix startDirection must not be parallel to the axis");
      xDir = vec.unit(x);
    }
    const p = new Path3d(vec.add(origin, vec.scale(xDir, o.radius)), { tag: o.tag });
    p.segs.push({ kind: "helix", radius: o.radius, pitch: o.pitch, height, origin, axis, xDir, leftHanded: !!o.leftHanded, taper, name: o.tag });
    p.cursor = null;
    return p;
  }

  private need(): Vec3 {
    if (!this.cursor) userError("a helix path can't be extended; sweep along it on its own");
    return this.cursor;
  }

  private add(s: Seg3, tag?: string) {
    if (tag !== undefined) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tag)) userError(`segment tag "${tag}" must start with a letter and contain only letters, digits, _ or -`);
      if (this.segTags.has(tag)) userError(`segment tag "${tag}" is used twice in this path`);
      this.segTags.add(tag);
      s.name = tag;
    } else {
      const c = (this.counters.get(s.kind) ?? 0) + 1;
      this.counters.set(s.kind, c);
      s.name = `${s.kind}${c}`; // prefixed with the path id when built
    }
    this.segs.push(s);
  }

  /** Straight segment from the current point to `p`. */
  lineTo(p: Vec3, opts: { tag?: string } = {}): this {
    const b = finite(p, "lineTo point");
    const a = this.need();
    if (same(a, b)) return this;
    this.add({ kind: "line", a, b }, opts.tag);
    this.cursor = b;
    return this;
  }

  /** Straight segment by an offset `[dx, dy, dz]` from the current point. */
  line(d: Vec3, opts: { tag?: string } = {}): this {
    return this.lineTo(vec.add(this.need(), finite(d, "line offset")), opts);
  }

  /** Circular arc from the current point through `through` to `end` (three points define the arc and its plane). */
  arcTo(through: Vec3, end: Vec3, opts: { tag?: string } = {}): this {
    const m = finite(through, "arcTo through point"),
      b = finite(end, "arcTo end point");
    this.add({ kind: "arc", a: this.need(), m, b }, opts.tag);
    this.cursor = b;
    return this;
  }

  /**
   * Smooth spline from the current point through `points`. `startTangent` / `endTangent` are
   * directions (length ignored); set `startTangent` to the previous segment's direction for a smooth joint.
   */
  splineTo(points: Vec3[], opts: { tag?: string; startTangent?: Vec3; endTangent?: Vec3 } = {}): this {
    if (!Array.isArray(points) || !points.length) userError("splineTo needs at least one point, e.g. .splineTo([[10, 5, 0], [20, 0, 5]])");
    const pts = points.map((p, i) => finite(p, `splineTo point ${i}`));
    const st = opts.startTangent && finite(opts.startTangent, "splineTo startTangent");
    const et = opts.endTangent && finite(opts.endTangent, "splineTo endTangent");
    this.add({ kind: "spline", pts: [this.need(), ...pts], ...(st && { startTangent: st }), ...(et && { endTangent: et }) }, opts.tag);
    this.cursor = pts[pts.length - 1];
    return this;
  }

  /** @internal The helix axis when this path is a helix (sweeps keep the profile upright about it). */
  helixAxis(): Vec3 | undefined {
    const s = this.segs[0];
    return s?.kind === "helix" ? s.axis : undefined;
  }

  /** @internal Start point and unit tangent of the path. */
  startFrame(): { point: Vec3; tangent: Vec3 } {
    const s = this.segs[0];
    if (s.kind === "helix") {
      const y = vec.cross(s.axis, s.xDir);
      const t = vec.add(vec.scale(y, 2 * Math.PI * s.radius * (s.leftHanded ? -1 : 1)), vec.add(vec.scale(s.axis, s.pitch), vec.scale(s.xDir, s.pitch * Math.tan((s.taper * Math.PI) / 180))));
      return { point: vec.add(s.origin, vec.scale(s.xDir, s.radius)), tangent: vec.unit(t) };
    }
    if (s.kind === "line") return { point: s.a, tangent: vec.unit(sub(s.b, s.a)) };
    if (s.kind === "spline") {
      if (s.startTangent) return { point: s.pts[0], tangent: vec.unit(s.startTangent) };
      // the interpolated curve leaves its first point at an angle to the first chord: ask the curve
      const e = splineEdge(s.pts);
      try {
        return { point: s.pts[0], tangent: edgeTangent(e, false) };
      } finally {
        e.delete();
      }
    }
    // arc: tangent at a is perpendicular to the radius, in the arc's plane, toward m
    const n = vec.cross(sub(s.m, s.a), sub(s.b, s.a));
    const c = circumcenter3(s.a, s.m, s.b, n);
    let t = vec.cross(n, sub(s.a, c));
    if (vec.dot(t, sub(s.m, s.a)) < 0) t = vec.scale(t, -1);
    return { point: s.a, tangent: vec.unit(t) };
  }

  private _id?: string;
  private id(): string {
    if (this._id) return this._id;
    if (this.tag) return (this._id = this.tag);
    const c = ctx();
    const kind = this.segs[0]?.kind === "helix" ? "helix" : "path";
    const n = (c.counters.get(`|${kind}-names`) ?? 0) + 1;
    c.counters.set(`|${kind}-names`, n);
    return (this._id = `${kind}${n}`);
  }

  /** @internal The path as a named wire. */
  pathRecord(): OpRecord {
    if (!this.segs.length) userError("path3d has no segments: add some with .lineTo / .arcTo / .splineTo before sweeping");
    const id = this.id();
    const segs = this.segs.map((s) => ({ ...s, name: s.kind === "helix" ? (s.name ?? id) : this.segTags.has(s.name!) ? s.name : `${id}/${s.name}` }));
    return runOp({
      type: "path",
      tag: this.tag,
      params: { segs },
      inputs: [],
      build: () => {
        const segEdges = segs.flatMap((seg) => seg3Edges(seg).map((edge) => ({ seg, edge })));
        return { built: { shape: wireFromEdges(segEdges.map((s) => s.edge)), maker: null }, ...namer(segEdges) };
      },
    });
  }
}

function seg3Edges(s: Seg3): any[] {
  if (s.kind === "line") return [lineEdge(s.a, s.b)];
  if (s.kind === "arc") return [arcEdge3(s.a, s.m, s.b)];
  if (s.kind === "spline") return [splineEdge(s.pts, { startTangent: s.startTangent, endTangent: s.endTangent })];
  // half-turn pieces: a single multi-turn edge sweeps into a face that booleans misclassify (see helixEdges)
  return helixEdges({ radius: s.radius, pitch: s.pitch, height: s.height, origin: s.origin, axis: s.axis, xDir: s.xDir, leftHanded: s.leftHanded, taper: (s.taper * Math.PI) / 180 });
}

function circumcenter3(a: Vec3, b: Vec3, c: Vec3, n: Vec3): Vec3 {
  const ab = sub(b, a),
    ac = sub(c, a);
  const n2 = vec.dot(n, n);
  if (n2 < 1e-18) userError("arcTo points are collinear: pick a through point off the line from start to end");
  const t = vec.add(vec.scale(vec.cross(n, ab), vec.dot(ac, ac)), vec.scale(vec.cross(ac, n), vec.dot(ab, ab)));
  return vec.add(a, vec.scale(t, 1 / (2 * n2)));
}

/**
 * A 3D path starting at `start`, for `sketch.sweep(path)`. Chain `.lineTo`, `.arcTo`, `.splineTo`.
 * Segments are named `path1/line1`, `path1/spline2` (or `<tag>/…`, or a segment's own tag).
 * @example sketch(plane.YZ).circle([0, 0], 2).sweep(path3d([0, 0, 0]).lineTo([20, 0, 0]).splineTo([[40, 10, 10], [60, 10, 30]], { startTangent: [1, 0, 0] }))
 */
export function path3d(start: Vec3, opts: { tag?: string } = {}): Path3d {
  return new Path3d(start, opts);
}

/**
 * A helix path: `radius`, `pitch` (axial rise per turn) and `height` or `turns`, around `axis`
 * (default "Z") from `origin`. It starts at origin + radius × startDirection (default +X for a Z axis).
 * Sweeping along a helix keeps the profile upright relative to the axis (no twist), so draw the profile on a
 * plane containing the axis at the start point, e.g. for the default helix: sketch(plane.XZ).circle([radius, 0], wire).
 * The helix segment is named by `tag` (default `helix1`, `helix2`, …).
 * @example sketch(plane.XZ).circle([10, 0], 1).sweep(helix({ radius: 10, pitch: 4, turns: 8 }), { tag: "spring" })
 */
export function helix(opts: HelixOpts): Path3d {
  return Path3d.helix(opts);
}
