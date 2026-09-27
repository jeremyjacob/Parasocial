// Tessellation into transferable typed arrays, grouped by face / edge index.
import { oc } from "./oc";
import { hashShape, type ShapeIndex, type Shape } from "./topo";

export type MeshQuality = "coarse" | "fine";

export type MeshData = {
  positions: Float32Array; // xyz per vertex
  normals: Float32Array;
  indices: Uint32Array; // triangles
  /** per face index (in the caller's face order): [firstTriangleIndex*3, indexCount] pairs */
  faceRanges: Uint32Array;
  /** line segment pairs: xyz xyz per segment */
  edgePositions: Float32Array;
  /** per edge index: [firstVertex, vertexCount] into edgePositions (vertex = 3 floats) */
  edgeRanges: Uint32Array;
};

export function meshTolerances(bboxDiagonal: number, quality: MeshQuality) {
  const base = Math.min(Math.max(bboxDiagonal * 0.0008, 0.005), 0.2);
  return quality === "fine" ? { tolerance: base, angular: 0.14 } : { tolerance: base * 2, angular: 0.28 };
}

function heapCopy<T extends Float32Array | Uint32Array | Int32Array>(ctor: { new (b: ArrayBufferLike, o: number, l: number): T; BYTES_PER_ELEMENT: number }, ptr: number, size: number): T {
  const buf = oc().wasmMemory.buffer;
  const view = new ctor(buf, ptr >>> 0, size);
  return view.slice() as T; // copy out of the WASM heap into a fresh, transferable buffer
}

/**
 * Tessellate `shape`, mapping face groups onto `faces` and edge groups onto `edges`
 * (usually the op result's entity indices), so picking resolves directly to entities.
 */
export function tessellate(shape: Shape, faces: ShapeIndex, edges: ShapeIndex, tolerance: number, angular: number): MeshData {
  const O = oc();
  const raw = O.ReplicadMeshExtractor.extract(shape, tolerance, angular, false);
  const positions = heapCopy(Float32Array, raw.getVerticesPtr(), raw.getVerticesSize());
  const normals = heapCopy(Float32Array, raw.getNormalsPtr(), raw.getNormalsSize());
  const indices = heapCopy(Uint32Array, raw.getTrianglesPtr(), raw.getTrianglesSize());
  const groups = heapCopy(Int32Array, raw.getFaceGroupsPtr(), raw.getFaceGroupsSize());
  raw.delete();

  // Face groups come in explorer order, same as ShapeIndex order for a solid; verify via hash.
  const faceRanges = new Uint32Array(faces.size * 2);
  const nGroups = groups.length / 3;
  for (let g = 0; g < nGroups; g++) {
    const start = groups[g * 3],
      count = groups[g * 3 + 1],
      h = groups[g * 3 + 2];
    let fi = g < faces.size && hashShape(faces.items[g]) === h ? g : faces.indexOfHash(h);
    if (fi < 0) continue;
    faceRanges[fi * 2] = start;
    faceRanges[fi * 2 + 1] = count;
  }

  const eraw = O.ReplicadEdgeMeshExtractor.extract(shape, tolerance, angular);
  const edgePositions = heapCopy(Float32Array, eraw.getLinesPtr(), eraw.getLinesSize());
  const egroups = heapCopy(Int32Array, eraw.getEdgeGroupsPtr(), eraw.getEdgeGroupsSize());
  eraw.delete();
  const edgeRanges = new Uint32Array(edges.size * 2);
  for (let g = 0; g < egroups.length / 3; g++) {
    const ei = edges.indexOfHash(egroups[g * 3 + 2]);
    if (ei < 0) continue;
    edgeRanges[ei * 2] = egroups[g * 3];
    edgeRanges[ei * 2 + 1] = egroups[g * 3 + 1];
  }
  return { positions, normals, indices, faceRanges, edgePositions, edgeRanges };
}

export function meshTransferables(m: MeshData): ArrayBuffer[] {
  return [m.positions, m.normals, m.indices, m.faceRanges, m.edgePositions, m.edgeRanges].map((a) => a.buffer as ArrayBuffer);
}
