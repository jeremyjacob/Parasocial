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

export function splineEdge(points: Vec3[], closed = false): Shape {
  const O = oc();
  return guard("spline", () => scoped(() => {
    if (points.length < 2) throw new KernelError("spline needs at least 2 points");
    const pts = closed ? [...points, points[0]] : points;
    const arr: any = tmp(new O.NCollection_Array1_gp_Pnt(1, pts.length));
    pts.forEach((p, i) => arr.SetValue(i + 1, pnt(p)));
    const b = tmp(new O.GeomAPI_PointsToBSpline());
    b.Init(arr, 3, 8, O.GeomAbs_Shape.GeomAbs_C2, 1e-4);
    if (!b.IsDone()) throw new KernelError("spline fit failed; check the points aren't coincident");
    return tmp(new O.BRepBuilderAPI_MakeEdge(tmp(b.Curve()))).Edge();
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
  const O = oc();
  return guard(kind, () => scoped(() => {
    const Ctor = kind === "union" ? O.BRepAlgoAPI_Fuse : kind === "subtract" ? O.BRepAlgoAPI_Cut : O.BRepAlgoAPI_Common;
    const mk = new Ctor(a, b, progress());
    if (!mk.IsDone() || mk.HasErrors?.()) {
      mk.delete();
      throw new KernelError(`${kind} failed`);
    }
    return { shape: downcast(mk.Shape()), maker: mk };
  }));
}

/** Boolean of `a` with several tools at once (one history for all). */
export function booleanMany(kind: BooleanKind, a: Shape, tools: Shape[]): Built {
  if (tools.length === 1) return boolean(kind, a, tools[0]);
  const O = oc();
  return guard(kind, () => scoped(() => {
    const mk = kind === "union" ? new O.BRepAlgoAPI_Fuse() : kind === "subtract" ? new O.BRepAlgoAPI_Cut() : new O.BRepAlgoAPI_Common();
    const args = tmp(new O.NCollection_List_TopoDS_Shape());
    args.Append(a);
    const tl = tmp(new O.NCollection_List_TopoDS_Shape());
    for (const t of tools) tl.Append(t);
    mk.SetArguments(args);
    mk.SetTools(tl);
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

/** Sweep a profile (face or wire) along a path wire. */
export function sweep(profile: Shape, path: Shape): Built {
  const O = oc();
  return guard("sweep", () => scoped(() => {
    // the two-argument form uses a corrected Frenet trihedron
    const mk = new O.BRepOffsetAPI_MakePipe(O.TopoDS.Wire(path), profile);
    mk.Build(progress());
    if (!mk.IsDone()) throw new KernelError("sweep failed: check the profile sits at the start of the path and the path has no sharp kinks");
    return { shape: downcast(mk.Shape()), maker: mk, caps: { start: mk.FirstShape(), end: mk.LastShape() } };
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
