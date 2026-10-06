// One part in the scene: shaded faces, batched feature edges, highlight overlays, pick proxies.
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { withDepthBias } from "./depthbias";
import { withScreenShading } from "./shading";
import { findPieces, makeBuildUniforms, pieceVolumes, withBuild, writeBuild, type BuildPiece, type BuildUniforms } from "./build";

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
  /** vertex positions (part coordinates), by vertex index */
  vertices?: readonly (readonly [number, number, number])[];
  /** edges to leave out of the drawn edge set (seams) */
  hiddenEdges?: Set<number>;
  color: string;
  /** Script-set finish (all 0..1): opacity below 1 draws the part see-through. */
  appearance?: { opacity?: number; roughness?: number; metalness?: number };
  /** last-good geometry after an error: drawn dimmed */
  dim?: boolean;
};

/** Face roughness when the script doesn't set one: satin plastic. */
const DEFAULT_ROUGHNESS = 0.42;

export const KIND_CODE: Record<EntityKind, number> = { face: 1, edge: 2, vertex: 3 };

/**
 * ID buffer pixels are float RGBA: r = index + 1 (0 = nothing), g = part slot, b = kind code. Each is
 * an exact integer up to 2^24, so neither parts nor entities are limited by the encoding.
 */
export function decodeId(r: number, g: number, b: number): { slot: number; kind: EntityKind; index: number } | null {
  const v = Math.round(r);
  if (v <= 0) return null;
  const k = Math.round(b);
  const kind: EntityKind | undefined = k === 1 ? "face" : k === 2 ? "edge" : k === 3 ? "vertex" : undefined;
  if (!kind) return null;
  return { slot: Math.round(g), kind, index: v - 1 };
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
uniform float slot;
uniform float kind;
uniform bool pickable;
varying float vFaceId;
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  #include <logdepthbuf_fragment>
  gl_FragColor = pickable ? vec4(floor(vFaceId + 0.5) + 1.0, slot, kind, 1.0) : vec4(0.0);
}`;

/** Vertex pick proxy: a disc per vertex, `size` device px across. */
const VERT_PICK_VERT = /* glsl */ `
attribute float vertexId;
uniform float size;
varying float vId;
#include <common>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
  vId = vertexId;
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  gl_PointSize = size;
}`;
const VERT_PICK_FRAG = /* glsl */ `
uniform float slot;
uniform float kind;
varying float vId;
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  #include <clipping_planes_fragment>
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(floor(vId + 0.5) + 1.0, slot, kind, 1.0);
}`;

/** Highlighted vertices: a disc fading from transparent at the centre to the full colour at its rim, `size` CSS px across. */
const MARKER_VERT = /* glsl */ `
attribute vec3 color;
uniform float size;
uniform float pixelRatio;
varying vec3 vColor;
varying float vPx;
#include <common>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
  vColor = color;
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  gl_PointSize = size * pixelRatio;
  vPx = 2.0 / gl_PointSize; // one device pixel, in units of the disc's radius
}`;
const MARKER_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vPx;
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  #include <clipping_planes_fragment>
  #include <logdepthbuf_fragment>
  // the rim is at full colour: fade its last pixel so the edge is antialiased
  // centre at 40% (not clear) rising smoothly to full at the rim
  float a = mix(0.4, 1.0, smoothstep(0.0, 1.0, r));
  gl_FragColor = vec4(vColor, a * (1.0 - smoothstep(1.0 - vPx, 1.0, r)));
  #include <colorspace_fragment>
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
  vec4 clipN = projectionMatrix * modelViewMatrix * vec4(transformed + normal, 1.0);
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
  // same output transform as built-in materials: without it the direct (moving) path shows the
  // linear colour, darker and redder than the composer path, so the outline flickers on orbit
  #include <colorspace_fragment>
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
  pickVerts!: THREE.Points;
  overlay!: LineSegments2;
  /** highlighted vertices (selected, preselected, errors) */
  markers!: THREE.Points;
  /** vertex indices worth picking: corners and ends of drawn edges (not a circle's lone seam vertex) */
  pickableVertices!: Set<number>;
  silhouette!: THREE.Mesh;
  private silMaterial!: THREE.ShaderMaterial;
  /** Selected-part outline: stencil mask of the whole part, then a screen-space hull outside it. */
  private outlineMask!: THREE.Mesh;
  private outline!: THREE.Mesh;
  /** per face: first vertex, vertex count (faces own contiguous vertex runs) */
  faceVerts!: Uint32Array;
  private baseColor = new THREE.Color();
  private colors!: Float32Array;
  private faceMaterial: THREE.MeshStandardMaterial;
  private edgeMaterial: LineMaterial;
  private overlayMaterial: LineMaterial;
  private pickFaceMaterial: THREE.ShaderMaterial;
  private pickEdgeMaterial: LineMaterial;
  private pickVertMaterial: THREE.ShaderMaterial;
  private markerMaterial: THREE.ShaderMaterial;
  private edgesVisibleBeforePick = true;
  /** Opacity the script asked for; display fades multiply into it. */
  readonly baseOpacity: number;
  /** Build animation: each piece's bounds (part coordinates) and volume; see setBuild. */
  buildBoxes: THREE.Box3[] = [];
  buildVolumes: number[] = [];
  private buildAttrs!: { verts: Int32Array; segs: Int32Array; mesh: Record<"a" | "b" | "c", THREE.BufferAttribute>; lines: Record<"a" | "b" | "c", THREE.BufferAttribute> };

  constructor(
    data: PartData,
    slot: number,
    private resolution: THREE.Vector2,
    pixelRatio: { value: number } = { value: 1 },
    private buildUniforms: BuildUniforms = makeBuildUniforms(),
  ) {
    this.id = data.id;
    this.slot = slot;
    this.data = data;
    this.group.name = data.id;
    const a = data.appearance ?? {};
    this.baseOpacity = clamp01(a.opacity ?? 1);
    this.faceMaterial = withScreenShading(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: clamp01(a.roughness ?? DEFAULT_ROUGHNESS),
        metalness: clamp01(a.metalness ?? 0),
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        side: THREE.DoubleSide,
      }),
    );
    this.edgeMaterial = new LineMaterial({ color: 0x1f2023, linewidth: 1.15, resolution, worldUnits: false });
    this.overlayMaterial = withDepthBias(new LineMaterial({ vertexColors: true, linewidth: 2.4, resolution, worldUnits: false, depthTest: true })) as LineMaterial;
    this.pickFaceMaterial = new THREE.ShaderMaterial({
      vertexShader: FACE_PICK_VERT,
      fragmentShader: FACE_PICK_FRAG,
      uniforms: { slot: { value: slot }, kind: { value: KIND_CODE.face }, pickable: { value: true } },
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 8,
      toneMapped: false,
      blending: THREE.NoBlending,
    });
    // Wide edge proxies test against surfaces, but must not hide the vertices at their ends.
    this.pickEdgeMaterial = new LineMaterial({ vertexColors: true, linewidth: 15, resolution, worldUnits: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending });
    (this.pickEdgeMaterial as any).fog = false;
    this.pickVertMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT_PICK_VERT,
      fragmentShader: VERT_PICK_FRAG,
      uniforms: { slot: { value: slot }, kind: { value: KIND_CODE.vertex }, size: { value: 16 } },
      toneMapped: false,
      blending: THREE.NoBlending,
    });
    this.markerMaterial = withDepthBias(
      new THREE.ShaderMaterial({ vertexShader: MARKER_VERT, fragmentShader: MARKER_FRAG, uniforms: { size: { value: 10 }, pixelRatio }, transparent: true, depthWrite: false }),
      0.002,
    ) as THREE.ShaderMaterial;
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
    // build animation: every vertex rides with its piece (filled in by setBuild)
    const nEdges = m.edgeRanges.length / 2;
    const pieces = findPieces(nFaces, nEdges, d.faceEdges);
    this.buildBoxes = Array.from({ length: pieces.count }, () => new THREE.Box3());
    const vertPiece = new Int32Array(nv);
    const pt = new THREE.Vector3();
    for (let f = 0; f < nFaces; f++) {
      const lo = this.faceVerts[f * 2],
        cnt = this.faceVerts[f * 2 + 1];
      vertPiece.fill(pieces.faces[f], lo, lo + cnt);
      for (let v = lo; v < lo + cnt; v++) this.buildBoxes[pieces.faces[f]].expandByPoint(pt.fromArray(m.positions, v * 3));
    }
    const meshBuild = { a: new THREE.BufferAttribute(new Float32Array(nv * 4), 4), b: new THREE.BufferAttribute(new Float32Array(nv * 4), 4), c: new THREE.BufferAttribute(new Float32Array(nv * 4), 4) };
    geo.setAttribute("buildA", meshBuild.a);
    geo.setAttribute("buildB", meshBuild.b);
    geo.setAttribute("buildC", meshBuild.c);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    this.faceMesh = new THREE.Mesh(geo, this.faceMaterial);
    // viewer FACE_LAYER: the opaque faces AO and the halo are computed from, and the depth the
    // helpers drawn after them test against. A translucent part stays out and blends in last.
    if (!this.translucent) this.faceMesh.layers.enable(2);
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
    // Selected part (§8 Selection): an outline at its visible silhouette that shows through other
    // parts but never over itself. The mask marks every pixel the part covers (ignoring depth);
    // the hull, drawn on top of everything, only lands outside that mask.
    this.outlineMask = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ colorWrite: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp }),
    );
    this.outlineMask.renderOrder = 20;
    const om = this.silMaterial.clone();
    om.uniforms = { resolution: { value: this.resolution }, width: { value: 2 }, color: { value: new THREE.Color(0xff8a00) } };
    Object.assign(om, { depthTest: false, depthWrite: false, transparent: true, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.KeepStencilOp });
    this.outline = new THREE.Mesh(geo, om);
    withBuild(this.faceMaterial, this.buildUniforms, "mesh");
    withBuild(this.silMaterial, this.buildUniforms, "mesh");
    this.outline.renderOrder = 21;
    this.outlineMask.visible = this.outline.visible = false;
    this.pickFaces = new THREE.Mesh(geo, this.pickFaceMaterial);
    this.pickFaces.visible = false;

    // feature edges (seams excluded), one batched object
    const segs = this.edgeSegments([...Array(m.edgeRanges.length / 2).keys()].filter((e) => !d.hiddenEdges?.has(e)));
    const eg = new LineSegmentsGeometry();
    eg.setPositions(segs.positions);
    // each edge segment rides with its edge's piece
    const nSeg = segs.edgeOfSegment.length;
    const segPiece = Int32Array.from(segs.edgeOfSegment, (e) => pieces.edges[e]);
    for (let s = 0; s < nSeg; s++) this.buildBoxes[segPiece[s]].expandByPoint(pt.fromArray(segs.positions, s * 6)).expandByPoint(pt.fromArray(segs.positions, s * 6 + 3));
    const lineBuild = { a: new THREE.InstancedBufferAttribute(new Float32Array(nSeg * 4), 4), b: new THREE.InstancedBufferAttribute(new Float32Array(nSeg * 4), 4), c: new THREE.InstancedBufferAttribute(new Float32Array(nSeg * 4), 4) };
    eg.setAttribute("buildA", lineBuild.a);
    eg.setAttribute("buildB", lineBuild.b);
    eg.setAttribute("buildC", lineBuild.c);
    withBuild(this.edgeMaterial, this.buildUniforms, "line");
    this.buildVolumes = pieceVolumes(m.positions, m.indices, vertPiece, this.buildBoxes);
    this.buildAttrs = { verts: vertPiece, segs: segPiece, mesh: meshBuild, lines: lineBuild };
    this.edgeLines = new LineSegments2(eg, this.edgeMaterial);
    this.edgeLines.name = "edges";
    this.edgeLines.renderOrder = 1;

    // edge pick proxy: wide lines; vertex colors (index + 1, 1, 1) times the material color (1, slot, kind)
    const pg = new LineSegmentsGeometry();
    pg.setPositions(segs.positions);
    const ids = new Float32Array(segs.positions.length).fill(1);
    for (let s = 0; s < segs.edgeOfSegment.length; s++) ids[s * 6] = ids[s * 6 + 3] = segs.edgeOfSegment[s] + 1;
    pg.setColors(ids);
    this.pickEdges = new LineSegments2(pg, this.pickEdgeMaterial);
    this.pickEdges.renderOrder = 1;
    const pickViewport = new THREE.Vector4();
    this.pickEdges.onBeforeRender = (renderer) => {
      // LineSegments2 uses the canvas viewport by default, but picking renders into a small target.
      renderer.getCurrentViewport(pickViewport);
      this.pickEdgeMaterial.resolution.set(pickViewport.z, pickViewport.w);
    };
    this.pickEdges.visible = false;
    this.pickEdgeMaterial.color.setRGB(1, this.slot, KIND_CODE.edge);
    this.pickEdgeMaterial.transparent = false;

    // vertex pick proxy: a disc per pickable vertex, id colors per point
    this.pickableVertices = this.cornerVertices(d);
    const vIds = [...this.pickableVertices];
    const vPos = new Float32Array(vIds.length * 3);
    const vNum = new Float32Array(vIds.length);
    vIds.forEach((v, k) => {
      vPos.set(d.vertices![v], k * 3);
      vNum[k] = v;
    });
    const vg = new THREE.BufferGeometry();
    vg.setAttribute("position", new THREE.BufferAttribute(vPos, 3));
    vg.setAttribute("vertexId", new THREE.BufferAttribute(vNum, 1));
    this.pickVerts = new THREE.Points(vg, this.pickVertMaterial);
    this.pickVerts.renderOrder = 2;
    this.pickVerts.visible = false;
    this.pickVerts.frustumCulled = false;

    this.overlay = new LineSegments2(new LineSegmentsGeometry(), this.overlayMaterial);
    this.overlay.renderOrder = 2;
    this.overlay.visible = false;
    this.markers = new THREE.Points(new THREE.BufferGeometry(), this.markerMaterial);
    this.markers.renderOrder = 3;
    this.markers.visible = false;
    this.markers.frustumCulled = false;

    this.group.add(this.faceMesh, this.silhouette, this.edgeLines, this.overlay, this.markers, this.pickFaces, this.pickEdges, this.pickVerts, this.outlineMask, this.outline);
  }

  /**
   * Vertices where a drawn edge starts or ends, except those on only one closed edge: a full
   * circle's seam vertex is a kernel artifact, not a corner anyone means to pick.
   */
  private cornerVertices(d: PartData): Set<number> {
    const out = new Set<number>();
    const vs = d.vertices;
    if (!vs?.length) return out;
    const m = d.mesh;
    const box = new THREE.Box3().setFromArray(m.positions);
    const tol = Math.max(box.min.distanceTo(box.max) * 1e-5, 1e-7);
    const key = (x: number, y: number, z: number) => `${Math.round(x / tol / 4)},${Math.round(y / tol / 4)},${Math.round(z / tol / 4)}`;
    // endpoint -> [drawn edges touching it, whether any of them is open]
    const ends = new Map<string, { edges: Set<number>; open: boolean }>();
    const P = m.edgePositions;
    for (let e = 0; e < m.edgeRanges.length / 2; e++) {
      const s = m.edgeRanges[e * 2],
        c = m.edgeRanges[e * 2 + 1];
      if (!c || d.hiddenEdges?.has(e)) continue;
      const a = s * 3,
        b = (s + c - 1) * 3;
      const open = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]) > tol;
      for (const o of [a, b]) {
        const k = key(P[o], P[o + 1], P[o + 2]);
        const r = ends.get(k) ?? { edges: new Set(), open: false };
        r.edges.add(e);
        r.open ||= open;
        ends.set(k, r);
      }
    }
    vs.forEach(([x, y, z], i) => {
      const r = ends.get(key(x, y, z));
      if (r && (r.open || r.edges.size > 1)) out.add(i);
    });
    return out;
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

  /** Build animation: each piece's flight, indexed like buildBoxes. */
  setBuild(pieces: BuildPiece[]) {
    writeBuild(this.buildAttrs.mesh, this.buildAttrs.verts, pieces);
    writeBuild(this.buildAttrs.lines, this.buildAttrs.segs, pieces);
  }

  setSlot(slot: number) {
    this.slot = slot;
    this.pickFaceMaterial.uniforms.slot.value = slot;
    this.pickEdgeMaterial.color.setRGB(1, slot, KIND_CODE.edge);
    this.pickVertMaterial.uniforms.slot.value = slot;
    // the section cap's draw order depends on the slot
    this.orderCap();
  }

  /** Recolor faces: base color, with per-face overrides (selection tint, error tint). */
  paint(base: THREE.Color, tints: Map<number, { color: THREE.Color; amount: number }>, dim: number, dimTo: THREE.Color) {
    this.baseColor.copy(base);
    const c = new THREE.Color();
    const b = base.clone().lerp(dimTo, dim);
    this.capColor.copy(b);
    this.syncCapColor();
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

  /** Dots on highlighted vertices. */
  setMarkers(marks: { vertex: number; color: THREE.Color }[]) {
    const vs = this.data.vertices ?? [];
    const ok = marks.filter((m) => vs[m.vertex]);
    const pos = new Float32Array(ok.length * 3),
      col = new Float32Array(ok.length * 3);
    ok.forEach((m, k) => (pos.set(vs[m.vertex], k * 3), col.set([m.color.r, m.color.g, m.color.b], k * 3)));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.markers.geometry.dispose();
    this.markers.geometry = g;
    this.markers.userData.active = ok.length > 0;
    this.markers.visible = ok.length > 0;
  }

  setOutline(on: boolean, color?: THREE.Color) {
    this.outlineMask.visible = this.outline.visible = on;
    this.outlineMask.userData.shown = on;
    if (color) (this.outline.material as THREE.ShaderMaterial).uniforms.color.value.copy(color);
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

  /** The script made this part see-through (not a passing fade). */
  get translucent() {
    return this.baseOpacity < 1;
  }

  setFaceStyle(o: { visible: boolean; opacity?: number; flat?: THREE.Color | null }) {
    this.faceMesh.visible = o.visible;
    const op = (o.opacity ?? 1) * this.baseOpacity;
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
      this.faceMaterial.emissive.setRGB(0, 0, 0);
    }
    this.faceMaterial.needsUpdate = true;
  }

  /**
   * Swap to pick materials for the ID pass. `px` sizes the proxies in device pixels: edge proxy
   * width and vertex disc diameter.
   */
  pickMode(on: boolean, edgesPickable: boolean, facesPickable: boolean, verticesPickable = false, px = { edge: 15, vertex: 16 }) {
    this.showCap(!on && !!this.faceMaterial.clippingPlanes && this.cap?.userData.shown === true);
    if (this.capBorder) this.capBorder.visible = !on && !!this.faceMaterial.clippingPlanes && this.capBorder.geometry.attributes.instanceStart !== undefined;
    this.faceMesh.visible = !on && this.faceMesh.userData.shown !== false;
    this.silhouette.visible = !on && this.silhouette.userData.shown === true;
    this.outlineMask.visible = this.outline.visible = !on && this.outlineMask.userData.shown === true;
    // Picking is temporary: preserve display-mode and comparison-fade visibility.
    if (on) this.edgesVisibleBeforePick = this.edgeLines.visible;
    this.edgeLines.visible = !on && this.edgesVisibleBeforePick;
    this.overlay.visible = !on && this.overlay.geometry.attributes.instanceStart !== undefined && this.overlay.userData.active === true;
    // Filtered-out faces still occlude edges and vertices; a zero ID keeps them unselectable.
    this.pickFaces.visible = on;
    this.pickFaceMaterial.uniforms.pickable.value = facesPickable;
    this.pickEdges.visible = on && edgesPickable;
    this.pickVerts.visible = on && verticesPickable && this.pickableVertices.size > 0;
    this.markers.visible = !on && this.markers.userData.active === true;
    this.pickEdgeMaterial.linewidth = px.edge;
    this.pickVertMaterial.uniforms.size.value = px.vertex;
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
  /** Stencil passes that mark where the section plane lies inside the part (back +1, front −1). */
  private capStencil: THREE.Mesh[] = [];
  private capColor = new THREE.Color();
  /** Outline of the cut: where the section plane crosses the part's surface. */
  private capBorder: LineSegments2 | null = null;

  /**
   * Section view: clip everything of this part, and fill the cut with a solid cap on the plane
   * itself, in the part's colour, hatched with thin dark lines. The cap is a quad on the plane,
   * drawn only where the plane is inside the solid: the clipped surfaces' back faces add one to
   * the stencil and front faces subtract one, so the count is nonzero exactly there. Being on the
   * plane, it hides everything inside the part behind the cut. The hatch is laid out on the plane
   * in world space, so it stays attached to the model while orbiting; angle and spacing vary per part.
   */
  setClip(planes: THREE.Plane[], hatch?: { angle: number; spacing: number; pixelRatio: number }) {
    const mats = [this.faceMaterial, this.edgeMaterial, this.overlayMaterial, this.pickFaceMaterial, this.pickEdgeMaterial, this.pickVertMaterial, this.markerMaterial, this.silMaterial, this.outlineMask.material, this.outline.material] as THREE.Material[];
    for (const m of mats) {
      m.clippingPlanes = planes.length ? planes : null;
      (m as any).clipping = planes.length > 0;
      m.needsUpdate = true;
    }
    // back faces of the part would cover the cap; while cut, only front faces shade
    this.faceMaterial.side = planes.length ? THREE.FrontSide : THREE.DoubleSide;
    // the inverted-hull silhouette would draw over the cap from inside the cut
    this.silMaterial.visible = !planes.length;
    if (planes.length) {
      if (!this.cap) {
        const mat = new THREE.MeshBasicMaterial({
          side: THREE.DoubleSide,
          stencilWrite: true,
          stencilRef: 0,
          stencilFunc: THREE.NotEqualStencilFunc,
          stencilFail: THREE.KeepStencilOp,
          stencilZFail: THREE.KeepStencilOp,
          stencilZPass: THREE.KeepStencilOp,
        });
        mat.userData.hatch = {
          hatchColor: { value: new THREE.Color() },
          hatchPx: { value: 1 },
          hatchDir: { value: new THREE.Vector3() },
          hatchSpacing: { value: 1 },
        };
        mat.onBeforeCompile = (sh) => {
          Object.assign(sh.uniforms, mat.userData.hatch);
          sh.vertexShader = sh.vertexShader
            .replace("void main() {", "varying vec3 vHatchWorld;\nvoid main() {")
            .replace("#include <project_vertex>", "#include <project_vertex>\nvHatchWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
          sh.fragmentShader = sh.fragmentShader
            .replace("void main() {", "uniform vec3 hatchColor;\nuniform float hatchPx;\nuniform vec3 hatchDir;\nuniform float hatchSpacing;\nvarying vec3 vHatchWorld;\nvoid main() {")
            .replace(
              "#include <color_fragment>",
              `#include <color_fragment>
            float s = dot(vHatchWorld, hatchDir) / hatchSpacing;
            float fw = max(fwidth(s), 1e-6);
            float px = abs(fract(s + 0.5) - 0.5) / fw;
            float line = 1.0 - smoothstep(0.3 * hatchPx - 0.5, 0.3 * hatchPx + 0.5, px);
            // lines closer than a few pixels would alias into a grey wash: fade them out
            line *= smoothstep(2.5, 4.5, 1.0 / fw);
            diffuseColor.rgb = mix(diffuseColor.rgb, hatchColor, line * 0.85);`,
            );
        };
        this.cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        // the stencil passes must be followed by this cap every frame, which then clears them
        this.cap.frustumCulled = false;
        this.cap.onAfterRender = (r) => r.clearStencil();
        this.capStencil = [
          [THREE.BackSide, THREE.IncrementWrapStencilOp],
          [THREE.FrontSide, THREE.DecrementWrapStencilOp],
        ].map(([side, op]) => {
          const m = new THREE.Mesh(
            this.faceMesh.geometry,
            new THREE.MeshBasicMaterial({ side: side as THREE.Side, colorWrite: false, depthWrite: false, depthTest: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: op as THREE.StencilOp }),
          );
          m.frustumCulled = false;
          return m;
        });
        this.group.add(this.cap, ...this.capStencil);
      }
      this.orderCap();
      const cm = this.cap.material as THREE.MeshBasicMaterial;
      const u = cm.userData.hatch;
      this.syncCapColor();
      const pl = planes[0];
      for (const m of this.capStencil) {
        const sm = m.material as THREE.Material;
        sm.clippingPlanes = planes;
        sm.needsUpdate = true;
      }
      if (hatch) {
        // in-plane basis from a stable world reference, then rotate by the part's hatch angle
        const n = pl.normal;
        const ref = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
        const a = new THREE.Vector3().crossVectors(ref, n).normalize();
        const b = new THREE.Vector3().crossVectors(n, a);
        u.hatchDir.value.copy(a.multiplyScalar(Math.cos(hatch.angle)).addScaledVector(b, Math.sin(hatch.angle)));
        u.hatchSpacing.value = hatch.spacing;
        u.hatchPx.value = hatch.pixelRatio;
      }
      this.placeCap(pl);
      this.updateCapBorder(pl);
    } else {
      this.showCap(false);
      if (this.capBorder) this.capBorder.visible = false;
    }
  }

  /** Parts share the stencil buffer: each part's passes and cap run back to back, before any faces. */
  private orderCap() {
    if (!this.cap) return;
    // increasing with the slot but always within [-3, -2), however many parts there are
    const order = -3 + this.slot / (this.slot + 1);
    for (const m of this.capStencil) m.renderOrder = order;
    this.cap.renderOrder = -3 + (this.slot + 0.5) / (this.slot + 1.5);
  }

  private showCap(on: boolean) {
    if (this.cap) this.cap.visible = on;
    for (const m of this.capStencil) m.visible = on;
  }

  /** The cap quad: on the plane, centred on the part, covering its bounding sphere's cross-section. */
  private placeCap(world: THREE.Plane) {
    const cap = this.cap!;
    const pl = world.clone().applyMatrix4(this.group.matrix.clone().invert());
    const sphere = this.faceMesh.geometry.boundingSphere!;
    const d = pl.distanceToPoint(sphere.center);
    const on = Math.abs(d) < sphere.radius;
    this.showCap(on);
    cap.userData.shown = on;
    if (!on) return;
    cap.position.copy(sphere.center).addScaledVector(pl.normal, -d);
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pl.normal);
    cap.scale.setScalar(sphere.radius * 2.2);
  }

  /** Intersect every triangle with the plane; the crossing segments outline the cut face. */
  private updateCapBorder(world: THREE.Plane) {
    // the mesh is in part coordinates; the plane is in world coordinates
    const pl = world.clone().applyMatrix4(this.group.matrix.clone().invert());
    const m = this.data.mesh;
    const P = m.positions,
      I = m.indices;
    const out: number[] = [];
    const d = [0, 0, 0];
    const n = pl.normal,
      c = pl.constant;
    for (let t = 0; t < I.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const v = I[t + k] * 3;
        d[k] = n.x * P[v] + n.y * P[v + 1] + n.z * P[v + 2] + c;
      }
      // vertices exactly on the plane count as the positive side, so each crossing is found once
      const s0 = d[0] >= 0,
        s1 = d[1] >= 0,
        s2 = d[2] >= 0;
      if (s0 === s1 && s1 === s2) continue;
      for (let k = 0; k < 3; k++) {
        const k2 = (k + 1) % 3;
        if (d[k] >= 0 === d[k2] >= 0) continue;
        const a = I[t + k] * 3,
          b = I[t + k2] * 3;
        const f = d[k] / (d[k] - d[k2]);
        out.push(P[a] + (P[b] - P[a]) * f, P[a + 1] + (P[b + 1] - P[a + 1]) * f, P[a + 2] + (P[b + 2] - P[a + 2]) * f);
      }
    }
    if (!this.capBorder) {
      // not clipped: it lies on the plane itself; drawn like the silhouette, in every display mode
      this.capBorder = new LineSegments2(new LineSegmentsGeometry(), withDepthBias(new LineMaterial({ color: 0x1f2023, linewidth: 1.3, resolution: this.resolution, worldUnits: false })) as LineMaterial);
      this.capBorder.renderOrder = 1;
      this.group.add(this.capBorder);
    }
    this.capBorder.geometry.dispose();
    this.capBorder.geometry = new LineSegmentsGeometry();
    if (out.length) this.capBorder.geometry.setPositions(out);
    this.capBorder.visible = out.length > 0;
  }

  /** Cap shows the part's own (possibly dimmed) colour; hatch lines are a dark shade of it. */
  private syncCapColor() {
    if (!this.cap) return;
    const cm = this.cap.material as THREE.MeshBasicMaterial;
    cm.color.copy(this.capColor);
    cm.userData.hatch.hatchColor.value.copy(this.capColor).multiplyScalar(0.28);
  }

  dispose() {
    if (this.cap) this.cap.geometry.dispose(), (this.cap.material as THREE.Material).dispose();
    for (const m of this.capStencil) (m.material as THREE.Material).dispose();
    if (this.capBorder) this.capBorder.geometry.dispose(), (this.capBorder.material as THREE.Material).dispose();
    this.faceMesh.geometry.dispose();
    this.edgeLines.geometry.dispose();
    this.pickEdges.geometry.dispose();
    this.pickVerts.geometry.dispose();
    this.overlay.geometry.dispose();
    this.markers.geometry.dispose();
    this.faceMaterial.dispose();
    this.silMaterial.dispose();
    (this.outlineMask.material as THREE.Material).dispose();
    (this.outline.material as THREE.Material).dispose();
    this.edgeMaterial.dispose();
    this.overlayMaterial.dispose();
    this.pickFaceMaterial.dispose();
    this.pickEdgeMaterial.dispose();
    this.pickVertMaterial.dispose();
    this.markerMaterial.dispose();
  }
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 1);
