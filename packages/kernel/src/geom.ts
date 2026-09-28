// Geometric queries on faces, edges, vertices and solids. All values in model units (mm).
import { oc } from "./oc";
import { scoped, tmp } from "./memory";
import type { Shape } from "./topo";

export type Vec3 = [number, number, number];

export type SurfaceType = "plane" | "cylinder" | "cone" | "sphere" | "torus" | "bspline" | "bezier" | "revolution" | "extrusion" | "offset" | "other";
export type CurveType = "line" | "circle" | "ellipse" | "hyperbola" | "parabola" | "bspline" | "bezier" | "offset" | "other";

export type FaceInfo = {
  surface: SurfaceType;
  area: number;
  center: Vec3; // centroid
  normal: Vec3; // outward normal at the UV mid-point (orientation-corrected)
  /** plane: origin; cylinder/cone/sphere/torus: axis origin */
  origin?: Vec3;
  axis?: Vec3; // cylinder/cone/torus axis
  radius?: number; // cylinder/sphere/torus major
};

export type EdgeInfo = {
  curve: CurveType;
  length: number;
  start: Vec3;
  end: Vec3;
  mid: Vec3;
  direction?: Vec3; // line direction (unit)
  center?: Vec3; // circle/ellipse center
  axis?: Vec3; // circle normal
  radius?: number;
  closed: boolean;
};

const p3 = (p: any): Vec3 => [p.X(), p.Y(), p.Z()];

function enumName(e: any, family: any): string {
  for (const k of Object.keys(family)) if (family[k] === e) return k;
  return "";
}

const SURF: Record<string, SurfaceType> = {
  GeomAbs_Plane: "plane",
  GeomAbs_Cylinder: "cylinder",
  GeomAbs_Cone: "cone",
  GeomAbs_Sphere: "sphere",
  GeomAbs_Torus: "torus",
  GeomAbs_BSplineSurface: "bspline",
  GeomAbs_BezierSurface: "bezier",
  GeomAbs_SurfaceOfRevolution: "revolution",
  GeomAbs_SurfaceOfExtrusion: "extrusion",
  GeomAbs_OffsetSurface: "offset",
};
const CURVE: Record<string, CurveType> = {
  GeomAbs_Line: "line",
  GeomAbs_Circle: "circle",
  GeomAbs_Ellipse: "ellipse",
  GeomAbs_Hyperbola: "hyperbola",
  GeomAbs_Parabola: "parabola",
  GeomAbs_BSplineCurve: "bspline",
  GeomAbs_BezierCurve: "bezier",
  GeomAbs_OffsetCurve: "offset",
};

export function faceInfo(face: Shape): FaceInfo {
  const O = oc();
  return scoped(() => {
    const ad = tmp(new O.BRepAdaptor_Surface(face, true));
    const surface = SURF[enumName(ad.GetType(), O.GeomAbs_SurfaceType)] ?? "other";
    const props = tmp(new O.GProp_GProps());
    O.BRepGProp.SurfaceProperties(face, props, false, false);
    const area = props.Mass();
    const center = p3(tmp(props.CentreOfMass()));
    // normal at UV middle
    const b = O.BRepTools.UVBounds(face, 0, 0, 0, 0);
    const u = (b.UMin + b.UMax) / 2,
      v = (b.VMin + b.VMax) / 2;
    const gf = tmp(new O.BRepGProp_Face(face, false));
    const pnt = tmp(new O.gp_Pnt(0, 0, 0));
    const nv = tmp(new O.gp_Vec(0, 0, 0));
    gf.Normal(u, v, pnt, nv);
    let normal: Vec3 = [nv.X(), nv.Y(), nv.Z()];
    const len = Math.hypot(...normal) || 1;
    normal = normal.map((c) => c / len) as Vec3;
    const info: FaceInfo = { surface, area, center, normal };
    // some surface accessors (e.g. gp_Torus) aren't bound in every build: best effort
    try {
      if (surface === "plane") {
        const pl = tmp(ad.Plane());
        info.origin = p3(tmp(pl.Location()));
      } else if (surface === "cylinder") {
        const c = tmp(ad.Cylinder());
        const ax = tmp(c.Axis());
        info.origin = p3(tmp(ax.Location()));
        info.axis = p3(tmp(ax.Direction()));
        info.radius = c.Radius();
      } else if (surface === "cone") {
        const c: any = tmp((ad as any).Cone());
        const ax = tmp(c.Axis());
        info.origin = p3(tmp(ax.Location()));
        info.axis = p3(tmp(ax.Direction()));
        info.radius = c.RefRadius();
      } else if (surface === "sphere") {
        const s = tmp(ad.Sphere());
        info.origin = p3(tmp(s.Location()));
        info.radius = s.Radius();
      } else if (surface === "torus") {
        const t: any = tmp((ad as any).Torus());
        const ax = tmp(t.Axis());
        info.origin = p3(tmp(ax.Location()));
        info.axis = p3(tmp(ax.Direction()));
        info.radius = t.MajorRadius();
      }
    } catch {}
    return info;
  });
}

export function edgeInfo(edge: Shape): EdgeInfo {
  const O = oc();
  return scoped(() => {
    const ad = tmp(new O.BRepAdaptor_Curve(edge));
    const curve = CURVE[enumName(ad.GetType(), O.GeomAbs_CurveType)] ?? "other";
    const f = ad.FirstParameter(),
      l = ad.LastParameter();
    const reversed = edge.Orientation() === O.TopAbs_Orientation.TopAbs_REVERSED;
    let start = p3(tmp(ad.Value(f)));
    let end = p3(tmp(ad.Value(l)));
    if (reversed) [start, end] = [end, start];
    const mid = p3(tmp(ad.Value((f + l) / 2)));
    const props = tmp(new O.GProp_GProps());
    O.BRepGProp.LinearProperties(edge, props, false, false);
    const length = props.Mass();
    const closed = Math.hypot(start[0] - end[0], start[1] - end[1], start[2] - end[2]) < 1e-7;
    const info: EdgeInfo = { curve, length, start, end, mid, closed };
    if (curve === "line") {
      const d = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
      const n = Math.hypot(d[0], d[1], d[2]) || 1;
      info.direction = [d[0] / n, d[1] / n, d[2] / n];
    } else if (curve === "circle") {
      const c = tmp(ad.Circle());
      const ax = tmp(c.Axis());
      info.center = p3(tmp(c.Location()));
      info.axis = p3(tmp(ax.Direction()));
      info.radius = c.Radius();
    } else if (curve === "ellipse") {
      const c = tmp(ad.Ellipse());
      info.center = p3(tmp(c.Location()));
      info.radius = c.MajorRadius();
    }
    return info;
  });
}

export function vertexPoint(v: Shape): Vec3 {
  const O = oc();
  return scoped(() => p3(tmp(O.BRep_Tool.Pnt(v))));
}

export type BBox = { min: Vec3; max: Vec3 };

export function boundingBox(shape: Shape): BBox {
  const O = oc();
  return scoped(() => {
    const box = tmp(new O.Bnd_Box());
    O.BRepBndLib.Add(shape, box, true);
    if (box.IsVoid()) return { min: [0, 0, 0], max: [0, 0, 0] };
    return { min: [box.GetXMin(), box.GetYMin(), box.GetZMin()], max: [box.GetXMax(), box.GetYMax(), box.GetZMax()] };
  });
}

export type MassProps = { volume: number; area: number; centroid: Vec3 };

export function massProps(shape: Shape): MassProps {
  const O = oc();
  return scoped(() => {
    const vp = tmp(new O.GProp_GProps());
    O.BRepGProp.VolumeProperties(shape, vp, false, false, false);
    const sp = tmp(new O.GProp_GProps());
    O.BRepGProp.SurfaceProperties(shape, sp, false, false);
    return { volume: vp.Mass(), area: sp.Mass(), centroid: p3(tmp(vp.CentreOfMass())) };
  });
}

export function isValid(shape: Shape): boolean {
  const O = oc();
  return scoped(() => tmp(new O.BRepCheck_Analyzer(shape, true, false, false)).IsValid());
}

export type Distance = { distance: number; a: Vec3; b: Vec3 };

export function distance(a: Shape, b: Shape): Distance {
  const O = oc();
  return scoped(() => {
    const d = tmp(new O.BRepExtrema_DistShapeShape(a, b));
    d.Perform(tmp(new O.Message_ProgressRange()));
    if (!d.IsDone() || d.NbSolution() < 1) throw new Error("distance computation failed");
    return { distance: d.Value(), a: p3(tmp(d.PointOnShape1(1))), b: p3(tmp(d.PointOnShape2(1))) };
  });
}

/** Distance from a point to a shape (face/edge/vertex/solid). */
export function pointDistance(shape: Shape, p: Vec3): Distance {
  const O = oc();
  return scoped(() => {
    const v = tmp(new O.BRepBuilderAPI_MakeVertex(tmp(new O.gp_Pnt(p[0], p[1], p[2])))).Vertex();
    tmp(v);
    return distance(v, shape);
  });
}

/** Unit tangent of an edge at its start or end (in the edge's orientation). */
export function edgeTangent(edge: Shape, atEnd: boolean): Vec3 {
  const O = oc();
  return scoped(() => {
    const ad = tmp(new O.BRepAdaptor_Curve(edge));
    const reversed = edge.Orientation() === O.TopAbs_Orientation.TopAbs_REVERSED;
    const u = atEnd !== reversed ? ad.LastParameter() : ad.FirstParameter();
    const p = tmp(new O.gp_Pnt(0, 0, 0));
    const v = tmp(new O.gp_Vec(0, 0, 0));
    ad.D1(u, p, v);
    let t: Vec3 = [v.X(), v.Y(), v.Z()];
    if (reversed) t = [-t[0], -t[1], -t[2]];
    const l = Math.hypot(...t) || 1;
    return [t[0] / l, t[1] / l, t[2] / l];
  });
}

/** `n` points evenly spaced in parameter along an edge (in its orientation), end point excluded. */
export function sampleEdge(edge: Shape, n: number): Vec3[] {
  const O = oc();
  return scoped(() => {
    const ad = tmp(new O.BRepAdaptor_Curve(edge));
    const f = ad.FirstParameter(),
      l = ad.LastParameter();
    const rev = edge.Orientation() === O.TopAbs_Orientation.TopAbs_REVERSED;
    const out: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out.push(p3(tmp(ad.Value(rev ? l - (l - f) * t : f + (l - f) * t))));
    }
    return out;
  });
}

/**
 * Whether the two faces meet tangent-continuously (G1 or better) along `edge`: fillet
 * boundaries, coplanar splits. CAD viewers leave these out of the drawn edges.
 */
export function isSmoothEdge(edge: Shape, f1: Shape, f2: Shape, angTolRad = (1 * Math.PI) / 180): boolean {
  const O = oc();
  try {
    return O.BRepLib.ContinuityOfFaces(edge, f1, f2, angTolRad) !== O.GeomAbs_Shape.GeomAbs_C0;
  } catch {
    return false;
  }
}
