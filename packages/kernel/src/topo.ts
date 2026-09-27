// Topology helpers: deduplicated sub-shape enumeration, identity, adjacency.
import { oc } from "./oc";

export type Shape = any; // TopoDS_Shape (embind)
export type EntityKind = "face" | "edge" | "vertex";

const HASH_MAX = 2147483647;

export function hashShape(s: Shape): number {
  return oc().ReplicadShapeHasher.HashCode(s, HASH_MAX);
}

export function kindEnum(kind: EntityKind | "solid" | "shell" | "wire") {
  const E = oc().TopAbs_ShapeEnum;
  switch (kind) {
    case "face":
      return E.TopAbs_FACE;
    case "edge":
      return E.TopAbs_EDGE;
    case "vertex":
      return E.TopAbs_VERTEX;
    case "solid":
      return E.TopAbs_SOLID;
    case "shell":
      return E.TopAbs_SHELL;
    case "wire":
      return E.TopAbs_WIRE;
  }
}

export function shapeKind(s: Shape): string {
  const E = oc().TopAbs_ShapeEnum;
  const t = s.ShapeType();
  for (const k of Object.keys(E)) if ((E as any)[k] === t) return k.replace("TopAbs_", "").toLowerCase();
  return "unknown";
}

export function downcast(s: Shape): Shape {
  const T = oc().TopoDS;
  switch (shapeKind(s)) {
    case "face":
      return T.Face(s);
    case "edge":
      return T.Edge(s);
    case "vertex":
      return T.Vertex(s);
    case "wire":
      return T.Wire(s);
    case "shell":
      return T.Shell(s);
    case "solid":
      return T.Solid(s);
    default:
      return s;
  }
}

/**
 * An ordered, deduplicated set of sub-shapes with O(1)-ish lookup (hash bucket + IsSame).
 * Indices are stable for a given shape (TopExp_Explorer order).
 */
export class ShapeIndex {
  readonly items: Shape[] = [];
  private buckets = new Map<number, number[]>();

  add(s: Shape): number {
    const h = hashShape(s);
    const b = this.buckets.get(h);
    if (b) for (const i of b) if (this.items[i].IsSame(s)) return i;
    const i = this.items.length;
    this.items.push(s);
    if (b) b.push(i);
    else this.buckets.set(h, [i]);
    return i;
  }

  indexOf(s: Shape): number {
    const b = this.buckets.get(hashShape(s));
    if (b) for (const i of b) if (this.items[i].IsSame(s)) return i;
    return -1;
  }

  indexOfHash(h: number, probe?: Shape): number {
    const b = this.buckets.get(h);
    if (!b) return -1;
    if (b.length === 1 || !probe) return b[0];
    for (const i of b) if (this.items[i].IsSame(probe)) return i;
    return -1;
  }

  get size() {
    return this.items.length;
  }

  delete() {
    for (const s of this.items) s.delete?.();
    this.items.length = 0;
    this.buckets.clear();
  }
}

/** Deduplicated, downcast sub-shapes of `kind`, in explorer order. */
export function explore(shape: Shape, kind: EntityKind | "solid" | "wire" | "shell"): ShapeIndex {
  const O = oc();
  const idx = new ShapeIndex();
  const ex = new O.TopExp_Explorer(shape, kindEnum(kind), O.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const cur = ex.Current();
    const d = downcast(cur);
    cur.delete();
    if (idx.indexOf(d) >= 0) d.delete();
    else idx.add(d);
  }
  ex.delete();
  return idx;
}

/** Convert an OCCT list (NCollection_List_TopoDS_Shape) to an array of downcast shapes. Doesn't consume the list. */
export function listToArray(list: any): Shape[] {
  const O = oc();
  const copy = new O.NCollection_List_TopoDS_Shape(list);
  const out: Shape[] = [];
  while (copy.Size() > 0) {
    out.push(downcast(copy.First()));
    copy.RemoveFirst();
  }
  copy.delete();
  return out;
}

export type Topology = {
  faces: ShapeIndex;
  edges: ShapeIndex;
  vertices: ShapeIndex;
  /** edge index -> face indices (1 for boundary/seam-only, 2 typical) */
  edgeFaces: number[][];
  /** face index -> edge indices */
  faceEdges: number[][];
  /** vertex index -> edge indices */
  vertexEdges: number[][];
  /** edge index -> [v0, v1] vertex indices (v1 === v0 for closed edges) */
  edgeVertices: number[][];
};

/** Enumerate faces/edges/vertices of a shape and their adjacency. */
export function topology(shape: Shape): Topology {
  const faces = explore(shape, "face");
  const edges = explore(shape, "edge");
  const vertices = explore(shape, "vertex");
  const edgeFaces: number[][] = edges.items.map(() => []);
  const faceEdges: number[][] = [];
  for (let f = 0; f < faces.size; f++) {
    const fe = explore(faces.items[f], "edge");
    const list: number[] = [];
    for (const e of fe.items) {
      const ei = edges.indexOf(e);
      if (ei >= 0) {
        if (!list.includes(ei)) list.push(ei);
        if (!edgeFaces[ei].includes(f)) edgeFaces[ei].push(f);
      }
    }
    fe.delete();
    faceEdges.push(list);
  }
  const vertexEdges: number[][] = vertices.items.map(() => []);
  const edgeVertices: number[][] = [];
  for (let e = 0; e < edges.size; e++) {
    const ev = explore(edges.items[e], "vertex");
    const list: number[] = [];
    for (const v of ev.items) {
      const vi = vertices.indexOf(v);
      if (vi >= 0) {
        list.push(vi);
        if (!vertexEdges[vi].includes(e)) vertexEdges[vi].push(e);
      }
    }
    ev.delete();
    if (list.length === 1) list.push(list[0]);
    edgeVertices.push(list);
  }
  return { faces, edges, vertices, edgeFaces, faceEdges, vertexEdges, edgeVertices };
}

export function deleteTopology(t: Topology) {
  t.faces.delete();
  t.edges.delete();
  t.vertices.delete();
}
