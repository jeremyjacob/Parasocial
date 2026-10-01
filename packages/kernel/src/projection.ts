// Projections for 2D drawings: hidden-line removal (OCCT HLRBRep_Algo), edge discretization,
// and cutting a solid by a plane for section views. Everything comes back as plain polylines.
import { oc } from "./oc";
import { scoped, tmp } from "./memory";
import { explore, type Shape } from "./topo";
import { boolean, planeFace, prism } from "./ops";
import { boundingBox, faceInfo, type Vec3 } from "./geom";

export type P2 = [number, number];

/**
 * A view direction for a projection: `dir` points from the model toward the viewer (the eye looks
 * along -dir), `x` is the view's right. Up is `dir × x`.
 */
export type ViewFrame = { dir: Vec3; x: Vec3 };

export type Projected = {
  /** Sharp edges and silhouettes the viewer sees. */
  visible: P2[][];
  /** Tangent (smooth) edges the viewer sees: fillet boundaries. Drawn thin. */
  tangent: P2[][];
  /** Sharp edges and silhouettes behind material. */
  hidden: P2[][];
};

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Up of a view (its y axis). */
export const viewUp = (v: ViewFrame): Vec3 => norm(cross(v.dir, v.x));

/** A 3D point in a view's 2D coordinates (x right, y up), by orthographic projection. */
export function toView(v: ViewFrame, p: Vec3): P2 {
  return [dot(p, v.x), dot(p, viewUp(v))];
}

/**
 * Points along an edge, in its orientation: the ends of a line, else enough points that the chord
 * stays within `deflection` (and turns at most ~5° between points).
 */
export function edgePoints(edge: Shape, deflection: number): Vec3[] {
  const O = oc() as any;
  return scoped(() => {
    const ad = tmp(new O.BRepAdaptor_Curve(edge));
    const f = ad.FirstParameter(),
      l = ad.LastParameter();
    const at = (u: number): Vec3 => {
      const p = tmp(ad.Value(u));
      return [p.X(), p.Y(), p.Z()];
    };
    let out: Vec3[];
    if (ad.GetType() === O.GeomAbs_CurveType.GeomAbs_Line) out = [at(f), at(l)];
    else {
      // start from 8 spans (closed curves have no chord to test), then halve each span until its
      // midpoint is within `deflection` of the chord and it turns at most ~5°
      const tol = Math.max(deflection, 1e-5);
      const n0 = 8;
      out = [at(f)];
      const refine = (u0: number, p0: Vec3, u1: number, p1: Vec3, depth: number) => {
        const um = (u0 + u1) / 2;
        const pm = at(um);
        const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
        const mid: Vec3 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
        const dev = Math.hypot(pm[0] - mid[0], pm[1] - mid[1], pm[2] - mid[2]);
        // sagitta of a 5° arc over this chord
        if (depth < 10 && (dev > tol || (chord > 0 && dev > chord * 0.011))) {
          refine(u0, p0, um, pm, depth + 1);
          refine(um, pm, u1, p1, depth + 1);
        } else out.push(p1);
      };
      let u0 = f,
        p0 = out[0];
      for (let i = 1; i <= n0; i++) {
        const u1 = f + ((l - f) * i) / n0;
        const p1 = at(u1);
        refine(u0, p0, u1, p1, 0);
        u0 = u1;
        p0 = p1;
      }
    }
    if (edge.Orientation() === O.TopAbs_Orientation.TopAbs_REVERSED) out.reverse();
    return out;
  });
}

function compoundEdges(c: Shape, deflection: number): P2[][] {
  const O = oc() as any;
  if (!c || c.IsNull()) return [];
  const out: P2[][] = [];
  const edges = explore(c, "edge");
  for (const e of edges.items) {
    try {
      O.BRepLib.BuildCurves3d(e);
      const pts = edgePoints(e, deflection);
      // HLR results lie in the projector's plane: x right, y up, z = 0
      out.push(pts.map((p) => [p[0], p[1]] as P2));
    } catch {}
    e.delete();
  }
  return out;
}

/**
 * Hidden-line removal of `shape` seen along a view (orthographic): visible and hidden edges and
 * silhouettes in the view's 2D coordinates (model units).
 */
export function projectHLR(shape: Shape, view: ViewFrame, opts: { hidden?: boolean; deflection?: number } = {}): Projected {
  const O = oc() as any;
  const bb = boundingBox(shape);
  const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
  const deflection = opts.deflection ?? diag / 2000;
  return scoped(() => {
    const ax = tmp(new O.gp_Ax2(tmp(new O.gp_Pnt(0, 0, 0)), tmp(new O.gp_Dir(...norm(view.dir))), tmp(new O.gp_Dir(...norm(view.x)))));
    const algo = tmp(new O.HLRBRep_Algo());
    algo.Add(shape, 0);
    algo.Projector(tmp(new O.HLRAlgo_Projector(ax)));
    algo.Update();
    algo.Hide();
    const res = tmp(new O.HLRBRep_HLRToShape(algo));
    const take = (c: Shape) => {
      const r = compoundEdges(c, deflection);
      c?.delete?.();
      return r;
    };
    const visible = [...take(res.VCompound()), ...take(res.OutLineVCompound())];
    const tangent = take(res.Rg1LineVCompound());
    const hidden = opts.hidden === false ? [] : [...take(res.HCompound()), ...take(res.OutLineHCompound())];
    return { visible, tangent, hidden };
  });
}

/**
 * Cut `shape` by the plane through `origin` with normal `normal`, keeping the material on the
 * -normal side (the side a viewer standing on +normal looks at). Returns the cut solid and its
 * faces lying in the plane (the cut faces, to hatch). Null when the plane misses the shape.
 */
export function sectionCut(shape: Shape, origin: Vec3, normal: Vec3): { shape: Shape; faces: Shape[] } | null {
  const n = norm(normal);
  const bb = boundingBox(shape);
  const size = 2 * Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) + 10;
  // a slab on the kept side, big enough to cover the shape
  const face = planeFace(origin, n, size * 2);
  const slab = prism(face, [-n[0] * size * 2, -n[1] * size * 2, -n[2] * size * 2]);
  slab.maker?.delete?.();
  face.delete?.();
  let cut;
  try {
    cut = boolean("intersect", shape, slab.shape);
  } finally {
    slab.shape.delete?.();
  }
  cut.maker?.delete?.();
  const faces = explore(cut.shape, "face").items;
  if (!faces.length) {
    cut.shape.delete?.();
    return null;
  }
  const d0 = dot(origin, n);
  const tol = 1e-4 * Math.max(1, size);
  const onPlane: Shape[] = [];
  for (const f of faces) {
    const info = faceInfo(f);
    if (info.surface === "plane" && Math.abs(Math.abs(dot(info.normal, n)) - 1) < 1e-6 && Math.abs(dot(info.center, n) - d0) < tol) onPlane.push(f);
    else f.delete();
  }
  return { shape: cut.shape, faces: onPlane };
}

/** A tight bounding box (exact geometry, no triangulation or tolerance padding): for dimensions. */
export function exactBox(shape: Shape): { min: Vec3; max: Vec3 } {
  const O = oc() as any;
  return scoped(() => {
    const box = tmp(new O.Bnd_Box());
    O.BRepBndLib.AddOptimal(shape, box, false, false);
    if (box.IsVoid()) return { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
    return { min: [box.GetXMin(), box.GetYMin(), box.GetZMin()] as Vec3, max: [box.GetXMax(), box.GetYMax(), box.GetZMax()] as Vec3 };
  });
}

/** The boundary loops of a face as closed 3D polylines (outer and holes, chained from its edges). */
export function faceLoops(face: Shape, deflection: number): Vec3[][] {
  const edges = explore(face, "edge").items;
  const segs = edges.map((e) => {
    const p = edgePoints(e, deflection);
    e.delete();
    return p;
  });
  return chain(segs, deflection * 10 + 1e-6);
}

/** Join polylines end to end into loops (an edge's direction may be either way). */
export function chain<T extends number[]>(segs: T[][], tol: number): T[][] {
  const d = (a: T, b: T) => Math.hypot(...a.map((v, i) => v - b[i]));
  const left = segs.filter((s) => s.length >= 2).map((s) => [...s]);
  const out: T[][] = [];
  while (left.length) {
    const loop = left.shift()!;
    for (let grew = true; grew && d(loop[0], loop[loop.length - 1]) > tol; ) {
      grew = false;
      const end = loop[loop.length - 1];
      for (let i = 0; i < left.length; i++) {
        const s = left[i];
        if (d(s[0], end) <= tol) loop.push(...s.slice(1));
        else if (d(s[s.length - 1], end) <= tol) loop.push(...[...s].reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(loop);
  }
  return out;
}
