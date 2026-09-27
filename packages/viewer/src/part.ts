// One part in the scene: shaded faces, batched feature edges, highlight overlays, pick proxies.
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { withDepthBias } from "./depthbias";
import { withScreenShading } from "./shading";

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
  /** Script-set finish (all 0..1): opacity below 1 draws the part see-through. */
  appearance?: { opacity?: number; roughness?: number; metalness?: number };
  /** last-good geometry after an error: drawn dimmed */
  dim?: boolean;
};

/** Face roughness when the script doesn't set one: satin plastic. */
const DEFAULT_ROUGHNESS = 0.42;

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
  overlay!: LineSegments2;
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
  /** Opacity the script asked for; display fades multiply into it. */
  readonly baseOpacity: number;

  constructor(data: PartData, slot: number, private resolution: THREE.Vector2) {
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
      uniforms: { slotKind: { value: (KIND_CODE.face << 6) | slot } },
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 8,
      toneMapped: false,
      blending: THREE.NoBlending,
    });
    this.pickEdgeMaterial = new LineMaterial({ vertexColors: true, linewidth: 15, resolution, worldUnits: false, toneMapped: false, blending: THREE.NoBlending });
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
    this.outline.renderOrder = 21;
    this.outlineMask.visible = this.outline.visible = false;
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

    this.group.add(this.faceMesh, this.silhouette, this.edgeLines, this.overlay, this.pickFaces, this.pickEdges, this.outlineMask, this.outline);
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

  setEmissive(amount: number) {
    this.faceMaterial.emissive.setRGB(amount * 0.35, amount * 0.55, amount);
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
      this.faceMaterial.emissive.set(0x000000);
    }
    this.faceMaterial.needsUpdate = true;
  }

  /** Swap to pick materials for the ID pass. */
  pickMode(on: boolean, edgesPickable: boolean, facesPickable: boolean) {
    if (this.cap) this.cap.visible = !on && !!this.faceMaterial.clippingPlanes;
    if (this.capBorder) this.capBorder.visible = !on && !!this.faceMaterial.clippingPlanes && this.capBorder.geometry.attributes.instanceStart !== undefined;
    this.faceMesh.visible = !on && this.faceMesh.userData.shown !== false;
    this.silhouette.visible = !on && this.silhouette.userData.shown === true;
    this.outlineMask.visible = this.outline.visible = !on && this.outlineMask.userData.shown === true;
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
  private capColor = new THREE.Color();
  /** Outline of the cut: where the section plane crosses the part's surface. */
  private capBorder: LineSegments2 | null = null;

  /**
   * Section view: clip everything of this part. Inside (back) faces seen through the cut render as
   * a flat cap in the part's colour, hatched with thin dark lines. The hatch is laid out on the
   * section plane in world space (each back-face fragment is projected along its view ray onto the
   * plane), so it stays attached to the model while orbiting; angle and spacing vary per part.
   */
  setClip(planes: THREE.Plane[], hatch?: { angle: number; spacing: number; pixelRatio: number }) {
    const mats = [this.faceMaterial, this.edgeMaterial, this.overlayMaterial, this.pickFaceMaterial, this.pickEdgeMaterial, this.silMaterial, this.outlineMask.material, this.outline.material] as THREE.Material[];
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
        const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
        mat.userData.hatch = {
          hatchColor: { value: new THREE.Color() },
          hatchPx: { value: 1 },
          hatchPlane: { value: new THREE.Vector4() },
          hatchDir: { value: new THREE.Vector3() },
          hatchSpacing: { value: 1 },
        };
        mat.onBeforeCompile = (sh) => {
          Object.assign(sh.uniforms, mat.userData.hatch);
          sh.vertexShader = sh.vertexShader
            .replace("void main() {", "varying vec3 vHatchWorld;\nvoid main() {")
            .replace("#include <project_vertex>", "#include <project_vertex>\nvHatchWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
          sh.fragmentShader = sh.fragmentShader
            .replace(
              "void main() {",
              "uniform vec3 hatchColor;\nuniform float hatchPx;\nuniform vec4 hatchPlane;\nuniform vec3 hatchDir;\nuniform float hatchSpacing;\nvarying vec3 vHatchWorld;\nvoid main() {",
            )
            .replace(
              "#include <color_fragment>",
              `#include <color_fragment>
            // project this back-face fragment along its view ray onto the section plane
            vec3 rd = isOrthographic ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) : vHatchWorld - cameraPosition;
            float den = dot(hatchPlane.xyz, rd);
            float tHit = abs(den) > 1e-8 ? -(dot(hatchPlane.xyz, vHatchWorld) + hatchPlane.w) / den : 0.0;
            vec3 onPlane = vHatchWorld + rd * tHit;
            float s = dot(onPlane, hatchDir) / hatchSpacing;
            float fw = max(fwidth(s), 1e-6);
            float px = abs(fract(s + 0.5) - 0.5) / fw;
            float line = 1.0 - smoothstep(0.3 * hatchPx - 0.5, 0.3 * hatchPx + 0.5, px);
            // lines closer than a few pixels would alias into a grey wash: fade them out
            line *= smoothstep(2.5, 4.5, 1.0 / fw);
            diffuseColor.rgb = mix(diffuseColor.rgb, hatchColor, line * 0.85);`,
            );
        };
        this.cap = new THREE.Mesh(this.faceMesh.geometry, mat);
        this.cap.renderOrder = -0.5;
        this.group.add(this.cap);
      }
      const cm = this.cap.material as THREE.MeshBasicMaterial;
      const u = cm.userData.hatch;
      this.syncCapColor();
      const pl = planes[0];
      u.hatchPlane.value.set(pl.normal.x, pl.normal.y, pl.normal.z, pl.constant);
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
      cm.clippingPlanes = planes;
      cm.needsUpdate = true;
      this.cap.visible = true;
      this.updateCapBorder(pl);
    } else {
      if (this.cap) this.cap.visible = false;
      if (this.capBorder) this.capBorder.visible = false;
    }
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
    if (this.cap) (this.cap.material as THREE.Material).dispose();
    if (this.capBorder) this.capBorder.geometry.dispose(), (this.capBorder.material as THREE.Material).dispose();
    this.faceMesh.geometry.dispose();
    this.edgeLines.geometry.dispose();
    this.pickEdges.geometry.dispose();
    this.overlay.geometry.dispose();
    this.faceMaterial.dispose();
    this.silMaterial.dispose();
    (this.outlineMask.material as THREE.Material).dispose();
    (this.outline.material as THREE.Material).dispose();
    this.edgeMaterial.dispose();
    this.overlayMaterial.dispose();
    this.pickFaceMaterial.dispose();
    this.pickEdgeMaterial.dispose();
  }
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 1);
