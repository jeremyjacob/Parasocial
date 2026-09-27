// One part in the scene: shaded faces, batched feature edges, highlight overlays, pick proxies.
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { withDepthBias } from "./depthbias";

export type EntityKind = "face" | "edge" | "vertex";
export type EntityRef = { part: string; kind: EntityKind; index: number };

/** What the viewer needs from a regeneration result (structurally compatible with PartResult). */
export type PartMesh = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceRanges: Uint32Array;
  edgePositions: Float32Array;
  edgeRanges: Uint32Array;
};

export type PartData = {
  id: string;
  mesh: PartMesh;
  faceEdges: number[][];
  /** edges to leave out of the drawn edge set (seams) */
  hiddenEdges?: Set<number>;
  color: string;
  /** last-good geometry after an error: drawn dimmed */
  dim?: boolean;
};

export const KIND_CODE: Record<EntityKind, number> = { face: 1, edge: 2, vertex: 3 };

/** 24-bit index + 2-bit kind + 6-bit part slot -> RGBA bytes (id 0 = nothing). */
export function encodeId(slot: number, kind: EntityKind, index: number): [number, number, number, number] {
  const v = index + 1;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, (KIND_CODE[kind] << 6) | (slot & 63)];
}

export function decodeId(r: number, g: number, b: number, a: number): { slot: number; kind: EntityKind; index: number } | null {
  const v = (r << 16) | (g << 8) | b;
  if (!v) return null;
  const k = a >> 6;
  const kind: EntityKind | undefined = k === 1 ? "face" : k === 2 ? "edge" : k === 3 ? "vertex" : undefined;
  if (!kind) return null;
  return { slot: a & 63, kind, index: v - 1 };
}

const FACE_PICK_VERT = /* glsl */ `
attribute float faceId;
varying float vFaceId;
#include <common>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
  vFaceId = faceId;
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
}`;
const FACE_PICK_FRAG = /* glsl */ `
uniform float slotKind;
varying float vFaceId;
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  #include <logdepthbuf_fragment>
  float v = floor(vFaceId + 0.5) + 1.0;
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, slotKind / 255.0);
}`;

/** Silhouette: back faces pushed out a fixed number of pixels along their screen-space normal. */
const SIL_VERT = /* glsl */ `
uniform vec2 resolution;
uniform float width;
#include <common>
#include <clipping_planes_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  vec4 clipN = projectionMatrix * modelViewMatrix * vec4(position + normal, 1.0);
  vec2 dir = normalize(clipN.xy / clipN.w - gl_Position.xy / gl_Position.w);
  gl_Position.xy += dir * width * 2.0 / resolution * gl_Position.w;
  #include <clipping_planes_vertex>
}`;
const SIL_FRAG = /* glsl */ `
uniform vec3 color;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vec4(color, 1.0);
}`;

export class PartObject {
  readonly group = new THREE.Group();
  readonly id: string;
  slot: number;
  data: PartData;
  faceMesh!: THREE.Mesh;
  edgeLines!: LineSegments2;
  pickFaces!: THREE.Mesh;
  pickEdges!: LineSegments2;
  overlay!: LineSegments2;
  silhouette!: THREE.Mesh;
  private silMaterial!: THREE.ShaderMaterial;
  /** per face: first vertex, vertex count (faces own contiguous vertex runs) */
  faceVerts!: Uint32Array;
  private baseColor = new THREE.Color();
  private colors!: Float32Array;
  private faceMaterial: THREE.MeshStandardMaterial;
  private edgeMaterial: LineMaterial;
  private overlayMaterial: LineMaterial;
  private pickFaceMaterial: THREE.ShaderMaterial;
  private pickEdgeMaterial: LineMaterial;

  constructor(data: PartData, slot: number, private resolution: THREE.Vector2) {
    this.id = data.id;
    this.slot = slot;
    this.data = data;
    this.group.name = data.id;
    this.faceMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      side: THREE.DoubleSide,
    });
    this.edgeMaterial = new LineMaterial({ color: 0x1f2023, linewidth: 1.15, resolution, worldUnits: false });
    this.overlayMaterial = withDepthBias(new LineMaterial({ vertexColors: true, linewidth: 2.4, resolution, worldUnits: false, depthTest: true })) as LineMaterial;
    this.pickFaceMaterial = new THREE.ShaderMaterial({
      vertexShader: FACE_PICK_VERT,
      fragmentShader: FACE_PICK_FRAG,
      uniforms: { slotKind: { value: (KIND_CODE.face << 6) | slot } },
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      toneMapped: false,
      blending: THREE.NoBlending,
    });
    this.pickEdgeMaterial = new LineMaterial({ vertexColors: true, linewidth: 9, resolution, worldUnits: false, toneMapped: false, blending: THREE.NoBlending });
    (this.pickEdgeMaterial as any).fog = false;
    this.build(data);
  }

  private build(d: PartData) {
    const m = d.mesh;
    const nv = m.positions.length / 3;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    this.colors = new Float32Array(nv * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    const faceId = new Float32Array(nv);
    const nFaces = m.faceRanges.length / 2;
    this.faceVerts = new Uint32Array(nFaces * 2);
    for (let f = 0; f < nFaces; f++) {
      const start = m.faceRanges[f * 2],
        count = m.faceRanges[f * 2 + 1];
      let lo = Infinity,
        hi = -1;
      for (let i = start; i < start + count; i++) {
        const v = m.indices[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi < 0) continue;
      this.faceVerts[f * 2] = lo;
      this.faceVerts[f * 2 + 1] = hi - lo + 1;
      faceId.fill(f, lo, hi + 1);
    }
    geo.setAttribute("faceId", new THREE.BufferAttribute(faceId, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    this.faceMesh = new THREE.Mesh(geo, this.faceMaterial);
    this.faceMesh.name = "faces";
    this.silMaterial = new THREE.ShaderMaterial({
      vertexShader: SIL_VERT,
      fragmentShader: SIL_FRAG,
      uniforms: { resolution: { value: this.resolution }, width: { value: 1.2 }, color: { value: new THREE.Color(0x1f2023) } },
      side: THREE.BackSide,
      toneMapped: false,
    });
    this.silhouette = new THREE.Mesh(geo, this.silMaterial);
    this.silhouette.renderOrder = -1;
    this.pickFaces = new THREE.Mesh(geo, this.pickFaceMaterial);
    this.pickFaces.visible = false;

    // feature edges (seams excluded), one batched object
    const segs = this.edgeSegments([...Array(m.edgeRanges.length / 2).keys()].filter((e) => !d.hiddenEdges?.has(e)));
    const eg = new LineSegmentsGeometry();
    eg.setPositions(segs.positions);
    this.edgeLines = new LineSegments2(eg, this.edgeMaterial);
    this.edgeLines.name = "edges";
    this.edgeLines.renderOrder = 1;

    // edge pick proxy: wide lines, id colors per segment
    const pg = new LineSegmentsGeometry();
    pg.setPositions(segs.positions);
    const ids = new Float32Array(segs.positions.length);
    for (let s = 0; s < segs.edgeOfSegment.length; s++) {
      const c = encodeId(this.slot, "edge", segs.edgeOfSegment[s]);
      for (let k = 0; k < 2; k++) {
        ids[s * 6 + k * 3] = c[0] / 255;
        ids[s * 6 + k * 3 + 1] = c[1] / 255;
        ids[s * 6 + k * 3 + 2] = c[2] / 255;
      }
    }
    pg.setColors(ids);
    this.pickEdges = new LineSegments2(pg, this.pickEdgeMaterial);
    this.pickEdges.visible = false;
    // alpha carries kind + slot; LineMaterial writes alpha = opacity, so encode it there
    this.pickEdgeMaterial.opacity = ((KIND_CODE.edge << 6) | this.slot) / 255;
    this.pickEdgeMaterial.transparent = false;

    this.overlay = new LineSegments2(new LineSegmentsGeometry(), this.overlayMaterial);
    this.overlay.renderOrder = 2;
    this.overlay.visible = false;

    this.group.add(this.faceMesh, this.silhouette, this.edgeLines, this.overlay, this.pickFaces, this.pickEdges);
  }

  /** Line segment positions for the given edges, plus which edge each segment belongs to. */
  edgeSegments(edges: number[]) {
    const m = this.data.mesh;
    let n = 0;
    for (const e of edges) n += m.edgeRanges[e * 2 + 1];
    const positions = new Float32Array(n * 3);
    const edgeOfSegment = new Uint32Array(n / 2);
    let o = 0;
    for (const e of edges) {
      const start = m.edgeRanges[e * 2] * 3,
        count = m.edgeRanges[e * 2 + 1] * 3;
      positions.set(m.edgePositions.subarray(start, start + count), o);
      edgeOfSegment.fill(e, o / 6, (o + count) / 6);
      o += count;
    }
    return { positions, edgeOfSegment };
  }

  setSlot(slot: number) {
    this.slot = slot;
    this.pickFaceMaterial.uniforms.slotKind.value = (KIND_CODE.face << 6) | slot;
    this.pickEdgeMaterial.opacity = ((KIND_CODE.edge << 6) | slot) / 255;
    // edge ids don't include the slot (it's in alpha), nothing else to update
  }

  /** Recolor faces: base color, with per-face overrides (selection tint, error tint). */
  paint(base: THREE.Color, tints: Map<number, { color: THREE.Color; amount: number }>, dim: number, dimTo: THREE.Color) {
    this.baseColor.copy(base);
    const c = new THREE.Color();
    const b = base.clone().lerp(dimTo, dim);
    for (let i = 0; i < this.colors.length; i += 3) (this.colors[i] = b.r), (this.colors[i + 1] = b.g), (this.colors[i + 2] = b.b);
    for (const [f, t] of tints) {
      const lo = this.faceVerts[f * 2],
        cnt = this.faceVerts[f * 2 + 1];
      c.copy(b).lerp(t.color, t.amount);
      for (let v = lo; v < lo + cnt; v++) (this.colors[v * 3] = c.r), (this.colors[v * 3 + 1] = c.g), (this.colors[v * 3 + 2] = c.b);
    }
    (this.faceMesh.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Orange/red strokes: explicit edges plus the outlines of faces. */
  setOverlay(strokes: { edges: number[]; color: THREE.Color }[]) {
    const all: { positions: Float32Array; color: THREE.Color }[] = [];
    for (const s of strokes) if (s.edges.length) all.push({ positions: this.edgeSegments(s.edges).positions, color: s.color });
    const n = all.reduce((a, s) => a + s.positions.length, 0);
    if (!n) {
      this.overlay.visible = false;
      return;
    }
    const pos = new Float32Array(n);
    const col = new Float32Array(n);
    let o = 0;
    for (const s of all) {
      pos.set(s.positions, o);
      for (let i = 0; i < s.positions.length; i += 3) (col[o + i] = s.color.r), (col[o + i + 1] = s.color.g), (col[o + i + 2] = s.color.b);
      o += s.positions.length;
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    g.setColors(col);
    this.overlay.geometry.dispose();
    this.overlay.geometry = g;
    this.overlay.visible = true;
  }

  setEmissive(amount: number) {
    this.faceMaterial.emissive.setRGB(amount * 0.35, amount * 0.55, amount);
  }

  setSilhouette(visible: boolean, color: THREE.Color) {
    this.silhouette.visible = visible;
    this.silMaterial.uniforms.color.value.copy(color);
  }

  setEdgeStyle(color: THREE.Color, width: number, opacity = 1) {
    this.edgeMaterial.color.copy(color);
    this.edgeMaterial.linewidth = width;
    this.edgeMaterial.opacity = opacity;
    this.edgeMaterial.transparent = opacity < 1;
  }

  setFaceStyle(o: { visible: boolean; opacity?: number; flat?: THREE.Color | null }) {
    this.faceMesh.visible = o.visible;
    const op = o.opacity ?? 1;
    this.faceMaterial.opacity = op;
    this.faceMaterial.transparent = op < 1;
    this.faceMaterial.depthWrite = op >= 1;
    if (o.flat) {
      this.faceMaterial.vertexColors = false;
      this.faceMaterial.color.copy(o.flat);
      this.faceMaterial.emissive.copy(o.flat);
      this.faceMaterial.emissiveIntensity = 1;
    } else {
      this.faceMaterial.vertexColors = true;
      this.faceMaterial.color.set(0xffffff);
      this.faceMaterial.emissive.set(0x000000);
    }
    this.faceMaterial.needsUpdate = true;
  }

  /** Swap to pick materials for the ID pass. */
  pickMode(on: boolean, edgesPickable: boolean, facesPickable: boolean) {
    if (this.cap) this.cap.visible = !on && !!this.faceMaterial.clippingPlanes;
    this.faceMesh.visible = !on && this.faceMesh.userData.shown !== false;
    this.silhouette.visible = !on && this.silhouette.userData.shown === true;
    this.edgeLines.visible = !on;
    this.overlay.visible = !on && this.overlay.geometry.attributes.instanceStart !== undefined && this.overlay.userData.active === true;
    this.pickFaces.visible = on && facesPickable;
    this.pickEdges.visible = on && edgesPickable;
  }

  faceCenter(f: number, target: THREE.Vector3): THREE.Vector3 {
    const m = this.data.mesh;
    const lo = this.faceVerts[f * 2],
      cnt = this.faceVerts[f * 2 + 1];
    target.set(0, 0, 0);
    for (let v = lo; v < lo + cnt; v++) target.x += m.positions[v * 3], target.y += m.positions[v * 3 + 1], target.z += m.positions[v * 3 + 2];
    return cnt ? target.divideScalar(cnt) : target;
  }

  private cap: THREE.Mesh | null = null;

  /** Section view: clip everything of this part; inside surfaces render flat in `capColor`, reading as a cut. */
  setClip(planes: THREE.Plane[], capColor: THREE.Color) {
    const mats = [this.faceMaterial, this.edgeMaterial, this.overlayMaterial, this.pickFaceMaterial, this.pickEdgeMaterial, this.silMaterial] as THREE.Material[];
    for (const m of mats) {
      m.clippingPlanes = planes.length ? planes : null;
      (m as any).clipping = planes.length > 0;
      m.needsUpdate = true;
    }
    if (planes.length) {
      if (!this.cap) {
        this.cap = new THREE.Mesh(this.faceMesh.geometry, new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: capColor, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
        this.cap.renderOrder = -0.5;
        this.group.add(this.cap);
      }
      const cm = this.cap.material as THREE.MeshBasicMaterial;
      cm.color.copy(capColor);
      cm.clippingPlanes = planes;
      cm.needsUpdate = true;
      this.cap.visible = true;
    } else if (this.cap) this.cap.visible = false;
  }

  dispose() {
    if (this.cap) (this.cap.material as THREE.Material).dispose();
    this.faceMesh.geometry.dispose();
    this.edgeLines.geometry.dispose();
    this.pickEdges.geometry.dispose();
    this.overlay.geometry.dispose();
    this.faceMaterial.dispose();
    this.silMaterial.dispose();
    this.edgeMaterial.dispose();
    this.overlayMaterial.dispose();
    this.pickFaceMaterial.dispose();
    this.pickEdgeMaterial.dispose();
  }
}
