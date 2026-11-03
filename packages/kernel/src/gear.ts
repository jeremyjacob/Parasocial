// Gear bodies: a closed transverse profile (computed by the API) made into a spur, helical or
// herringbone solid in one step. Helical flanks are the profile swept along the gear axis while it
// turns at a constant rate (a pipe shell guided by a helical auxiliary spine), so each profile edge
// becomes exactly one face; a herringbone sews two such arms swept away from one apex outline.
import { oc, occtMessage, noteKernelFault } from "./oc";
import { tmp, scoped } from "./memory";
import { downcast, explore, type Shape } from "./topo";
import { isValid, type Vec3 } from "./geom";
import { KernelError, lineEdge, arcEdge3, splineEdge, wireFromEdges, faceFromWires, circleEdge, helixEdge, booleanMany, type Built } from "./ops";

/** One edge of the transverse profile, at z = the profile plane. */
export type GearProfileEdge =
  | { kind: "line"; a: Vec3; b: Vec3 }
  | { kind: "arc"; a: Vec3; mid: Vec3; b: Vec3 }
  /** Interpolating spline through `pts` with the given end tangents (involute flanks, roots). */
  | { kind: "spline"; pts: Vec3[]; t0: Vec3; t1: Vec3 };

export type GearBodyOpts = {
  /** Closed profile, counterclockwise, lying in the plane z = `zProfile`. */
  edges: GearProfileEdge[];
  /** Face width: the body spans z = 0..width. */
  width: number;
  /** Where the profile lies: 0 for spur and helical gears, the apex for a herringbone. */
  zProfile: number;
  /** Turn of the profile per mm of z (radians, + is counterclockwise about +Z as z grows). 0: spur. */
  twist: number;
  /** Herringbone: the profile turns by twist·|z − apex| on both sides of the apex (= zProfile). */
  herringbone?: boolean;
  /** Plain bore diameter. */
  bore?: number;
};

const SWEEP_TOL = 1e-6;

/** A gear body (see GearBodyOpts). No history: the API names its faces from their geometry. */
export function gearBody(o: GearBodyOpts): Built {
  const O = oc();
  return scoped(() => {
    try {
      const edges = o.edges.map(profileEdge);
      const wire = wireFromEdges(edges);
      let body: Shape;
      if (!o.twist) {
        const holes = o.bore ? [wireFromEdges([circleEdge([0, 0, o.zProfile], [0, 0, 1], o.bore / 2)])] : [];
        const face = faceFromWires(wire, holes);
        face.maker?.delete?.();
        const mk = tmp(new O.BRepPrimAPI_MakePrism(face.shape, tmp(new O.gp_Vec(0, 0, o.width)), false, true));
        if (!mk.IsDone()) throw new KernelError("gear: extrude failed");
        return { shape: downcast(mk.Shape()), maker: null };
      }
      if (!o.herringbone) {
        const arm = twistSweep(wire, o.zProfile, o.width, o.twist);
        body = sewSolid([...arm.sides, capFace(arm.start), capFace(arm.end)]);
      } else {
        const up = twistSweep(wire, o.zProfile, o.width, o.twist);
        const down = twistSweep(wire, o.zProfile, 0, o.twist);
        body = sewSolid([...up.sides, ...down.sides, capFace(up.end), capFace(down.end)]);
      }
      if (o.bore) {
        const cyl = tmp(new O.BRepPrimAPI_MakeCylinder(tmp(new O.gp_Ax2(tmp(new O.gp_Pnt(0, 0, -1)), tmp(new O.gp_Dir(0, 0, 1)))), o.bore / 2, o.width + 2));
        const cut = booleanMany("subtract", body, [tmp(downcast(cyl.Shape()))]);
        cut.maker?.delete?.();
        body.delete();
        body = cut.shape;
      }
      if (!isValid(body)) throw new KernelError("gear: the body came out invalid; check the tooth count, module and helix angle");
      return { shape: body, maker: null };
    } catch (e) {
      if (e instanceof KernelError || noteKernelFault(e)) throw e;
      throw new KernelError(`gear failed: ${occtMessage(e)}`, e);
    }
  });
}

function profileEdge(e: GearProfileEdge): Shape {
  switch (e.kind) {
    case "line":
      return lineEdge(e.a, e.b);
    case "arc":
      return arcEdge3(e.a, e.mid, e.b);
    case "spline":
      return splineEdge(e.pts, { startTangent: e.t0, endTangent: e.t1 });
  }
}

/**
 * Sweep `wire` (in the plane z = z0) along the axis to z = z1 while it turns `twist` rad per mm
 * travelled: a straight spine with a helical auxiliary spine, so each section is the profile
 * rotated about the axis. Returns the side faces and the wires at both ends.
 */
function twistSweep(wire: Shape, z0: number, z1: number, twist: number): { sides: Shape[]; start: Shape; end: Shape } {
  const O = oc();
  const h = Math.abs(z1 - z0);
  const up = z1 > z0;
  const spine = wireFromEdges([lineEdge([0, 0, z0], [0, 0, z1])]);
  // the aux helix turns +twist (about +Z) per mm travelled; about a −Z axis that is the other hand
  const lead = (2 * Math.PI) / Math.abs(twist);
  const ccw = twist > 0;
  const aux = wireFromEdges([helixEdge({ radius: 10, pitch: lead, height: h, origin: [0, 0, z0], axis: [0, 0, up ? 1 : -1], xDir: [1, 0, 0], leftHanded: up ? !ccw : ccw })]);
  const mk = tmp(new O.BRepOffsetAPI_MakePipeShell(O.TopoDS.Wire(spine)));
  mk.SetMode(O.TopoDS.Wire(aux), false, O.BRepFill_TypeOfContact.BRepFill_NoContact);
  mk.SetTolerance(SWEEP_TOL, SWEEP_TOL, 1e-3);
  mk.Add(wire, false, false);
  mk.Build(tmp(new O.Message_ProgressRange()));
  if (!mk.IsDone()) throw new KernelError("gear: the helical sweep failed; try a smaller helix angle");
  const faces = explore(mk.Shape(), "face");
  const sides = faces.items.map((f) => tmp(f));
  return { sides, start: tmp(mk.FirstShape()), end: tmp(mk.LastShape()) };
}

/** Planar face bounded by an end section wire. */
function capFace(w: Shape): Shape {
  const O = oc();
  const ws = explore(w, "wire");
  ws.items.forEach((x) => tmp(x));
  const wire = ws.items[0];
  if (!wire) throw new KernelError("gear: the sweep left no end section");
  const mk = tmp(new O.BRepBuilderAPI_MakeFace(O.TopoDS.Wire(wire), true));
  if (!mk.IsDone()) throw new KernelError("gear: an end face is not planar");
  return mk.Face();
}

/** Sew faces into one closed solid. */
function sewSolid(faces: Shape[]): Shape {
  const O = oc();
  const sew = tmp(new O.BRepBuilderAPI_Sewing(1e-5, true, true, true, false));
  for (const f of faces) sew.Add(f);
  sew.Perform(tmp(new O.Message_ProgressRange()));
  const sewn = downcast(sew.SewedShape());
  if (sew.NbFreeEdges() > 0) throw new KernelError(`gear: the faces don't close up (${sew.NbFreeEdges()} free edges)`);
  const shells = explore(sewn, "shell");
  if (shells.items.length !== 1) throw new KernelError(`gear: the faces sew into ${shells.items.length} shells`);
  const fix = tmp(new O.ShapeFix_Solid());
  const solid = fix.SolidFromShell(O.TopoDS.Shell(shells.items[0]));
  return downcast(solid);
}

/** A point in the middle of a face's parameter range, its normal and whether the face is planar (cheap: no integration). */
export function faceSample(face: Shape): { point: Vec3; normal: Vec3; planar: boolean } {
  const O = oc();
  return scoped(() => {
    const ad = tmp(new O.BRepAdaptor_Surface(face, true));
    const planar = ad.GetType() === O.GeomAbs_SurfaceType.GeomAbs_Plane;
    const b = O.BRepTools.UVBounds(face, 0, 0, 0, 0);
    const gf = tmp(new O.BRepGProp_Face(face, false));
    const p = tmp(new O.gp_Pnt(0, 0, 0));
    const n = tmp(new O.gp_Vec(0, 0, 0));
    gf.Normal((b.UMin + b.UMax) / 2, (b.VMin + b.VMax) / 2, p, n);
    const l = Math.hypot(n.X(), n.Y(), n.Z()) || 1;
    return { point: [p.X(), p.Y(), p.Z()], normal: [n.X() / l, n.Y() / l, n.Z() / l], planar };
  });
}
