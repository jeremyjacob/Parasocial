// Sketches: explicit 2D geometry on a plane -> profile faces -> extrude / revolve (PLAN §5).
// Each segment gets a stable name (`outline/right`, `bore`, `sketch1/line3`) that flows into
// the names of the faces generated from it.
import { lineEdge, arcEdge3, circleEdge, splineEdge, bsplineEdge, bsplineKnots, sampleEdge, edgeTangent, KernelError, wireFromEdges, faceFromWires, compound, prism, revol, sweep, loft as kLoft, offsetFace, edgeInfo, type Vec3, type Built, type SweepMode } from "@parasocial/kernel";
import { entityShape, faceOf, type OpRecord } from "@parasocial/naming";
import { EntitySet } from "./selection";
import { ctx } from "./context";
import { runOp, userError, warn } from "./op";
import { Plane, axisVec, type AxisLike } from "./plane";
import { Solid, booleanOp } from "./solid";
import { Path3d } from "./path3d";

export type P2 = [number, number];

type Seg =
  | { kind: "line"; a: P2; b: P2; name?: string; tag?: string }
  | { kind: "arc"; a: P2; m: P2; b: P2; name?: string; tag?: string }
  | { kind: "circle"; c: P2; r: number; name?: string; tag?: string }
  | { kind: "spline"; pts: P2[]; closed: boolean; t0?: P2; t1?: P2; name?: string; tag?: string }
  | { kind: "bspline"; poles: P2[]; degree: number; weights?: number[]; knots: number[]; mults: number[]; periodic: boolean; name?: string; tag?: string };

type Loop = { segs: Seg[]; closed: boolean };

export type SegOpts = { tag?: string };
export type ExtrudeOpts = {
  tag?: string;
  /** Extrude half each way. */
  symmetric?: boolean;
  /** `new` (default) returns the extruded solid; `add`/`remove` combine it with `target`. */
  mode?: "new" | "add" | "remove";
  target?: Solid;
};
export type RevolveOpts = {
  tag?: string;
  /** Axis: world "X" / "Y" / "Z" through the origin, or { origin, direction }. Default: the sketch's local y axis through its origin. */
  axis?: AxisLike | { origin: Vec3; direction: AxisLike };
  mode?: "new" | "add" | "remove";
  target?: Solid;
};

const eq = (a: P2, b: P2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

export class Sketch {
  readonly plane: Plane;
  readonly tag?: string;
  private loops: Loop[] = [];
  private path: Loop | null = null;
  private cursor: P2 | null = null;
  private start: P2 | null = null;
  private counters = new Map<string, number>();
  private segTags = new Set<string>();

  constructor(p: Plane, opts: { tag?: string } = {}) {
    if (!(p instanceof Plane)) userError("sketch(plane) needs a plane, e.g. sketch(plane.XY)");
    this.plane = p;
    this.tag = opts.tag;
  }

  private n(kind: string) {
    const c = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, c);
    return c;
  }
  private checkTag(tag?: string) {
    if (tag === undefined) return;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tag)) userError(`segment tag "${tag}" must start with a letter and contain only letters, digits, _ or -`);
    if (this.segTags.has(tag)) userError(`segment tag "${tag}" is used twice in this sketch`);
    this.segTags.add(tag);
  }

  // ---------- closed shapes ----------

  /** Rectangle `w` × `h`. Centered on `at` (default origin) unless `center: false` (then `at` is the corner). */
  rect(w: number, h: number, opts: { center?: boolean; at?: P2; tag?: string; fillet?: number } = {}): this {
    num(w, "rect width");
    num(h, "rect height");
    if (w <= 0 || h <= 0) userError(`rect needs a positive width and height (got ${w} × ${h})`);
    this.checkTag(opts.tag);
    const [x, y] = opts.at ?? [0, 0];
    const [x0, y0] = opts.center === false ? [x, y] : [x - w / 2, y - h / 2];
    const p: P2[] = [
      [x0, y0],
      [x0 + w, y0],
      [x0 + w, y0 + h],
      [x0, y0 + h],
    ];
    const base = opts.tag ?? `${this.prefix()}rect${this.n("rect")}`;
    const sides = ["bottom", "right", "top", "left"];
    if (opts.fillet) {
      if (opts.fillet * 2 > Math.min(w, h) + 1e-9) userError(`rect fillet ${opts.fillet} is too large for a ${w} × ${h} rect (max ${Math.min(w, h) / 2})`);
      this.loops.push({ closed: true, segs: roundedLoop(p, opts.fillet, (i) => `${base}/${sides[i]}`, (i) => `${base}/corner${i + 1}`) });
      return this;
    }
    this.loops.push({ closed: true, segs: sides.map((s, i) => ({ kind: "line" as const, a: p[i], b: p[(i + 1) % 4], name: `${base}/${s}` })) });
    return this;
  }

  /** Circle at `center` with radius `r`. */
  circle(center: P2, r: number, opts: SegOpts = {}): this {
    num(r, "circle radius");
    if (r <= 0) userError(`circle radius must be positive (got ${r})`);
    this.checkTag(opts.tag);
    this.loops.push({ closed: true, segs: [{ kind: "circle", c: [...center] as P2, r, name: opts.tag ?? `${this.prefix()}circle${this.n("circle")}` }] });
    return this;
  }

  /** Slot (stadium) from `a` to `b` with total `width`. */
  slot(a: P2, b: P2, width: number, opts: SegOpts = {}): this {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return this.circle(a, width / 2, opts);
    this.checkTag(opts.tag);
    const r = width / 2;
    const nx = (-dy / L) * r,
      ny = (dx / L) * r;
    const ux = (dx / L) * r,
      uy = (dy / L) * r;
    const base = opts.tag ?? `${this.prefix()}slot${this.n("slot")}`;
    const p1: P2 = [a[0] + nx, a[1] + ny],
      p2: P2 = [b[0] + nx, b[1] + ny],
      p3: P2 = [b[0] - nx, b[1] - ny],
      p4: P2 = [a[0] - nx, a[1] - ny];
    this.loops.push({
      closed: true,
      segs: [
        { kind: "line", a: p4, b: p3, name: `${base}/side1` },
        { kind: "arc", a: p3, m: [b[0] + ux, b[1] + uy], b: p2, name: `${base}/end2` },
        { kind: "line", a: p2, b: p1, name: `${base}/side2` },
        { kind: "arc", a: p1, m: [a[0] - ux, a[1] - uy], b: p4, name: `${base}/end1` },
      ],
    });
    return this;
  }

  /** Regular polygon with `sides` vertices on a circle of `radius` (circumscribed). */
  polygon(center: P2, radius: number, sides: number, opts: SegOpts & { rotation?: number } = {}): this {
    if (!Number.isInteger(sides) || sides < 3) userError(`polygon needs at least 3 sides (got ${sides})`);
    this.checkTag(opts.tag);
    const rot = ((opts.rotation ?? 0) * Math.PI) / 180;
    const pts: P2[] = [...Array(sides)].map((_, i) => [center[0] + radius * Math.cos(rot + (2 * Math.PI * i) / sides), center[1] + radius * Math.sin(rot + (2 * Math.PI * i) / sides)]);
    const base = opts.tag ?? `${this.prefix()}polygon${this.n("polygon")}`;
    this.loops.push({ closed: true, segs: pts.map((p, i) => ({ kind: "line" as const, a: p, b: pts[(i + 1) % sides], name: `${base}/side${i + 1}` })) });
    return this;
  }

  /** Closed polyline through `points`. */
  polyline(points: P2[], opts: SegOpts & { close?: boolean; fillet?: number } = {}): this {
    if (points.length < 2) userError("polyline needs at least 2 points");
    if (opts.fillet && opts.close !== false) {
      // rounded corners (2D fillet)
      this.checkTag(opts.tag);
      const base = opts.tag ?? `${this.prefix()}polyline${this.n("polyline")}`;
      this.loops.push({ closed: true, segs: roundedLoop(points, opts.fillet, (i) => `${base}/side${i + 1}`, (i) => `${base}/corner${i + 1}`) });
      return this;
    }
    this.moveTo(points[0]);
    for (let i = 1; i < points.length; i++) this.lineTo(points[i]);
    if (opts.close !== false) this.close(opts);
    return this;
  }

  // ---------- paths ----------

  moveTo(p: P2): this {
    this.endPath();
    this.cursor = [...p] as P2;
    this.start = [...p] as P2;
    this.path = { segs: [], closed: false };
    return this;
  }

  private need(): P2 {
    if (!this.cursor) this.moveTo([0, 0]);
    return this.cursor!;
  }
  private pushSeg(s: Seg, kind: string, tag?: string) {
    this.checkTag(tag);
    s.name = tag ?? `${this.prefix()}${kind}${this.n(kind)}`;
    this.path!.segs.push(s);
  }

  lineTo(p: P2, opts: SegOpts = {}): this {
    const a = this.need();
    if (eq(a, p)) return this;
    this.pushSeg({ kind: "line", a, b: [...p] as P2 }, "line", opts.tag);
    this.cursor = [...p] as P2;
    return this;
  }
  line(dx: number, dy: number, opts: SegOpts = {}): this {
    const a = this.need();
    return this.lineTo([a[0] + dx, a[1] + dy], opts);
  }
  hLine(dx: number, opts: SegOpts = {}): this {
    return this.line(dx, 0, opts);
  }
  vLine(dy: number, opts: SegOpts = {}): this {
    return this.line(0, dy, opts);
  }
  /** Line of `length` at `angle` degrees from local +x. */
  polarLine(length: number, angle: number, opts: SegOpts = {}): this {
    const t = (angle * Math.PI) / 180;
    return this.line(length * Math.cos(t), length * Math.sin(t), opts);
  }
  /** Arc from the cursor through `through` to `end`. */
  threePointArc(through: P2, end: P2, opts: SegOpts = {}): this {
    const a = this.need();
    this.pushSeg({ kind: "arc", a, m: [...through] as P2, b: [...end] as P2 }, "arc", opts.tag);
    this.cursor = [...end] as P2;
    return this;
  }
  /** Arc from the cursor to `end`, tangent to the previous segment. */
  tangentArcTo(end: P2, opts: SegOpts = {}): this {
    const a = this.need();
    const prev = this.path!.segs[this.path!.segs.length - 1];
    if (!prev || prev.kind === "circle") userError("tangentArcTo needs a previous line or arc to be tangent to");
    let t: P2;
    if (prev.kind === "line") t = [prev.b[0] - prev.a[0], prev.b[1] - prev.a[1]];
    else if (prev.kind === "arc") {
      const c = circumcenter(prev.a, prev.m, prev.b);
      const r: P2 = [prev.b[0] - c[0], prev.b[1] - c[1]];
      const cr = (prev.m[0] - prev.a[0]) * (prev.b[1] - prev.a[1]) - (prev.m[1] - prev.a[1]) * (prev.b[0] - prev.a[0]);
      t = cr > 0 ? [r[1], -r[0]] : [-r[1], r[0]];
    } else if (prev.kind === "spline" && prev.t1) t = prev.t1;
    else {
      // the real end tangent of the built curve
      const e = segEdge(this.plane, prev);
      try {
        const t3 = edgeTangent(e, true);
        t = [dot3(t3, this.plane.xDir), dot3(t3, this.plane.yDir)];
      } finally {
        e.delete();
      }
    }
    // circle tangent to t at a, through end: center = a + s*perp(t)
    const tl = Math.hypot(t[0], t[1]);
    const u: P2 = [t[0] / tl, t[1] / tl];
    const nrm: P2 = [-u[1], u[0]];
    const d: P2 = [end[0] - a[0], end[1] - a[1]];
    const dn = d[0] * nrm[0] + d[1] * nrm[1];
    if (Math.abs(dn) < 1e-12) return this.lineTo(end, opts);
    const s = (d[0] * d[0] + d[1] * d[1]) / (2 * dn);
    const c: P2 = [a[0] + nrm[0] * s, a[1] + nrm[1] * s];
    // midpoint on the arc: rotate from a halfway toward end along the tangent direction
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    let a1 = Math.atan2(end[1] - c[1], end[0] - c[0]);
    const ccw = s > 0;
    if (ccw && a1 < a0) a1 += 2 * Math.PI;
    if (!ccw && a1 > a0) a1 -= 2 * Math.PI;
    const am = (a0 + a1) / 2;
    const R = Math.abs(s);
    return this.threePointArc([c[0] + R * Math.cos(am), c[1] + R * Math.sin(am)], end, opts);
  }
  /**
   * Smooth spline from the cursor through `points`. `startTangent` / `endTangent` are 2D
   * direction vectors in sketch coordinates (only the direction matters; the magnitude is
   * ignored), e.g. `{ startTangent: [1, 0] }` to leave the cursor heading along +x.
   */
  splineTo(points: P2[], opts: SegOpts & { startTangent?: P2; endTangent?: P2 } = {}): this {
    if (!Array.isArray(points) || !points.length) userError("splineTo needs at least one point to pass through");
    const a = this.need();
    const s: Seg = { kind: "spline", pts: [a, ...points.map((p) => [...p] as P2)], closed: false };
    if (opts.startTangent) s.t0 = dir2(opts.startTangent, "splineTo startTangent");
    if (opts.endTangent) s.t1 = dir2(opts.endTangent, "splineTo endTangent");
    this.pushSeg(s, "spline", opts.tag);
    this.cursor = [...points[points.length - 1]] as P2;
    return this;
  }
  /**
   * Spline through `points` as its own profile. Closed by default: a smooth periodic loop (no
   * corner at the first point; don't repeat it at the end). `closed: false` starts an open
   * path like `moveTo(points[0]).splineTo(rest)` that you can continue or close.
   */
  spline(points: P2[], opts: SegOpts & { closed?: boolean } = {}): this {
    if (!Array.isArray(points)) userError("spline(points) needs an array of [x, y] points");
    if (opts.closed === false) {
      if (points.length < 2) userError("an open spline needs at least 2 points");
      return this.moveTo(points[0]).splineTo(points.slice(1), { tag: opts.tag });
    }
    let pts = points.map((p) => [...p] as P2);
    if (pts.length > 3 && eq(pts[0], pts[pts.length - 1])) pts = pts.slice(0, -1);
    if (pts.length < 3) userError(`a closed spline needs at least 3 distinct points (got ${pts.length})`);
    this.endPath();
    this.checkTag(opts.tag);
    this.loops.push({ closed: true, segs: [{ kind: "spline", pts, closed: true, name: opts.tag ?? `${this.prefix()}spline${this.n("spline")}` }] });
    return this;
  }
  /**
   * B-spline (NURBS) from the cursor, shaped by `controlPoints`: the cursor is the first control
   * point and the curve ends on the last one (which becomes the cursor). It passes near, not
   * through, the points in between. `degree` defaults to 3; `weights` (one per control point
   * including the cursor, all > 0) make it rational, e.g. weight √2/2 on the middle point of
   * `[r,0] → [r,r] → [0,r]` with degree 2 gives an exact quarter circle. `knots`/`mults` default to
   * clamped uniform; custom ones must keep the ends clamped (end multiplicity = degree + 1).
   */
  bsplineTo(controlPoints: P2[], opts: SegOpts & { degree?: number; weights?: number[]; knots?: number[]; mults?: number[] } = {}): this {
    if (!Array.isArray(controlPoints) || !controlPoints.length) userError("bsplineTo needs at least one control point");
    const a = this.need();
    const poles = [a, ...controlPoints.map((p) => [...p] as P2)];
    const k = knotsOf(poles, opts, false);
    if (k.mults[0] !== k.degree + 1 || k.mults[k.mults.length - 1] !== k.degree + 1)
      userError(`bsplineTo needs clamped ends (first and last multiplicity = degree + 1 = ${k.degree + 1}) so the curve starts at the cursor and ends on the last control point; use bspline(..., { closed: true }) for a periodic loop`);
    this.pushSeg({ kind: "bspline", poles, ...k, weights: opts.weights && [...opts.weights], periodic: false }, "bspline", opts.tag);
    this.cursor = [...poles[poles.length - 1]] as P2;
    return this;
  }
  /**
   * B-spline (NURBS) from `controlPoints` as its own profile. Closed by default: a smooth periodic
   * loop around the control polygon (default knots uniform). `closed: false` starts an open path
   * like `moveTo(points[0]).bsplineTo(rest, opts)`. Options as in `bsplineTo`.
   */
  bspline(controlPoints: P2[], opts: SegOpts & { closed?: boolean; degree?: number; weights?: number[]; knots?: number[]; mults?: number[] } = {}): this {
    if (!Array.isArray(controlPoints) || controlPoints.length < 2) userError("bspline needs at least 2 control points");
    if (opts.closed === false) {
      const { closed: _, ...rest } = opts;
      return this.moveTo(controlPoints[0]).bsplineTo(controlPoints.slice(1), rest);
    }
    const poles = controlPoints.map((p) => [...p] as P2);
    const k = knotsOf(poles, opts, true);
    this.endPath();
    this.checkTag(opts.tag);
    const name = opts.tag ?? `${this.prefix()}bspline${this.n("bspline")}`;
    this.loops.push({ closed: true, segs: [{ kind: "bspline", poles, ...k, weights: opts.weights && [...opts.weights], periodic: true, name }] });
    return this;
  }
  /** Close the current path with a line back to its start. */
  close(opts: SegOpts = {}): this {
    if (!this.path || !this.start || !this.cursor) userError("close() needs an open path: start one with moveTo()");
    if (!eq(this.cursor, this.start)) this.lineTo(this.start, opts);
    this.path!.closed = true;
    this.loops.push(this.path!);
    this.path = null;
    this.cursor = this.start = null;
    return this;
  }

  private endPath() {
    if (this.path && this.path.segs.length) {
      const first = this.path.segs[0],
        last = this.path.segs[this.path.segs.length - 1];
      const s = startOf(first),
        e = endOf(last);
      this.path.closed = eq(s, e);
      this.loops.push(this.path);
    }
    this.path = null;
  }

  private prefix() {
    return `${this.id()}/`;
  }
  private _id?: string;
  /** Sketch id used in segment names: the tag, or `sketch<n>` (per part). */
  private id(): string {
    if (this._id) return this._id;
    if (this.tag) return (this._id = this.tag);
    const c = ctx();
    const n = (c.counters.get("|sketch-names") ?? 0) + 1;
    c.counters.set("|sketch-names", n);
    return (this._id = `sketch${n}`);
  }

  private offsetBy = 0;

  /** Offset every closed profile outward by `d` (negative shrinks). Corners round. */
  offset(d: number): this {
    num(d, "offset");
    this.offsetBy += d;
    return this;
  }

  /** Add a mirrored copy of everything so far across the sketch's local "y" (default) or "x" axis. */
  mirror(axis: "x" | "y" = "y"): this {
    this.endPath();
    const f = (p: P2): P2 => (axis === "y" ? [-p[0], p[1]] : [p[0], -p[1]]);
    const copy: Loop[] = this.loops.map((l) => ({
      closed: l.closed,
      segs: l.segs.map((sg): Seg => {
        const name = sg.name ? `${sg.name}-m` : undefined;
        if (sg.kind === "line") return { kind: "line", a: f(sg.a), b: f(sg.b), name };
        if (sg.kind === "arc") return { kind: "arc", a: f(sg.a), m: f(sg.m), b: f(sg.b), name };
        if (sg.kind === "circle") return { kind: "circle", c: f(sg.c), r: sg.r, name };
        if (sg.kind === "bspline") return { ...sg, poles: sg.poles.map(f), name };
        return { kind: "spline", pts: sg.pts.map(f), closed: sg.closed, t0: sg.t0 && f(sg.t0), t1: sg.t1 && f(sg.t1), name };
      }),
    }));
    this.loops.push(...copy);
    return this;
  }

  /** @internal An open (or closed) path as a named 3D wire, for sweep paths. */
  pathRecord(): OpRecord {
    this.endPath();
    if (this.loops.length !== 1) userError(`a sweep path must be a single path (this sketch has ${this.loops.length}); draw it with moveTo/lineTo/threePointArc`);
    const pl = this.plane;
    const loop = this.loops[0];
    return runOp({
      type: "path",
      tag: this.tag,
      params: { plane: pl.toJSON(), loop },
      inputs: [],
      build: () => {
        const segEdges: { seg: Seg; edge: any }[] = [];
        const edges = loop.segs.map((sg) => {
          const e = segEdge(pl, sg);
          segEdges.push({ seg: sg, edge: e });
          return e;
        });
        return { built: { shape: wireFromEdges(edges), maker: null }, ...namer(segEdges) };
      },
    });
  }

  /** @internal The outer loop of the (single) profile as a wire, for loft sections. */
  sectionWire(): OpRecord {
    return this.pathRecord();
  }

  /**
   * Sweep this profile along `path`: a sketch with one open path (usually on a perpendicular plane),
   * a `path3d(...)` through 3D space, or a `helix({...})` (springs, threads, coils).
   * Draw the profile at the path's start, on a plane crossing the path there.
   * `orientation` sets how the profile turns along the path: "auto" (default) keeps it upright about the
   * axis on a helix and uses a minimal-twist frame otherwise; "frenet" follows the path's curvature;
   * { binormal: axis } keeps the profile's orientation fixed relative to that direction.
   * Side faces are named `<tag> · side · <profile segment>` (with the path segment on multi-segment
   * 3D paths: `<tag> · side · path1/line2 · <profile segment>`); the ends are `cap.start` / `cap.end`.
   */
  sweep(path: Sketch | Path3d, opts: SweepOpts = {}): Solid {
    if (!(path instanceof Sketch) && !(path instanceof Path3d))
      userError("sweep(path) needs a path: a sketch with one path, e.g. sketch(plane.XZ).moveTo([0,0]).lineTo([0,40]), a path3d([0,0,0]).lineTo([0,0,40]), or a helix({ radius, pitch, turns })");
    const mode = sweepMode(path, opts.orientation);
    if (path instanceof Path3d) {
      const { point, tangent } = path.startFrame();
      const n = this.plane.normal;
      const cos = Math.abs(n[0] * tangent[0] + n[1] * tangent[1] + n[2] * tangent[2]);
      const at = `(${point.map((c) => +c.toFixed(4)).join(", ")})`;
      if (cos < 1e-3) userError(`sweep: the profile's plane is parallel to the path where it starts at ${at}; draw the profile on a plane crossing the path there${path.helixAxis() ? ", e.g. one containing the helix axis like plane.XZ for a helix around Z" : ""}`);
      const o = this.plane.origin;
      const off = Math.abs((point[0] - o[0]) * n[0] + (point[1] - o[1]) * n[1] + (point[2] - o[2]) * n[2]);
      if (off > 1e-4) warn(`sweep: the profile's plane is ${+off.toFixed(4)} away from the path start ${at}; the swept solid follows the path's shape from where the profile is. Move the sketch plane to the path start if that isn't intended`, "operation");
    }
    const prof = this.profile();
    const pth = path.pathRecord();
    const multi = path instanceof Path3d && pth.topo.edges.items.length > 1;
    const rec = runOp({
      type: "sweep",
      tag: opts.tag,
      params: mode === "corrected" ? {} : { orientation: mode },
      inputs: [prof, pth],
      build: () => {
        const built = sweep(prof.shape, pth.shape, { mode });
        return {
          built,
          historyOptions: { generatedFrom: ["edge", "vertex"], noModified: true },
          roles: ({ topo, history }) => {
            const r = capRoles(topo, history, built, "side");
            if (multi)
              history.face.forEach((o: any[], i: number) => {
                const seg = o.find((x) => x.slot === 1 && x.kind === "edge" && x.rel === "generated");
                const name = seg && pth.roles.edge?.[seg.index];
                if (r.face[i] === "side" && name) r.face[i] = `side · ${name}`;
              });
            return r;
          },
        };
      },
    });
    return combine(new Solid(rec), opts.mode, opts.target);
  }

  // ---------- to 3D ----------

  /** @internal Build the profile op (faces with named edges). */
  profile(offset = 0): OpRecord {
    this.endPath();
    if (!this.loops.length) userError("sketch is empty: add a shape (rect, circle, polyline, ...) before extruding");
    const open = this.loops.find((l) => !l.closed);
    if (open) {
      const p = startOf(open.segs[0]);
      userError(`sketch has an open profile starting at (${p[0]}, ${p[1]}): close it with .close() or end where it starts`);
    }
    const pl = offset ? this.plane.offset(offset) : this.plane;
    const loops = this.loops;
    const rec = runOp({
      type: "sketch",
      tag: this.tag,
      params: { plane: pl.toJSON(), loops },
      inputs: [],
      build: () => buildProfile(pl, loops),
    });
    if (!this.offsetBy) return rec;
    const d = this.offsetBy;
    // offset edges are named after the segment they came from: `outline/right+offset`
    return runOp({
      type: "offset",
      params: { d },
      inputs: [rec],
      build: () => {
        const built = offsetFace(rec.shape, d);
        built.maker?.delete?.();
        return {
          built: { shape: built.shape, maker: null },
          history: (topo) => ({ face: topo.faces.items.map(() => []), edge: topo.edges.items.map(() => []), vertex: topo.vertices.items.map(() => []) }),
          roles: ({ topo }) => ({
            edge: topo.edges.items.map((e: any, i: number) => {
              // nearest source segment by midpoint: offsets keep order and shape
              const mid = edgeInfo(e).mid;
              let best = "",
                bd = Infinity;
              rec.topo.edges.items.forEach((src: any, j: number) => {
                const sm = edgeInfo(src).mid;
                const dd = Math.hypot(sm[0] - mid[0], sm[1] - mid[1], sm[2] - mid[2]);
                if (dd < bd) (bd = dd), (best = rec.roles.edge?.[j] ?? `edge${j}`);
              });
              return `${best}+offset${i ? "" : ""}`;
            }),
          }),
        };
      },
    });
  }

  extrude(distanceOrOpts: number | (ExtrudeOpts & { upTo: EntitySet }), maybeOpts: ExtrudeOpts = {}): Solid {
    let distance: number;
    let opts: ExtrudeOpts;
    if (typeof distanceOrOpts === "object") {
      // up to a planar face: distance along the sketch normal to that face's plane
      opts = distanceOrOpts;
      const f = distanceOrOpts.upTo;
      if (!(f instanceof EntitySet) || f.kind !== "face" || f.length !== 1) userError("extrude({ upTo }) needs exactly one face, e.g. { upTo: base.faces(\">Z\") }");
      const info = faceOf(f.record, f.indices[0]);
      if (info.surface !== "plane") userError("extrude up to: the target face must be planar");
      const n = this.plane.normal,
        o = this.plane.origin;
      distance = (info.center[0] - o[0]) * n[0] + (info.center[1] - o[1]) * n[1] + (info.center[2] - o[2]) * n[2];
    } else {
      distance = distanceOrOpts;
      opts = maybeOpts;
    }
    num(distance, "extrude distance");
    if (Math.abs(distance) < 1e-9) userError("extrude distance must be non-zero");
    const prof = this.profile(opts.symmetric ? -distance / 2 : 0);
    const v = this.plane.normal.map((c) => c * distance) as Vec3;
    const rec = runOp({
      type: "extrude",
      tag: opts.tag,
      params: { v, symmetric: !!opts.symmetric },
      inputs: [prof],
      build: () => {
        const built = prism(prof.shape, v);
        return {
          built,
          historyOptions: { generatedFrom: ["edge", "vertex"], noModified: true },
          roles: ({ topo, history }) => capRoles(topo, history, built, "side"),
        };
      },
    });
    return combine(new Solid(rec), opts.mode, opts.target);
  }

  revolve(angle = 360, opts: RevolveOpts = {}): Solid {
    num(angle, "revolve angle");
    const prof = this.profile();
    let origin: Vec3, dir: Vec3;
    if (!opts.axis) (origin = this.plane.origin), (dir = this.plane.yDir);
    else if (typeof opts.axis === "string" || Array.isArray(opts.axis)) (origin = [0, 0, 0]), (dir = axisVec(opts.axis as AxisLike));
    else (origin = opts.axis.origin), (dir = axisVec(opts.axis.direction));
    const rad = (angle * Math.PI) / 180;
    const rec = runOp({
      type: "revolve",
      tag: opts.tag,
      params: { origin, dir, angle },
      inputs: [prof],
      build: () => {
        const built = revol(prof.shape, origin, dir, rad);
        return {
          built,
          historyOptions: { generatedFrom: ["edge", "vertex"], noModified: true },
          roles: ({ topo, history }) => capRoles(topo, history, built, "side"),
        };
      },
    });
    return combine(new Solid(rec), opts.mode, opts.target);
  }
}

export type SweepOpts = {
  tag?: string;
  /** How the profile turns along the path (see `sweep`). Default "auto". */
  orientation?: "auto" | "frenet" | { binormal: AxisLike };
  mode?: "new" | "add" | "remove";
  target?: Solid;
};

function sweepMode(path: Sketch | Path3d, o: SweepOpts["orientation"] = "auto"): SweepMode {
  if (o === "auto") {
    const ax = path instanceof Path3d ? path.helixAxis() : undefined;
    return ax ? { binormal: ax } : "corrected";
  }
  if (o === "frenet") return "frenet";
  if (o && typeof o === "object" && "binormal" in o) return { binormal: axisVec(o.binormal) };
  userError(`sweep orientation must be "auto", "frenet" or { binormal: "Z" } (got ${JSON.stringify(o)})`);
}

function combine(s: Solid, mode: ExtrudeOpts["mode"], target?: Solid): Solid {
  if (!mode || mode === "new") return s;
  if (!target) userError(`mode "${mode}" needs a target solid: { mode: "${mode}", target: base }`);
  return booleanOp(mode === "add" ? "union" : "subtract", target!, [s], {});
}

function capRoles(topo: any, history: any, built: Built, sideRole: string) {
  const face: (string | undefined)[] = history.face.map((o: any[]) => (o.some((x) => x.rel === "generated" && x.kind === "edge") ? sideRole : undefined));
  if (built.caps) {
    const s = topo.faces.indexOf(built.caps.start);
    const e = topo.faces.indexOf(built.caps.end);
    if (s >= 0) face[s] = "cap.start";
    if (e >= 0) face[e] = "cap.end";
    built.caps.start.delete?.();
    built.caps.end.delete?.();
  }
  return { face };
}

// closed splines start and end on their first point; periodic bsplines near their first pole
function startOf(s: Seg): P2 {
  return s.kind === "line" || s.kind === "arc" ? s.a : s.kind === "circle" ? [s.c[0] + s.r, s.c[1]] : s.kind === "bspline" ? s.poles[0] : s.pts[0];
}
function endOf(s: Seg): P2 {
  if (s.kind === "line" || s.kind === "arc") return s.b;
  if (s.kind === "circle") return [s.c[0] + s.r, s.c[1]];
  if (s.kind === "bspline") return s.periodic ? s.poles[0] : s.poles[s.poles.length - 1];
  return s.closed ? s.pts[0] : s.pts[s.pts.length - 1];
}

function circumcenter(a: P2, b: P2, c: P2): P2 {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
  const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
  return [ux, uy];
}

/** Sample a loop as a polygon (for region classification). Splines sample their built `edge`s. */
function sampleLoop(l: Loop, pl: Plane, edge: (s: Seg) => any): P2[] {
  const pts: P2[] = [];
  for (const s of l.segs) {
    if (s.kind === "line") pts.push(s.a);
    else if (s.kind === "circle") for (let i = 0; i < 48; i++) pts.push([s.c[0] + s.r * Math.cos((2 * Math.PI * i) / 48), s.c[1] + s.r * Math.sin((2 * Math.PI * i) / 48)]);
    else if (s.kind === "arc") {
      const c = circumcenter(s.a, s.m, s.b);
      const a0 = Math.atan2(s.a[1] - c[1], s.a[0] - c[0]);
      const am = Math.atan2(s.m[1] - c[1], s.m[0] - c[0]);
      let a1 = Math.atan2(s.b[1] - c[1], s.b[0] - c[0]);
      const r = Math.hypot(s.a[0] - c[0], s.a[1] - c[1]);
      // choose the sweep direction that passes through m
      const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const ccw = norm(am - a0) < norm(a1 - a0);
      const sweep = ccw ? norm(a1 - a0) : -norm(a0 - a1);
      for (let i = 0; i < 24; i++) pts.push([c[0] + r * Math.cos(a0 + (sweep * i) / 24), c[1] + r * Math.sin(a0 + (sweep * i) / 24)]);
      void a1;
    } else pts.push(...sampleEdge(edge(s), 64).map((p) => pl.toLocal(p)));
  }
  return pts;
}

const polyArea = (p: P2[]) => p.reduce((a, q, i) => a + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0) / 2;
function inside(pt: P2, poly: P2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function buildProfile(pl: Plane, loops: Loop[]) {
  // edges per segment, in 3D
  const segEdges: { seg: Seg; edge: any }[] = [];
  const wires = loops.map((l) => {
    const edges = l.segs.map((s) => {
      const e = segEdge(pl, s);
      segEdges.push({ seg: s, edge: e });
      return e;
    });
    return wireFromEdges(edges);
  });
  // classify loops: depth by containment
  const edgeOf = new Map(segEdges.map((s) => [s.seg, s.edge]));
  const polys = loops.map((l) => sampleLoop(l, pl, (s) => edgeOf.get(s)));
  const areas = polys.map((p) => Math.abs(polyArea(p)));
  const parent = loops.map((_, i) => {
    let best = -1;
    for (let j = 0; j < loops.length; j++) {
      if (i === j || areas[j] <= areas[i]) continue;
      if (inside(polys[i][0], polys[j]) || inside(centroid(polys[i]), polys[j])) if (best < 0 || areas[j] < areas[best]) best = j;
    }
    return best;
  });
  const depth = parent.map((_, i) => {
    let d = 0,
      p = parent[i];
    while (p >= 0) (d++, (p = parent[p]));
    return d;
  });
  const faces: any[] = [];
  const makers: any[] = [];
  loops.forEach((_, i) => {
    if (depth[i] % 2 !== 0) return;
    const holes = loops.map((_, j) => j).filter((j) => parent[j] === i);
    const f = faceFromWires(wires[i], holes.map((j) => wires[j]));
    faces.push(f.shape);
    makers.push(f.maker);
  });
  for (const m of makers) m?.delete?.();
  const shape = faces.length === 1 ? faces[0] : compound(faces);
  return {
    built: { shape, maker: null },
    // edge roles act as explicit names: each profile edge is named after its segment
    ...namer(segEdges),
  };
}

function segEdge(pl: Plane, s: Seg) {
  if (s.kind === "line") return lineEdge(pl.toWorld(s.a), pl.toWorld(s.b));
  if (s.kind === "arc") return arcEdge3(pl.toWorld(s.a), pl.toWorld(s.m), pl.toWorld(s.b));
  if (s.kind === "circle") return circleEdge(pl.toWorld(s.c), pl.normal, s.r);
  const vec = (v: P2): Vec3 => pl.toWorld(v).map((c, i) => c - pl.origin[i]) as Vec3;
  if (s.kind === "bspline") return bsplineEdge({ poles: s.poles.map((p) => pl.toWorld(p)), degree: s.degree, weights: s.weights, knots: s.knots, mults: s.mults, periodic: s.periodic });
  return splineEdge(s.pts.map((p) => pl.toWorld(p)), { closed: s.closed, startTangent: s.t0 && vec(s.t0), endTangent: s.t1 && vec(s.t1) });
}

function knotsOf(poles: P2[], o: { degree?: number; weights?: number[]; knots?: number[]; mults?: number[] }, periodic: boolean) {
  for (const [v, w] of [[o.degree, "degree"], ...(o.weights ?? []).map((x, i) => [x, `weight ${i}`]), ...(o.knots ?? []).map((x, i) => [x, `knot ${i}`])] as [unknown, string][])
    if (v !== undefined) num(v, `bspline ${w}`);
  try {
    return bsplineKnots({ poles: poles.map((p) => [p[0], p[1], 0]), degree: o.degree, weights: o.weights, knots: o.knots, mults: o.mults, periodic });
  } catch (e) {
    if (e instanceof KernelError) userError(e.message);
    throw e;
  }
}

function dir2(v: P2, what: string): P2 {
  if (!Array.isArray(v) || v.length !== 2) userError(`${what} must be a 2D direction like [1, 0]`);
  num(v[0], what);
  num(v[1], what);
  const l = Math.hypot(v[0], v[1]);
  if (l < 1e-12) userError(`${what} must be a non-zero direction (got [${v[0]}, ${v[1]}])`);
  return [v[0] / l, v[1] / l];
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A closed polygon with every corner rounded to radius r (tangent arcs). */
function roundedLoop(pts: P2[], r: number, side: (i: number) => string, corner: (i: number) => string): Seg[] {
  const n = pts.length;
  const segs: Seg[] = [];
  const cut: { in: P2; out: P2; mid: P2 }[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i],
      a = pts[(i - 1 + n) % n],
      b = pts[(i + 1) % n];
    const u1 = norm2([a[0] - p[0], a[1] - p[1]]),
      u2 = norm2([b[0] - p[0], b[1] - p[1]]);
    const cos = u1[0] * u2[0] + u1[1] * u2[1];
    const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2;
    const t = r / Math.tan(half);
    const bis = norm2([u1[0] + u2[0], u1[1] + u2[1]]);
    const c: P2 = [p[0] + bis[0] * (r / Math.sin(half)), p[1] + bis[1] * (r / Math.sin(half))];
    const mid: P2 = [c[0] - bis[0] * r, c[1] - bis[1] * r];
    cut.push({ in: [p[0] + u1[0] * t, p[1] + u1[1] * t], out: [p[0] + u2[0] * t, p[1] + u2[1] * t], mid });
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    segs.push({ kind: "line", a: cut[i].out, b: cut[j].in, name: side(i) });
    segs.push({ kind: "arc", a: cut[j].in, m: cut[j].mid, b: cut[j].out, name: corner(j) });
  }
  return segs;
}

const norm2 = (v: P2): P2 => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

function centroid(p: P2[]): P2 {
  const s = p.reduce((a, q) => [a[0] + q[0], a[1] + q[1]] as P2, [0, 0] as P2);
  return [s[0] / p.length, s[1] / p.length];
}

/** Map each profile edge to its segment's name (by identity, falling back to geometry). */
export function namer(segEdges: { seg: { name?: string }; edge: any }[]) {
  return {
    roles: ({ topo }: { topo: any }) => {
      const edge: (string | undefined)[] = topo.edges.items.map((e: any) => {
        const hit = segEdges.find((s) => s.edge.IsSame(e));
        if (hit) return hit.seg.name;
        const mid = edgeInfo(e).mid;
        let best: { name?: string } | undefined,
          bd = Infinity;
        for (const s of segEdges) {
          const d = Math.hypot(...(edgeInfo(s.edge).mid.map((c, k) => c - mid[k]) as Vec3));
          if (d < bd) (bd = d), (best = s.seg);
        }
        return bd < 1e-6 ? best?.name : undefined;
      });
      return { edge };
    },
  };
}

function num(v: unknown, what: string) {
  if (typeof v !== "number" || !Number.isFinite(v)) userError(`${what} must be a finite number (got ${typeof v === "number" ? v : JSON.stringify(v)})`);
}

export function sketch(p: Plane, opts: { tag?: string } = {}) {
  return new Sketch(p, opts);
}

export { entityShape };

/** Loft through two or more section sketches (each one closed loop), first to last. */
export function loft(sections: Sketch[], opts: { tag?: string; ruled?: boolean } = {}): Solid {
  if (!Array.isArray(sections) || sections.length < 2) userError("loft needs at least two section sketches");
  const recs = sections.map((sk) => sk.sectionWire());
  const rec = runOp({
    type: "loft",
    tag: opts.tag,
    params: { ruled: !!opts.ruled },
    inputs: recs,
    build: () => {
      const built = kLoft(recs.map((r) => r.shape), { ruled: opts.ruled });
      return { built, historyOptions: { generatedFrom: ["edge"], noModified: true }, roles: ({ topo, history }) => capRoles(topo, history, built, "side") };
    },
  });
  return new Solid(rec);
}
