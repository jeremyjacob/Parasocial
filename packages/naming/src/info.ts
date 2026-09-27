// Memoized per-entity geometric info for a record.
import { faceInfo, edgeInfo, vertexPoint, type FaceInfo, type EdgeInfo, type Vec3, type EntityKind } from "@parasocial/kernel";
import { entityShape, type OpRecord } from "./record";

type InfoCache = { face: FaceInfo[]; edge: EdgeInfo[]; vertex: Vec3[] };
const caches = new WeakMap<OpRecord, InfoCache>();

function cache(r: OpRecord): InfoCache {
  let c = caches.get(r);
  if (!c) caches.set(r, (c = { face: [], edge: [], vertex: [] }));
  return c;
}

export function faceOf(r: OpRecord, i: number): FaceInfo {
  const c = cache(r);
  return (c.face[i] ??= faceInfo(entityShape(r, "face", i)));
}
export function edgeOf(r: OpRecord, i: number): EdgeInfo {
  const c = cache(r);
  return (c.edge[i] ??= edgeInfo(entityShape(r, "edge", i)));
}
export function vertexOf(r: OpRecord, i: number): Vec3 {
  const c = cache(r);
  return (c.vertex[i] ??= vertexPoint(entityShape(r, "vertex", i)));
}

/** Representative point of an entity (face centroid, edge midpoint, vertex). */
export function centerOf(r: OpRecord, kind: EntityKind, i: number): Vec3 {
  if (kind === "face") return faceOf(r, i).center;
  if (kind === "edge") return edgeOf(r, i).mid;
  return vertexOf(r, i);
}

/** Principal direction: face normal (plane) / axis (cylinder, cone); line direction / circle axis. */
export function directionOf(r: OpRecord, kind: EntityKind, i: number): Vec3 | undefined {
  if (kind === "face") {
    const f = faceOf(r, i);
    return f.surface === "plane" ? f.normal : f.axis;
  }
  if (kind === "edge") {
    const e = edgeOf(r, i);
    return e.direction;
  }
  return undefined;
}

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
