// Thin layer over OCCT operations. Each returns the result shape plus the builder
// (for history), which the caller must `delete()` once history is collected.
import { oc, occtMessage } from "./oc";
import { tmp, scoped } from "./memory";
import { downcast, explore, type Shape } from "./topo";
import type { Vec3 } from "./geom";

export class KernelError extends Error {
  constructor(
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export type Built = { shape: Shape; maker: any | null; caps?: { start: Shape; end: Shape } };

const pnt = (p: Vec3) => tmp(new (oc().gp_Pnt)(p[0], p[1], p[2]));
const dir = (d: Vec3) => tmp(new (oc().gp_Dir)(d[0], d[1], d[2]));
const vec = (d: Vec3) => tmp(new (oc().gp_Vec)(d[0], d[1], d[2]));
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const progress = () => tmp(new (oc().Message_ProgressRange)());

function guard<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof KernelError) throw e;
    throw new KernelError(`${what} failed: ${occtMessage(e)}`, e);
  }
}

// ---------- curves / profiles ----------

export function lineEdge(a: Vec3, b: Vec3): Shape {
  return guard("line", () => scoped(() => {
    const mk = tmp(new (oc().BRepBuilderAPI_MakeEdge)(pnt(a), pnt(b)));
    if (!mk.IsDone()) throw new KernelError("line: degenerate segment (zero length)");
    return mk.Edge();
  }));
}

export function arcEdge3(a: Vec3, mid: Vec3, b: Vec3): Shape {
  const O = oc();
  return guard("arc", () => scoped(() => {
    const mk = tmp(new O.GC_MakeArcOfCircle(pnt(a), pnt(mid), pnt(b)));
    if (!mk.IsDone()) throw new KernelError("arc: points are collinear");
    return tmp(new O.BRepBuilderAPI_MakeEdge(tmp(mk.Value()))).Edge();
  }));
}

export function circleEdge(center: Vec3, normal: Vec3, radius: number): Shape {
  const O = oc();
  return guard("circle", () => scoped(() => {
    if (!(radius > 0)) throw new KernelError(`circle radius must be positive (got ${radius})`);
    const ax = tmp(new O.gp_Ax2(pnt(center), dir(normal)));
    const c = tmp(new O.gp_Circ(ax, radius));
    return tmp(new O.BRepBuilderAPI_MakeEdge(c)).Edge();
  }));
}

export type SplineOpts = {
  /** Periodic curve through all points, smooth (C2) at the seam. Don't repeat the first point. */
  closed?: boolean;
  startTangent?: Vec3;
  endTangent?: Vec3;
  /** Per-point tangent directions (null = free), same length as `points`. */
  tangents?: (Vec3 | null)[];
};

const fmt = (p: Vec3) => `(${p.map((c) => +c.toFixed(4)).join(", ")})`;

/** Smooth curve through `points`. Tangents are directions: their magnitude is ignored. */
export function splineEdge(points: Vec3[], opts: SplineOpts | boolean = {}): Shape {
  const O = oc();
  const o: SplineOpts = typeof opts === "boolean" ? { closed: opts } : opts;
  return guard("spline", () => scoped(() => {
    let pts = points;
    if (o.closed && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-7) pts = pts.slice(0, -1);
    if (pts.length < (o.closed ? 3 : 2)) throw new KernelError(`${o.closed ? "closed spline needs at least 3" : "spline needs at least 2"} distinct points (got ${pts.length})`);
    for (let i = 0; i < pts.length - (o.closed ? 0 : 1); i++) {
      const j = (i + 1) % pts.length;
      if (dist(pts[i], pts[j]) < 1e-6) throw new KernelError(`spline points ${i} and ${j} coincide at ${fmt(pts[i])}`);
    }
    if (o.closed && (o.startTangent || o.endTangent)) throw new KernelError("a closed spline is smooth at its seam: startTangent/endTangent don't apply (use tangents[0] to set the seam direction)");
    if (o.tangents && o.tangents.length !== pts.length) throw new KernelError(`spline tangents needs one entry (or null) per point: got ${o.tangents.length} for ${pts.length} points`);
    const unitT = (t: Vec3, what: string): Vec3 => {
      const l = Math.hypot(t[0], t[1], t[2]);
      if (!(l > 1e-12)) throw new KernelError(`spline ${what} must be a non-zero direction (got ${fmt(t)})`);
      return [t[0] / l, t[1] / l, t[2] / l];
    };
    const arr: any = tmp(new O.NCollection_Array1_gp_Pnt(1, pts.length));
    pts.forEach((p, i) => arr.SetValue(i + 1, pnt(p)));
    // plain open splines keep the legacy least-squares fit: Interpolate differs visibly (up to ~20% of
    // the span on wiggly point sets), which would reshape existing documents
    if (!o.closed && !o.startTangent && !o.endTangent && !o.tangents) {
      const b = tmp(new O.GeomAPI_PointsToBSpline());
      b.Init(arr, 3, 8, O.GeomAbs_Shape.GeomAbs_C2, 1e-4);
      if (!b.IsDone()) throw new KernelError("spline fit failed; check the points aren't coincident");
      return tmp(new O.BRepBuilderAPI_MakeEdge(tmp(b.Curve()))).Edge();
    }
    const b = tmp(new O.GeomAPI_Interpolate(tmp(new O.NCollection_HArray1_gp_Pnt(arr)), !!o.closed, 1e-7));
    const ts = o.tangents ? [...o.tangents] : pts.map((): Vec3 | null => null);
    if (o.startTangent) ts[0] = o.startTangent;
    if (o.endTangent) ts[pts.length - 1] = o.endTangent;
    if (ts.some((t) => t)) {
      const tv: any = tmp(new O.NCollection_Array1_gp_Vec(1, pts.length));
      const flags: any = tmp(new O.NCollection_Array1_bool(1, pts.length));
      ts.forEach((t, i) => {
        const what = i === 0 && o.startTangent ? "startTangent" : i === pts.length - 1 && o.endTangent ? "endTangent" : `tangent ${i}`;
        tv.SetValue(i + 1, vec(t ? unitT(t, what) : [0, 0, 0]));
        flags.SetValue(i + 1, !!t);
      });
      b.Load(tv, tmp(new O.NCollection_HArray1_bool(flags)), true);
    }
    b.Perform();
    if (!b.IsDone()) throw new KernelError("spline interpolation failed; check the points and tangents");
    return tmp(new O.BRepBuilderAPI_MakeEdge(tmp(b.Curve()))).Edge();
  }));
}

export type BSplineOpts = {
  poles: Vec3[];
  /** Default 3 (lowered to poles − 1 when there are fewer poles). */
  degree?: number;
  /** Rational weights, one per pole, all > 0. */
  weights?: number[];
  /** Distinct knots with `mults`, or (without `mults`) the full flat knot vector. Default: clamped uniform. */
  knots?: number[];
  mults?: number[];
  /** Closed periodic curve (default knots: uniform, all multiplicity 1). */
  periodic?: boolean;
};

/** Validate and fill in a B-spline's degree, knots and multiplicities (pure JS; throws KernelError). */
export function bsplineKnots(o: BSplineOpts): { degree: number; knots: number[]; mults: number[] } {
  const n = o.poles.length;
  const deg = o.degree ?? Math.max(1, Math.min(3, n - (o.periodic ? 0 : 1)));
  if (!Number.isInteger(deg) || deg < 1 || deg > 25) throw new KernelError(`bspline degree must be an integer from 1 to 25 (got ${deg})`);
  if (n < deg + 1) throw new KernelError(`a degree-${deg} bspline needs at least ${deg + 1} control points (got ${n})`);
  if (o.weights) {
    if (o.weights.length !== n) throw new KernelError(`bspline needs one weight per control point (got ${o.weights.length} weights for ${n} points)`);
    o.weights.forEach((w, i) => {
      if (!(w > 0) || !Number.isFinite(w)) throw new KernelError(`bspline weight ${i} must be positive (got ${w})`);
    });
  }
  let knots = o.knots,
    mults = o.mults;
  if (knots && !mults) {
    // flat knot vector -> distinct knots + multiplicities
    const k: number[] = [],
      m: number[] = [];
    knots.forEach((u, i) => {
      if (i && u < knots![i - 1]) throw new KernelError(`bspline knots must be non-decreasing (knot ${i} = ${u} < ${knots![i - 1]})`);
      if (i && u - k[k.length - 1] < 1e-12) m[m.length - 1]++;
      else (k.push(u), m.push(1));
    });
    (knots = k), (mults = m);
  }
  if (!mults) {
    if (o.periodic) mults = Array(n + 1).fill(1);
    else mults = [deg + 1, ...Array(n - deg - 1).fill(1), deg + 1];
  }
  if (!knots) knots = mults.map((_, i) => i / (mults!.length - 1));
  if (knots.length !== mults.length) throw new KernelError(`bspline knots and mults must have the same length (got ${knots.length} and ${mults.length})`);
  if (knots.length < 2) throw new KernelError("bspline needs at least 2 distinct knots");
  for (let i = 1; i < knots.length; i++) if (!(knots[i] > knots[i - 1])) throw new KernelError(`bspline knots must be increasing when mults are given (knot ${i} = ${knots[i]} after ${knots[i - 1]})`);
  mults.forEach((m, i) => {
    const end = i === 0 || i === mults!.length - 1;
    const max = end && !o.periodic ? deg + 1 : deg;
    if (!Number.isInteger(m) || m < 1 || m > max) throw new KernelError(`bspline multiplicity ${i} must be an integer from 1 to ${max} (got ${m})`);
  });
  const sum = mults.reduce((a, b) => a + b, 0);
  if (o.periodic) {
    if (mults[0] !== mults[mults.length - 1]) throw new KernelError(`a periodic bspline needs equal first and last multiplicities (got ${mults[0]} and ${mults[mults.length - 1]})`);
    if (sum - mults[mults.length - 1] !== n) throw new KernelError(`a periodic bspline needs sum(mults) − last mult = number of control points (${sum - mults[mults.length - 1]} ≠ ${n})`);
  } else if (sum !== n + deg + 1) throw new KernelError(`bspline needs sum(mults) = control points + degree + 1 (${sum} ≠ ${n} + ${deg} + 1)`);
  return { degree: deg, knots, mults };
}

/** B-spline / NURBS curve from control points (poles). */
export function bsplineEdge(o: BSplineOpts): Shape {
  const O = oc();
  return guard("bspline", () => scoped(() => {
    const { degree, knots, mults } = bsplineKnots(o);
    const n = o.poles.length;
    const P: any = tmp(new O.NCollection_Array1_gp_Pnt(1, n));
    o.poles.forEach((p, i) => P.SetValue(i + 1, pnt(p)));
    const K: any = tmp(new O.NCollection_Array1_double(1, knots.length));
    knots.forEach((k, i) => K.SetValue(i + 1, k));
    const M: any = tmp(new O.NCollection_Array1_int(1, mults.length));
    mults.forEach((m, i) => M.SetValue(i + 1, m));
    let c: any;
    if (o.weights) {
      const W: any = tmp(new O.NCollection_Array1_double(1, n));
      o.weights.forEach((w, i) => W.SetValue(i + 1, w));
      c = tmp(new O.Geom_BSplineCurve(P, W, K, M, degree, !!o.periodic, true));
    } else c = tmp(new O.Geom_BSplineCurve(P, K, M, degree, !!o.periodic));
    const mk = tmp(new O.BRepBuilderAPI_MakeEdge(c));
    if (!mk.IsDone()) throw new KernelError("bspline edge could not be built (degenerate control points?)");
    return mk.Edge();
  }));
}

export function wireFromEdges(edges: Shape[]): Shape {
  const O = oc();
  return guard("wire", () => scoped(() => {
    const mk = tmp(new O.BRepBuilderAPI_MakeWire());
    for (const e of edges) mk.Add(e);
    if (!mk.IsDone()) throw new KernelError("profile is not a connected chain of segments");
    return mk.Wire();
  }));
}

/** Planar face from an outer wire and optional hole wires. */
export function faceFromWires(outer: Shape, holes: Shape[] = []): Built {
  const O = oc();
  return guard("face", () => scoped(() => {
    const mk = new O.BRepBuilderAPI_MakeFace(outer, true);
    if (!mk.IsDone()) {
      mk.delete();
      throw new KernelError("profile is not planar or not closed");
    }
    for (const h of holes) mk.Add(O.TopoDS.Wire(h.Reversed()));
    let face = mk.Face();
    // fix hole orientation if needed
    if (holes.length) {
      const fix = tmp(new O.ShapeFix_Face(face));
      fix.FixOrientation();
      face = downcast(fix.Face());
    }
    return { shape: face, maker: mk };
  }));
}

export function compound(shapes: Shape[]): Shape {
  const O = oc();
  const c = new O.TopoDS_Compound();
  const b = new O.TopoDS_Builder();
  b.MakeCompound(c);
  for (const s of shapes) b.Add(c, s);
  b.delete();
  return c;
}

// ---------- solids ----------

export function prism(profile: Shape, v: Vec3): Built {
  const O = oc();
  return guard("extrude", () => scoped(() => {
    const mk = new O.BRepPrimAPI_MakePrism(profile, vec(v), false, true);
    if (!mk.IsDone()) throw new KernelError("extrude produced no solid");
    return { shape: downcast(mk.Shape()), maker: mk, caps: { start: mk.FirstShape(), end: mk.LastShape() } };
  }));
}

export function revol(profile: Shape, axisOrigin: Vec3, axisDir: Vec3, angleRad: number): Built {
  const O = oc();
  return guard("revolve", () => scoped(() => {
    const ax = tmp(new O.gp_Ax1(pnt(axisOrigin), dir(axisDir)));
    const mk = new O.BRepPrimAPI_MakeRevol(profile, ax, angleRad, true);
    if (!mk.IsDone()) throw new KernelError("revolve produced no solid");
    const full = Math.abs(Math.abs(angleRad) - 2 * Math.PI) < 1e-9;
    return { shape: downcast(mk.Shape()), maker: mk, caps: full ? undefined : { start: mk.FirstShape(), end: mk.LastShape() } };
  }));
}

export function fillet(solid: Shape, edges: Shape[], radius: number | ((e: Shape) => number)): Built {
  const O = oc();
  return guard("fillet", () => scoped(() => {
    const mk = new O.BRepFilletAPI_MakeFillet(solid, O.ChFi3d_FilletShape.ChFi3d_Rational);
    for (const e of edges) mk.Add(typeof radius === "number" ? radius : radius(e), O.TopoDS.Edge(e));
    try {
      mk.Build(progress());
    } catch (e) {
      mk.delete();
      throw new KernelError(`fillet failed: ${occtMessage(e)}`);
    }
    if (!mk.IsDone()) {
      const faulty = safe(() => mk.NbFaultyContours(), 0);
      mk.delete();
      throw new KernelError(faulty ? `fillet failed on ${faulty} edge chain(s); radius may exceed an adjacent face` : "fillet failed; radius may exceed an adjacent face");
    }
    return { shape: downcast(mk.Shape()), maker: mk };
  }));
}

export function chamfer(solid: Shape, edges: Shape[], distance: number, distance2?: number, angleRad?: number): Built {
  const O = oc();
  return guard("chamfer", () => scoped(() => {
    const mk = new O.BRepFilletAPI_MakeChamfer(solid);
    // need a reference face per edge for asymmetric chamfers
    const faces = explore(solid, "face");
    for (const e of edges) {
      const edge = O.TopoDS.Edge(e);
      if (distance2 === undefined && angleRad === undefined) {
        mk.Add(distance, edge);
      } else {
        const f = faces.items.find((fc) => explore(fc, "edge").indexOf(e) >= 0);
        if (angleRad !== undefined) mk.AddDA(distance, angleRad, edge, O.TopoDS.Face(f));
        else mk.Add(distance, distance2!, edge, O.TopoDS.Face(f));
      }
    }
    try {
      mk.Build(progress());
    } catch (e) {
      mk.delete();
      throw new KernelError(`chamfer failed: ${occtMessage(e)}`);
    }
    if (!mk.IsDone()) {
      mk.delete();
      throw new KernelError("chamfer failed; distance may exceed an adjacent face");
    }
    return { shape: downcast(mk.Shape()), maker: mk };
  }));
}

export type BooleanKind = "union" | "subtract" | "intersect";

export function boolean(kind: BooleanKind, a: Shape, b: Shape): Built {
  return booleanMany(kind, a, [b]);
}

/**
 * Fuzzy tolerance for booleans (mm). Approximated BSpline surfaces (sweeps along helices and 3D
 * splines) touch analytic ones only to ~1e-6, which OCCT's exact classification can get wrong
 * (a helical groove cut into a drum came out inverted). 1e-4 mm is far below modelling precision.
 */
export const BOOLEAN_FUZZY = 1e-4;

/** Boolean of `a` with one or several tools at once (one history for all). */
export function booleanMany(kind: BooleanKind, a: Shape, tools: Shape[]): Built {
  const O = oc();
  return guard(kind, () => scoped(() => {
    const mk = kind === "union" ? new O.BRepAlgoAPI_Fuse() : kind === "subtract" ? new O.BRepAlgoAPI_Cut() : new O.BRepAlgoAPI_Common();
    const args = tmp(new O.NCollection_List_TopoDS_Shape());
    args.Append(a);
    const tl = tmp(new O.NCollection_List_TopoDS_Shape());
    for (const t of tools) tl.Append(t);
    mk.SetArguments(args);
    mk.SetTools(tl);
    mk.SetFuzzyValue(BOOLEAN_FUZZY);
    mk.Build(progress());
    if (!mk.IsDone() || mk.HasErrors()) {
      mk.delete();
      throw new KernelError(`${kind} failed`);
    }
    return { shape: downcast(mk.Shape()), maker: mk };
  }));
}

export function simplify(shape: Shape): Built {
  const O = oc();
  return guard("simplify", () => {
    const mk = new O.ShapeUpgrade_UnifySameDomain(shape, true, true, false);
    mk.Build();
    return { shape: downcast(mk.Shape()), maker: null /* history via mk.History() not bound usefully */ };
  });
}

export type Trsf = { translate?: Vec3; rotate?: { origin: Vec3; axis: Vec3; angleRad: number }; mirror?: { origin: Vec3; normal: Vec3 } };

export function transform(shape: Shape, t: Trsf): Built {
  const O = oc();
  return guard("transform", () => scoped(() => {
    const tr = tmp(new O.gp_Trsf());
    if (t.translate) tr.SetTranslation(vec(t.translate));
    else if (t.rotate) tr.SetRotation(tmp(new O.gp_Ax1(pnt(t.rotate.origin), dir(t.rotate.axis))), t.rotate.angleRad);
    else if (t.mirror) tr.SetMirror(tmp(new O.gp_Ax2(pnt(t.mirror.origin), dir(t.mirror.normal))));
    const mk = new O.BRepBuilderAPI_Transform(shape, tr, !!t.mirror, false);
    return { shape: downcast(mk.Shape()), maker: mk };
  }));
}

/**
 * The shape placed by a rigid transform (rotation `r`, row-major 3×3, then translation `t`).
 * Cheap: a located copy that shares the geometry (assembly poses for booleans, distance, export).
 */
export function placed(shape: Shape, r: number[], t: Vec3): Shape {
  const O = oc();
  return scoped(() => {
    const tr = tmp(new O.gp_Trsf());
    tr.SetDisplacement(tmp(new O.gp_Ax3()), tmp(new O.gp_Ax3(pnt(t), dir([r[2], r[5], r[8]]), dir([r[0], r[3], r[6]]))));
    return shape.Moved(tmp(new O.TopLoc_Location(tr)), false);
  });
}

export function box(dx: number, dy: number, dz: number, corner: Vec3 = [0, 0, 0]): Built {
  const O = oc();
  return guard("box", () => scoped(() => {
    const mk = new O.BRepPrimAPI_MakeBox(pnt(corner), dx, dy, dz);
    return { shape: downcast(mk.Shape()), maker: null };
  }));
}

export function cylinder(radius: number, height: number, origin: Vec3 = [0, 0, 0], axis: Vec3 = [0, 0, 1]): Built {
  const O = oc();
  return guard("cylinder", () => scoped(() => {
    const mk = new O.BRepPrimAPI_MakeCylinder(tmp(new O.gp_Ax2(pnt(origin), dir(axis))), radius, height);
    const s = downcast(mk.Shape());
    mk.delete();
    return { shape: s, maker: null };
  }));
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ---------- M6: sweep, loft, shell, draft, thicken, split, offset ----------

const list = (shapes: Shape[]) => {
  const O = oc();
  const l = tmp(new O.NCollection_List_TopoDS_Shape());
  for (const x of shapes) l.Append(x);
  return l;
};

/**
 * How the profile is oriented along the path:
 * - `corrected` (default): corrected Frenet (BRepOffsetAPI_MakePipe), minimal twist on general paths.
 * - `frenet`: true Frenet trihedron.
 * - `{ binormal }`: the profile keeps a fixed binormal direction (helices: the helix axis, so a
 *   thread profile stays upright).
 */
export type SweepMode = "corrected" | "frenet" | { binormal: Vec3 };

/**
 * Sweep a profile (face or wire) along a path wire.
 * `roundCorners`: the path has sharp corners (a polyline). The profile then turns each corner on a
 * round bend, staying perpendicular to the path, instead of being sheared across the corner
 * (BRepOffsetAPI_MakePipe keeps the section's orientation through a kink, which flattens a round
 * rope to ~60% of its cross-section). Profiles with holes keep the plain pipe.
 */
export function sweep(profile: Shape, path: Shape, opts: { mode?: SweepMode; roundCorners?: boolean } = {}): Built {
  const O = oc();
  const mode = opts.mode ?? "corrected";
  return guard("sweep", () => scoped(() => {
    const holes = profile.ShapeType() === O.TopAbs_ShapeEnum.TopAbs_FACE && explore(profile, "wire").items.length > 1;
    if (mode === "corrected" && !(opts.roundCorners && !holes)) {
      const mk = new O.BRepOffsetAPI_MakePipe(O.TopoDS.Wire(path), profile);
      mk.Build(progress());
      if (!mk.IsDone()) throw new KernelError("sweep failed: check the profile sits at the start of the path and the path has no sharp kinks");
      return { shape: downcast(mk.Shape()), maker: mk, caps: { start: mk.FirstShape(), end: mk.LastShape() } };
    }
    // pipe shell: sweeps a wire; a face contributes its outer wire (holes aren't supported)
    let section = profile;
    const T = O.TopAbs_ShapeEnum;
    const kind = profile.ShapeType() === T.TopAbs_FACE ? "face" : profile.ShapeType() === T.TopAbs_WIRE ? "wire" : "other";
    if (kind === "face") {
      if (explore(profile, "wire").items.length > 1) throw new KernelError("sweep: this orientation mode can't sweep a profile with holes; sweep the outer outline and subtract a second sweep of the hole");
      section = tmp(O.BRepTools.OuterWire(O.TopoDS.Face(profile)));
    } else if (kind !== "wire") throw new KernelError("sweep: this orientation mode needs a single closed profile (one region, no holes)");
    const mk = new O.BRepOffsetAPI_MakePipeShell(O.TopoDS.Wire(path));
    if (mode === "frenet") mk.SetMode(true);
    else if (mode === "corrected") mk.SetMode(false);
    else mk.SetMode(dir(mode.binormal));
    if (opts.roundCorners) mk.SetTransitionMode(O.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
    mk.Add(section, false, false);
    try {
      mk.Build(progress());
    } catch (e) {
      mk.delete();
      throw new KernelError(`sweep failed: ${occtMessage(e)}`);
    }
    if (!mk.IsDone()) {
      mk.delete();
      throw new KernelError("sweep failed: check the profile sits at the start of the path, is small enough for the path's curvature, and the path has no sharp kinks");
    }
    if (kind === "face" && !mk.MakeSolid()) {
      mk.delete();
      throw new KernelError("sweep failed: the swept profile could not be closed into a solid");
    }
    return { shape: downcast(mk.Shape()), maker: mk, caps: { start: mk.FirstShape(), end: mk.LastShape() } };
  }));
}

export type HelixOpts = {
  radius: number;
  /** Axial distance per turn. */
  pitch: number;
  /** Axial length; give this or `turns`. */
  height?: number;
  turns?: number;
  origin?: Vec3;
  axis?: Vec3;
  /** Radial direction of the start point (default: perpendicular to the axis, see `helixXDir`). */
  xDir?: Vec3;
  leftHanded?: boolean;
  /** Half-angle (radians) of a conical helix: positive grows the radius along the axis. */
  taper?: number;
};

/** Default start direction of a helix around `axis`: Z → +X, X → +Y, Y → +Z, else a perpendicular. */
export function helixXDir(axis: Vec3): Vec3 {
  const l = Math.hypot(...axis);
  const a = axis.map((c) => c / l) as Vec3;
  const ref: Vec3 = Math.abs(a[2]) > 0.9 ? [1, 0, 0] : Math.abs(a[0]) > 0.9 ? [0, 1, 0] : Math.abs(a[1]) > 0.9 ? [0, 0, 1] : [1, 0, 0];
  const d = ref[0] * a[0] + ref[1] * a[1] + ref[2] * a[2];
  const x = ref.map((c, i) => c - d * a[i]) as Vec3;
  const xl = Math.hypot(...x);
  return x.map((c) => c / xl) as Vec3;
}

/** Helix edge (a line in the parameter space of a cylinder, or a cone when tapered). */
export function helixEdge(o: HelixOpts): Shape {
  return helixEdges(o, Infinity)[0];
}

/**
 * A helix as consecutive edges of at most `maxTurnsPerEdge` turns each (default ½), for sweep paths.
 * One multi-turn edge sweeps into a single face that wraps around its axis many times; OCCT's
 * booleans misclassify such faces (a 10-turn drum groove came out inverted or empty, with
 * unmeshable faces). Half-turn pieces keep every swept face under 180° of wrap, and each piece's
 * 3D curve is a small BSpline (degree ~10, ~11 poles) instead of one with hundreds of poles.
 */
export function helixEdges(o: HelixOpts, maxTurnsPerEdge = 0.5): Shape[] {
  const O = oc();
  return guard("helix", () => scoped(() => {
    const { radius, pitch } = o;
    const taper = o.taper ?? 0;
    if (!(radius > 0)) throw new KernelError(`helix radius must be positive (got ${radius})`);
    if (!(pitch > 0)) throw new KernelError(`helix pitch must be positive (got ${pitch})`);
    if (o.height === undefined && o.turns === undefined) throw new KernelError("helix needs a height or a number of turns");
    const height = o.height ?? o.turns! * pitch;
    if (!(height > 0)) throw new KernelError(`helix ${o.height === undefined ? "turns" : "height"} must be positive (got ${o.height ?? o.turns})`);
    if (!(Math.abs(taper) < Math.PI / 2 - 1e-6)) throw new KernelError(`helix taper must be between -90° and 90° (got ${(taper * 180) / Math.PI}°)`);
    const axis = o.axis ?? [0, 0, 1];
    const xDir = o.xDir ?? helixXDir(axis);
    const ax3 = tmp(new O.gp_Ax3(pnt(o.origin ?? [0, 0, 0]), dir(axis), dir(xDir)));
    const turns = height / pitch;
    // cone parameter v runs along the generatrix: z = v cos(taper)
    const dv = pitch / Math.cos(taper);
    if (taper && radius + turns * dv * Math.sin(taper) <= 0) throw new KernelError(`helix taper shrinks the radius to zero before height ${height}; use a smaller taper or height`);
    const surf = tmp(taper ? new O.Geom_ConicalSurface(ax3, taper, radius) : new O.Geom_CylindricalSurface(ax3, radius));
    const du = 2 * Math.PI * (o.leftHanded ? -1 : 1);
    const line = tmp(new O.Geom2d_Line(tmp(new O.gp_Pnt2d(0, 0)), tmp(new O.gp_Dir2d(du, dv))));
    const len = turns * Math.hypot(du, dv);
    const n = Number.isFinite(maxTurnsPerEdge) ? Math.max(1, Math.ceil(turns / maxTurnsPerEdge - 1e-9)) : 1;
    const out: Shape[] = [];
    for (let k = 0; k < n; k++) {
      const mk = tmp(new O.BRepBuilderAPI_MakeEdge(line, surf, (len * k) / n, (len * (k + 1)) / n));
      if (!mk.IsDone()) throw new KernelError("helix edge could not be built");
      const e = mk.Edge();
      O.BRepLib.BuildCurves3d(e, 1e-6, O.GeomAbs_Shape.GeomAbs_C1, 14, 200);
      out.push(e);
    }
    return out;
  }));
}

/** Loft through section wires (first to last). */
export function loft(sections: Shape[], opts: { solid?: boolean; ruled?: boolean } = {}): Built {
  const O = oc();
  return guard("loft", () => scoped(() => {
    if (sections.length < 2) throw new KernelError("loft needs at least two sections");
    const mk = new O.BRepOffsetAPI_ThruSections(opts.solid ?? true, opts.ruled ?? false, 1e-6);
    for (const w of sections) mk.AddWire(O.TopoDS.Wire(w));
    mk.CheckCompatibility(true);
    mk.Build(progress());
    if (!mk.IsDone()) throw new KernelError("loft failed: sections must be closed and compatible (same number of segments helps)");
    return { shape: downcast(mk.Shape()), maker: mk, caps: { start: mk.FirstShape(), end: mk.LastShape() } };
  }));
}

/** Hollow a solid, removing `openFaces`, walls of `thickness` (negative = inward, the default). */
export function shell(solid: Shape, openFaces: Shape[], thickness: number): Built {
  const O = oc();
  return guard("shell", () => scoped(() => {
    const mk = new O.BRepOffsetAPI_MakeThickSolid();
    mk.MakeThickSolidByJoin(solid, list(openFaces), -Math.abs(thickness), 1e-3, O.BRepOffset_Mode.BRepOffset_Skin, false, false, O.GeomAbs_JoinType.GeomAbs_Arc, false, progress());
    if (!mk.IsDone()) throw new KernelError(`shell failed: thickness ${Math.abs(thickness)} may be too large for the part's features`);
    return { shape: downcast(mk.Shape()), maker: mk };
  }));
}

/** Thicken a face/shell into a solid. */
export function thicken(shape: Shape, thickness: number): Built {
  const O = oc();
  return guard("thicken", () => scoped(() => {
    const mk = new O.BRepOffsetAPI_MakeThickSolid();
    mk.MakeThickSolidBySimple(shape, thickness);
    if (!mk.IsDone()) throw new KernelError("thicken failed");
    let out = downcast(mk.Shape());
    // depending on the face orientation the solid can come out inside-out: normalize
    const p = tmp(new O.GProp_GProps());
    O.BRepGProp.VolumeProperties(out, p, false, false, false);
    if (p.Mass() < 0) out = downcast(out.Reversed());
    return { shape: out, maker: mk };
  }));
}

/** Taper faces by `angleRad` about a neutral plane, pulling along `dir`. */
export function draft(solid: Shape, faces: Shape[], pull: Vec3, angleRad: number, planeOrigin: Vec3, planeNormal: Vec3): Built {
  const O = oc();
  return guard("draft", () => scoped(() => {
    const mk = new O.BRepOffsetAPI_DraftAngle(solid);
    const pln = tmp(new O.gp_Pln(pnt(planeOrigin), dir(planeNormal)));
    for (const f of faces) {
      mk.Add(O.TopoDS.Face(f), dir(pull), angleRad, pln, true);
      if (!mk.AddDone()) {
        mk.delete();
        throw new KernelError("draft failed on a face: drafted faces must be planar, cylindrical or conical and not parallel to the pull direction");
      }
    }
    mk.Build(progress());
    if (!mk.IsDone()) throw new KernelError("draft failed");
    return { shape: downcast(mk.Shape()), maker: mk };
  }));
}

/** Split a shape by tools (solids, faces or planes-as-faces); the result is a compound of pieces. */
export function split(shape: Shape, tools: Shape[]): Built {
  const O = oc();
  return guard("split", () => scoped(() => {
    const mk = new O.BRepAlgoAPI_Splitter();
    mk.SetArguments(list([shape]));
    mk.SetTools(list(tools));
    mk.Build(progress());
    if (!mk.IsDone() || mk.HasErrors()) throw new KernelError("split failed");
    return { shape: downcast(mk.Shape()), maker: mk };
  }));
}

/** Offset a planar face's outline by `d` (positive grows); inner loops become holes. */
export function offsetFace(face: Shape, d: number): Built {
  const O = oc();
  return guard("offset", () => scoped(() => {
    const mk = tmp(new O.BRepOffsetAPI_MakeOffset(O.TopoDS.Face(face), O.GeomAbs_JoinType.GeomAbs_Arc, false));
    mk.Perform(d, 0);
    if (!mk.IsDone()) throw new KernelError("offset failed");
    const wires = explore(mk.Shape(), "wire").items;
    if (!wires.length) throw new KernelError(`offset ${d} collapsed the profile`);
    const area = (w: Shape) => {
      const f = faceFromWires(w);
      f.maker?.delete?.();
      const p = tmp(new O.GProp_GProps());
      O.BRepGProp.SurfaceProperties(f.shape, p, false, false);
      return p.Mass();
    };
    const sorted = [...wires].sort((a, b) => area(b) - area(a));
    return faceFromWires(sorted[0], sorted.slice(1));
  }));
}

/** A large planar face (for splitting by a plane). */
export function planeFace(origin: Vec3, normal: Vec3, size: number): Shape {
  const O = oc();
  return scoped(() => {
    const pl = tmp(new O.gp_Pln(pnt(origin), dir(normal)));
    return tmp(new O.BRepBuilderAPI_MakeFace(pl, -size, size, -size, size)).Face();
  });
}
