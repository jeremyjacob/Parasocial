// Connectors: named frames on a part that assembly joints attach to. Built from geometry (a face,
// an edge, a vertex), so they follow the part when its params change.
import { faceOf, edgeOf, vertexOf } from "@parasocial/naming";
import type { Vec3 } from "@parasocial/kernel";
import { EntitySet } from "./selection";
import { Plane, axisVec, vec, type AxisLike } from "./plane";
import { userError } from "./op";

/** A coordinate frame: origin, z axis (the joint axis or normal) and x axis, in the part's coordinates. */
export type ConnectorFrame = { origin: Vec3; z: Vec3; x: Vec3 };

/**
 * Where a connector (or a joint) sits:
 * - one face, edge or vertex: a planar face gives its center and outward normal; a cylindrical or
 *   conical face, or a circular edge, gives its axis (through the center); a straight edge its
 *   midpoint and direction; a vertex its point (z up);
 * - a plane: its origin and normal (x along the plane's x);
 * - `{ origin, axis?, x? }`: explicit (axis defaults to Z).
 */
export type FrameSpec = EntitySet | Plane | { origin: Vec3; axis?: AxisLike; x?: AxisLike };

/** @internal */
export function toFrame(at: FrameSpec, what: string): ConnectorFrame {
  if (at instanceof Plane) return orient(at.origin, at.normal, at.xDir);
  if (at instanceof EntitySet) {
    if (at.length !== 1) userError(`${what}: select exactly one face, edge or vertex (got ${at.length} ${at.kind}s)`);
    const r = at.record,
      i = at.indices[0];
    if (at.kind === "face") {
      const f = faceOf(r, i);
      if (f.axis && f.origin && f.surface !== "plane") {
        // on the axis, level with the face's centroid
        const along = vec.dot([f.center[0] - f.origin[0], f.center[1] - f.origin[1], f.center[2] - f.origin[2]], f.axis);
        return orient(vec.add(f.origin, vec.scale(f.axis, along)), f.axis);
      }
      return orient(f.center, f.normal);
    }
    if (at.kind === "edge") {
      const e = edgeOf(r, i);
      if (e.center && e.axis) return orient(e.center, e.axis);
      if (e.direction) return orient(e.mid, e.direction);
      return orient(e.mid, [0, 0, 1]);
    }
    return orient(vertexOf(r, i), [0, 0, 1]);
  }
  if (at && typeof at === "object" && Array.isArray((at as any).origin)) {
    const o = at as { origin: Vec3; axis?: AxisLike; x?: AxisLike };
    if (o.origin.length !== 3 || !o.origin.every(Number.isFinite)) userError(`${what}: origin must be [x, y, z]`);
    return orient(o.origin, axisVec(o.axis ?? "Z"), o.x === undefined ? undefined : axisVec(o.x));
  }
  return userError(`${what}: expected a face/edge/vertex selection, a plane, or { origin: [x, y, z], axis: "X" }`);
}

/** Orthonormal frame with z along `z`; x along `x` when given (projected), else a stable choice. */
function orient(origin: Vec3, z: Vec3, x?: Vec3): ConnectorFrame {
  const n = vec.unit(z);
  let xd = x ? vec.add(x, vec.scale(n, -vec.dot(x, n))) : null;
  if (!xd || Math.hypot(...xd) < 1e-9) xd = Math.abs(n[2]) < 0.9 ? vec.cross([0, 0, 1], n) : vec.cross(n, [1, 0, 0]);
  return { origin: [...origin] as Vec3, z: n, x: vec.unit(xd) };
}

type Transform = { translate?: Vec3; rotate?: { origin: Vec3; axis: Vec3; angleRad: number }; mirror?: { origin: Vec3; normal: Vec3 } };

/** @internal Move a connector with its solid (translate, rotate, mirror). */
export function transformFrame(f: ConnectorFrame, t: Transform): ConnectorFrame {
  const point = (p: Vec3) => {
    if (t.translate) return vec.add(p, t.translate);
    if (t.rotate) return vec.add(rot(vec.add(p, vec.scale(t.rotate.origin, -1)), t.rotate.axis, t.rotate.angleRad), t.rotate.origin);
    if (t.mirror) return vec.add(p, vec.scale(t.mirror.normal, -2 * vec.dot(vec.add(p, vec.scale(t.mirror.origin, -1)), t.mirror.normal)));
    return p;
  };
  const dir = (d: Vec3) => {
    if (t.rotate) return rot(d, t.rotate.axis, t.rotate.angleRad);
    if (t.mirror) return vec.add(d, vec.scale(t.mirror.normal, -2 * vec.dot(d, t.mirror.normal)));
    return d;
  };
  return { origin: point(f.origin), z: dir(f.z), x: dir(f.x) };
}

function rot(v: Vec3, axis: Vec3, a: number): Vec3 {
  const k = vec.unit(axis);
  return vec.add(vec.add(vec.scale(v, Math.cos(a)), vec.scale(vec.cross(k, v), Math.sin(a))), vec.scale(k, vec.dot(k, v) * (1 - Math.cos(a))));
}
