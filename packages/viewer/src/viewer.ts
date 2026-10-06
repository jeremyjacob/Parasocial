// The 3D viewport (§8, §9): render on demand, GPU ID-buffer picking, preselect/selection
// overlays, display modes, views and fit. Framework-agnostic; geometry never enters app state.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { PartObject, decodeId, type EntityKind, type EntityRef, type PartData } from "./part";
import { CadControls, type NavPreset, type TrackpadScroll, type CamState } from "./controls";
import { ViewCube, VIEW_DIRS } from "./viewcube";
import { LIGHT, type ViewerTheme } from "./theme";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { withDepthBias } from "./depthbias";
import { InfiniteGrid } from "./grid";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { HaloPass } from "./halo";
import { scaleAO, setupAO, sizeAO } from "./ao";
import { screenShading } from "./shading";
import { BUILD_HIT, BUILD_OFF, hash, makeBuildUniforms, type BuildPiece } from "./build";

/** A pencil stroke; with `part`, its points are in that part's coordinates and move with it. */
export type MarkupStroke = { id: string; points: [number, number, number][]; color: string; width?: number; dim?: boolean; part?: string };

export type DisplayMode = "shaded" | "shadedEdges" | "wireframe" | "hiddenLine";
export type SelectionFilter = { face: boolean; edge: boolean; vertex: boolean; part: boolean };
export type PickResult = EntityRef & { point?: THREE.Vector3 };

export type ViewerOptions = {
  theme?: ViewerTheme;
  nav?: NavPreset;
  viewCube?: boolean;
  /** View cube container offset from the viewport's top-right corner (px). The container is
   *  larger than the drawn cube, so the visible cube sits ~16px further in. */
  viewCubeInset?: { top: number; right: number };
  /** device pixel ratio cap */
  maxDpr?: number;
  reducedMotion?: boolean;
  preserveDrawingBuffer?: boolean;
};

type Highlight = { refs: EntityRef[] };
type AOBuffer = { pass: GTAOPass; halo: THREE.WebGLRenderTarget; haloScratch: THREE.WebGLRenderTarget; scale: number; radius: number };

/** Orange tint on selected faces and parts alike: strong, with shading still visible. */
const SELECTED_TINT = 0.75;
/** Origin axis lines, shared with the view cube's triad so the two match. */
const AXIS_OPACITY = 0.375;
/** View cube face colors (rgba); translucent, so the viewport bg shows through a little. */
const VC_FACE_DARK = [39, 39, 42, 0.92] as const;
const VC_FACE_LIGHT = [255, 255, 255, 0.94] as const;
/** Minimum luma gap (0..1, sRGB) the darkest shaded cube piece keeps above the viewport bg. */
const VC_SHADE_GAP = 0.04;

/**
 * The strongest darkening the view cube's key-light shading may apply before a piece would sink
 * to within VC_SHADE_GAP of the viewport bg and get lost against it. The shade is a black overlay,
 * which scales the composited face color (face over bg, as the cube's --vc-glass does) uniformly.
 */
function viewCubeShadeMax(face: readonly number[], background: string): number {
  const hex = new THREE.Color(background).getHex(); // sRGB
  const bg = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  const a = face[3] * 0.88; // --vc-glass thins the face to 88%
  const luma = (c: readonly number[]) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const faceL = luma([0, 1, 2].map((i) => face[i] * a + bg[i] * (1 - a)));
  const bgL = luma(bg);
  if (faceL <= bgL) return 1; // cube darker than the bg: darkening only moves it further away
  return Math.max(0, 1 - (bgL + VC_SHADE_GAP) / faceL);
}
/** Faces-only render layer: the first phase of the AO frame (see renderShaded). */
const FACE_LAYER = 2;
/** Pick snap radii, CSS px: a vertex this close to the cursor wins, then an edge. */
const VERTEX_SNAP = 3;
const EDGE_SNAP = 6;
/** Floor for the edge snap on small faces, CSS px: the cursor on a drawn edge still picks it. */
const EDGE_SNAP_MIN = 2;
/**
 * The edge snap band may take at most this fraction of the face's on-screen width from each
 * side. Zoomed out, faces shrink but a fixed pixel snap doesn't, so edges would swallow them.
 */
const EDGE_SNAP_FACE_FRACTION = 0.25;
/** The grid renders before the scene, without contributing depth. */
const BACKGROUND_LAYER = 3;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly persp = new THREE.PerspectiveCamera(35, 1, 0.1, 1e5);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
  readonly controls: CadControls;
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  private viewCube?: ViewCube;
  private parts = new Map<string, PartObject>();
  private slots: (string | null)[] = [];
  private theme: ViewerTheme;
  private resolution = new THREE.Vector2(1, 1);
  /** device px per CSS px, shared with the parts (vertex dots are sized in CSS px) */
  private pixelRatio = { value: 1 };
  /** Build animation progress (0..1), shared with the parts; null when off. */
  private build: number | null = null;
  private buildUniforms = makeBuildUniforms();
  /** The build's length (ms) and its impacts (timeline time, strength 0..1), for the camera shake. */
  private buildPlan: { ms: number; hits: { at: number; k: number }[] } | null = null;
  private pickTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
  private pickBuf = new Float32Array(4 * 13 * 13);
  private facePickTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
  private facePickBuf = new Float32Array(4);
  private needsRender = true;
  private raf = 0;
  private useOrtho = false;
  private mode: DisplayMode = "shadedEdges";
  private selection: Highlight = { refs: [] };
  private preselect: EntityRef | null = null;
  private errors: EntityRef[] = [];
  private colors = new Map<string, THREE.Color>();
  private dimmed = new Set<string>();
  private hidden = new Set<string>();
  private grid: THREE.Group;
  private groundGrid = new InfiniteGrid();
  private markup = new THREE.Group();
  private ghosts = new Map<string, THREE.Group>();
  private blend = 0.5;
  private triad: THREE.Group;
  private showGrid = true;
  private showOrigin = true;
  private envTex: THREE.Texture | null = null;
  filter: SelectionFilter = { face: true, edge: true, vertex: true, part: false };
  private listeners: { [k: string]: Set<(e: any) => void> } = {};
  private ro: ResizeObserver;
  private disposed = false;
  stats = { frames: 0, lastFrameMs: 0, lastPickMs: 0 };
  /** Ambient occlusion + depth halo, every frame; a cheaper halo while the camera moves (§9). */
  ao = true;
  /** AO at device resolution (at rest) and at CSS resolution (camera moving). */
  private aoFull: AOBuffer | null = null;
  private aoFast: AOBuffer | null = null;
  private haloPass: HaloPass | null = null;
  private faceVis: [THREE.Mesh, boolean][] = [];
  private moving = false;
  private aoEnabledByDepth = true;
  /** Pixel ratio at rest; motion drops to 1× when frames run long, restored when it settles. */
  private baseDpr = 1;
  private lowRes = false;
  private slowFrames = 0;
  private lastTick = 0;
  private boundsCache: THREE.Box3 | null = null;
  private sphereCache = new THREE.Sphere();
  /** Assembly poses: part -> transform from its modeled position (absent = identity). */
  private transforms = new Map<string, THREE.Matrix4>();
  /** Overlap volumes between parts, red; each rides along with its first part. */
  private overlaps = new THREE.Group();
  /** Overlap volumes show through geometry covering them (x-ray), or only where they're the nearest surface. */
  private overlapsOnTop = true;

  constructor(container: HTMLElement, o: ViewerOptions = {}) {
    this.container = container;
    this.theme = o.theme ?? LIGHT;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%;outline:none;touch-action:none";
    canvas.tabIndex = 0;
    container.appendChild(canvas);
    this.canvas = canvas;
    let reversed = false;
    try {
      const probe = document.createElement("canvas").getContext("webgl2");
      reversed = !!probe?.getExtension("EXT_clip_control");
    } catch {}
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance", stencil: true, reversedDepthBuffer: reversed, logarithmicDepthBuffer: !reversed, preserveDrawingBuffer: o.preserveDrawingBuffer ?? false } as any);
    (this.renderer as any).__psReversed = reversed;
    this.baseDpr = Math.min(window.devicePixelRatio || 1, o.maxDpr ?? 2);
    this.renderer.setPixelRatio(this.baseDpr);
    // GTAO handles reversed-Z but not the logarithmic-depth fallback
    this.aoEnabledByDepth = reversed;
    this.ao = (o as any).ao ?? true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // no tone mapping: the canvas color must match the design token exactly (the composer path
    // would otherwise tone-map the background too), and CAD shading wants linear, honest color
    this.renderer.toneMapping = THREE.NoToneMapping;

    for (const cam of [this.persp, this.ortho]) cam.up.set(0, 0, 1);
    this.persp.position.set(120, -160, 110);
    this.ortho.position.copy(this.persp.position);

    // studio lighting: soft room environment + a key light
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();
    // camera-relative rig (Onshape-like): a strong key from upper left, a soft fill from lower
    // right, sky/ground bounce. Lights and their targets are camera children, so shading stays
    // consistent while orbiting.
    // lights are filtered by camera layers: they must also live on FACE_LAYER, or the faces-only
    // phase of the shaded frame renders unlit
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a92, 0.4);
    hemi.layers.enable(FACE_LAYER);
    this.scene.add(hemi);
    for (const cam of [this.persp, this.ortho]) {
      const rig = (x: number, y: number, z: number, i: number) => {
        const l = new THREE.DirectionalLight(0xffffff, i);
        l.position.set(x, y, z);
        l.target.position.set(0, 0, -1);
        l.layers.enable(FACE_LAYER);
        cam.add(l, l.target);
      };
      rig(-0.55, 0.8, 1, 1.05);
      rig(0.8, -0.5, 0.4, 0.28);
    }
    this.scene.add(this.persp, this.ortho);

    this.grid = new THREE.Group();
    this.groundGrid.mesh.layers.set(BACKGROUND_LAYER);
    this.grid.add(this.groundGrid.mesh);
    this.triad = new THREE.Group();
    this.scene.add(this.grid, this.triad, this.markup, this.overlaps);
    this.markup.renderOrder = 4;

    this.controls = new CadControls(canvas, {
      camera: () => this.camera,
      pickPoint: (x, y) => this.pickPoint(x, y)?.point ?? null,
      sceneCenter: () => {
        const b = this.bounds();
        return b.isEmpty() ? null : b.getCenter(new THREE.Vector3());
      },
      changed: () => this.syncCameras(),
      moving: (on) => this.setMoving(on),
    });
    this.controls.preset = o.nav ?? "onshape";
    this.controls.reducedMotion = o.reducedMotion ?? matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    if (o.viewCube !== false) {
      this.viewCube = new ViewCube(
        container,
        (dir) => this.setViewDir(dir),
        (dx, dy, phase) => {
          if (phase === "start") this.controls.stopAnim(), this.setMoving(true);
          else if (phase === "end") this.setMoving(false);
          else this.controls.orbit(dx, dy, this.controls.target);
        },
      );
      this.viewCube.el.style.top = `${o.viewCubeInset?.top ?? 4}px`;
      this.viewCube.el.style.right = `${o.viewCubeInset?.right ?? 8}px`;
    }

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.applyTheme();
    this.requestRender();
  }

  // ---------- events ----------
  on(ev: "moving" | "camera" | "rendered" | "poses", fn: (e: any) => void) {
    (this.listeners[ev] ??= new Set()).add(fn);
    return () => this.listeners[ev].delete(fn);
  }
  private emit(ev: string, e: unknown) {
    this.listeners[ev]?.forEach((f) => f(e));
  }

  private setMoving(on: boolean) {
    this.moving = on;
    this.slowFrames = 0;
    if (!on) {
      // full quality once the camera stops: the full halo, and full resolution if motion dropped it
      if (this.lowRes) this.setLowRes(false);
      else this.requestRender();
    }
    this.emit("moving", on);
  }

  private setLowRes(on: boolean) {
    this.lowRes = on;
    this.renderer.setPixelRatio(on ? 1 : this.baseDpr);
    this.resize();
  }

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.useOrtho ? this.ortho : this.persp;
  }

  // ---------- parts ----------
  private fading: { group: THREE.Group; t0: number; obj: PartObject }[] = [];

  /**
   * Set a part's geometry. `crossfade` fades the old mesh out over the new one (discrete changes:
   * agent writes, restores). Scrubbing/typing swaps instantly (§8 Motion).
   */
  setPart(d: PartData, opts: { crossfade?: boolean } = {}) {
    const prev = this.parts.get(d.id);
    if (prev && opts.crossfade && !this.controls.reducedMotion) {
      this.parts.delete(d.id);
      prev.setFaceStyle({ visible: true, opacity: 1 });
      this.fading.push({ group: prev.group, t0: performance.now(), obj: prev });
      this.slots[prev.slot] = null;
    }
    let slot = prev ? prev.slot : this.slots.indexOf(null);
    if (slot < 0) slot = this.slots.length;
    this.slots[slot] = d.id;
    if (prev && this.parts.get(d.id) === prev) {
      this.scene.remove(prev.group);
      prev.dispose();
    }
    const p = new PartObject(d, slot, this.resolution, this.pixelRatio, this.buildUniforms);
    this.parts.set(d.id, p);
    this.colors.set(d.id, new THREE.Color(d.color));
    if (d.dim) this.dimmed.add(d.id);
    else this.dimmed.delete(d.id);
    p.group.visible = !this.hidden.has(d.id);
    this.placeGroup(p.group, d.id);
    this.scene.add(p.group);
    // drop highlights that no longer exist
    const valid = (r: EntityRef) => r.part !== d.id || this.exists(r);
    this.selection.refs = this.selection.refs.filter(valid);
    if (this.preselect && !valid(this.preselect)) this.preselect = null;
    this.errors = this.errors.filter(valid);
    this.restyle(d.id);
    this.boundsCache = null;
    if (this.section) this.applyClip(p);
    this.buildPlan = null;
    if (this.build !== null) this.layoutBuild();
    this.updateGrid();
    this.requestRender();
  }

  removePart(id: string) {
    const p = this.parts.get(id);
    if (!p) return;
    this.scene.remove(p.group);
    p.dispose();
    this.parts.delete(id);
    this.slots[p.slot] = null;
    this.selection.refs = this.selection.refs.filter((r) => r.part !== id);
    this.boundsCache = null;
    this.buildPlan = null;
    if (this.build !== null) this.layoutBuild();
    this.requestRender();
  }

  // ---------- build animation ----------
  /**
   * Build animation: 0 = nothing built yet, 1 = everything in place; null turns it off. Each piece
   * (connected solid) is thrown in and slams down, bottom-up (build.ts).
   */
  setBuild(t: number | null) {
    if (t !== null && (this.build === null || !this.buildPlan)) this.layoutBuild();
    this.build = t;
    this.buildUniforms.buildT.value = t ?? BUILD_OFF;
    this.requestRender();
  }

  /** How long the build animation runs, in ms. */
  buildDuration() {
    if (!this.buildPlan) this.layoutBuild();
    return this.buildPlan!.ms;
  }

  /**
   * Choreograph the build: pieces land bottom-up (sweeping across within a level), each thrown
   * from above and outside the model, tumbling, and heavier pieces shake the camera harder.
   */
  private layoutBuild() {
    const pieces: { p: PartObject; k: number; box: THREE.Box3 }[] = [];
    for (const p of this.parts.values()) {
      if (!p.group.visible) continue;
      p.buildBoxes.forEach((b, k) => b.isEmpty() || pieces.push({ p, k, box: b.clone().applyMatrix4(p.group.matrix) }));
    }
    const model = new THREE.Box3();
    for (const q of pieces) model.union(q.box);
    const sphere = model.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : model.getBoundingSphere(new THREE.Sphere());
    const R = Math.max(sphere.radius, 1e-6);
    const level = (q: (typeof pieces)[number]) => Math.round(q.box.min.z / (R * 0.05));
    const c = new THREE.Vector3();
    pieces.sort((a, b) => level(a) - level(b) || a.box.getCenter(c).x - b.box.getCenter(new THREE.Vector3()).x || a.box.min.y - b.box.min.y);

    // a piece flies for ~0.4 s and settles for ~0.35 s; launches are spaced so the whole build
    // stays within a few seconds for a handful of pieces and ~12 s for hundreds
    const n = pieces.length;
    const flight = 0.75;
    const gap = n <= 1 ? 0 : Math.min(0.32, Math.max(0.025, 5.5 / n), (11 - flight) / (n - 1));
    const total = (n - 1) * gap + flight + 0.35;
    this.buildUniforms.buildDur.value = flight / total;

    const radii = pieces.map((q) => q.box.getBoundingSphere(new THREE.Sphere()).radius);
    const rMax = Math.max(1e-6, ...radii);
    const up = new THREE.Vector3(0, 0, 1);
    const hits: { at: number; k: number }[] = [];
    const flights = new Map<PartObject, BuildPiece[]>();
    pieces.forEach((q, i) => {
      const r = radii[i];
      const start = (i * gap) / total;
      // thrown from above, out past the model on the piece's own side
      const mid = q.box.getCenter(new THREE.Vector3());
      const out = mid.clone().sub(sphere.center).setZ(0);
      if (out.lengthSq() < (R * 0.05) ** 2) out.set(Math.cos(hash(i) * 6.283), Math.sin(hash(i) * 6.283), 0);
      out.normalize();
      const dir = out.multiplyScalar(0.75).add(up).add(new THREE.Vector3(hash(i + 0.1) - 0.5, hash(i + 0.2) - 0.5, 0).multiplyScalar(0.5)).normalize();
      const offset = dir.clone().multiplyScalar(R * 1.6 + r);
      // tumbling about an axis across its path, so it swings down into place
      const spin = new THREE.Vector3().crossVectors(dir, up);
      if (spin.lengthSq() < 1e-6) spin.set(1, 0, 0);
      spin.normalize().multiplyScalar((hash(i + 0.3) < 0.5 ? -1 : 1) * (0.45 + 0.5 * hash(i + 0.4)));
      // into the part's coordinates (placements are rigid)
      const inv = new THREE.Matrix4().copy(q.p.group.matrix).invert();
      const rot = new THREE.Matrix3().setFromMatrix4(inv);
      const flight: BuildPiece = {
        pivot: mid.clone().applyMatrix4(inv),
        start,
        offset: offset.applyMatrix3(rot),
        spin: spin.applyMatrix3(rot),
        bounce: Math.min(r * 0.12, R * 0.03),
      };
      let list = flights.get(q.p);
      if (!list) flights.set(q.p, (list = []));
      list[q.k] = flight;
      hits.push({ at: start + BUILD_HIT * this.buildUniforms.buildDur.value, k: Math.max(0.15, Math.min(1, (r / rMax) ** 1.2)) });
    });
    for (const [p, list] of flights) p.setBuild(list);
    this.buildPlan = { ms: total * 1000, hits };
  }

  /** Camera offset from the build's impacts at progress `t`: a sharp jolt down, then a rattle. */
  private buildShake(t: number) {
    const plan = this.buildPlan;
    if (!plan) return null;
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const upv = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    let x = 0,
      y = 0;
    for (const h of plan.hits) {
      const dt = ((t - h.at) * plan.ms) / 1000;
      if (dt < 0 || dt > 0.6) continue;
      const env = h.k * Math.exp(-dt * 11);
      x += env * Math.sin(dt * 95 + h.at * 50) * 0.5;
      y += env * (Math.cos(dt * 80) - 0.3);
    }
    if (!x && !y) return null;
    const amp = this.modelSphere().radius * 0.018;
    return right.multiplyScalar(x * amp).addScaledVector(upv, -y * amp);
  }

  /** The mesh currently shown for a part (e.g. to write derived-data caches). */
  meshOf(id: string) {
    return this.parts.get(id)?.data.mesh;
  }

  /** Replace the error highlights of one part, keeping other parts' highlights. */
  setPartErrors(part: string, refs: EntityRef[]) {
    this.setErrors([...this.errors.filter((r) => r.part !== part), ...refs]);
  }

  partIds() {
    return [...this.parts.keys()];
  }

  setPartColor(id: string, color: string) {
    this.colors.set(id, new THREE.Color(color));
    this.restyle(id);
    this.requestRender();
  }

  setVisible(id: string, visible: boolean) {
    if (visible) this.hidden.delete(id);
    else this.hidden.add(id);
    const p = this.parts.get(id);
    if (p) p.group.visible = visible;
    this.syncOverlaps();
    this.boundsCache = null;
    this.requestRender();
  }

  /** Show only these parts (empty = show all). */
  isolate(ids: string[]) {
    for (const [id, p] of this.parts) p.group.visible = (!ids.length || ids.includes(id)) && !this.hidden.has(id);
    this.syncOverlaps();
    this.boundsCache = null;
    this.requestRender();
  }

  private exists(r: EntityRef) {
    const p = this.parts.get(r.part);
    if (!p) return false;
    const n = r.kind === "face" ? p.data.mesh.faceRanges.length / 2 : r.kind === "edge" ? p.data.mesh.edgeRanges.length / 2 : r.kind === "vertex" ? (p.data.vertices?.length ?? 0) : 0;
    return r.index < n;
  }

  // ---------- highlight ----------
  setSelection(refs: EntityRef[]) {
    const touched = new Set([...this.selection.refs, ...refs].map((r) => r.part));
    this.selection = { refs: refs.filter((r) => this.exists(r) || r.kind === ("part" as any)) };
    for (const id of touched) this.restyle(id);
    this.requestRender();
  }
  getSelection() {
    return this.selection.refs;
  }
  setPreselect(ref: EntityRef | null) {
    const same = ref && this.preselect && ref.part === this.preselect.part && ref.kind === this.preselect.kind && ref.index === this.preselect.index;
    if (same || (!ref && !this.preselect)) return;
    const touched = new Set([this.preselect?.part, ref?.part].filter(Boolean) as string[]);
    this.preselect = ref;
    for (const id of touched) this.restyle(id);
    // preselect must land in the current frame (§9): render now rather than on the next rAF
    this.renderNow();
  }
  setErrors(refs: EntityRef[]) {
    const touched = new Set([...this.errors, ...refs].map((r) => r.part));
    this.errors = refs;
    for (const id of touched) this.restyle(id);
    this.requestRender();
  }

  private restyle(id: string) {
    const p = this.parts.get(id);
    if (!p) return;
    const t = this.theme;
    const base = this.colors.get(id) ?? new THREE.Color("#9aa4b2");
    const tints = new Map<number, { color: THREE.Color; amount: number }>();
    const stroke: { edges: number[]; color: THREE.Color }[] = [];
    const selStroke = new THREE.Color(t.selectedStroke),
      pre = new THREE.Color(t.preselect),
      err = new THREE.Color(t.error),
      selFill = new THREE.Color(t.selectedFill);
    const selEdges: number[] = [];
    const preEdges: number[] = [];
    const errEdges: number[] = [];
    const marks: { vertex: number; color: THREE.Color }[] = [];
    const partSelected = this.selection.refs.some((r) => r.part === id && (r.kind as string) === "part");
    for (const r of this.errors) if (r.part === id) r.kind === "face" ? (tints.set(r.index, { color: err, amount: 0.55 }), errEdges.push(...(p.data.faceEdges[r.index] ?? []))) : r.kind === "edge" ? errEdges.push(r.index) : r.kind === "vertex" && marks.push({ vertex: r.index, color: err });
    for (const r of this.selection.refs)
      if (r.part === id) {
        if (r.kind === "face") {
          tints.set(r.index, { color: selFill, amount: SELECTED_TINT });
          selEdges.push(...(p.data.faceEdges[r.index] ?? []));
        } else if (r.kind === "edge") selEdges.push(r.index);
        else if (r.kind === "vertex") marks.push({ vertex: r.index, color: selStroke });
      }
    // a selected part reads as orange: the same tint as a selected face, plus the outline
    if (partSelected) for (let f = 0; f < p.data.mesh.faceRanges.length / 2; f++) tints.set(f, { color: selFill, amount: SELECTED_TINT });
    p.setOutline(partSelected, selStroke);
    if (this.preselect?.part === id) {
      if (this.preselect.kind === "face") preEdges.push(...(p.data.faceEdges[this.preselect.index] ?? []));
      else if (this.preselect.kind === "edge") preEdges.push(this.preselect.index);
      else if (this.preselect.kind === "vertex") marks.push({ vertex: this.preselect.index, color: pre });
      else if ((this.preselect.kind as string) === "part") for (let f = 0; f < p.data.mesh.faceRanges.length / 2; f++) tints.set(f, tints.get(f) ?? { color: pre, amount: 0.12 });
    }
    const hide = p.data.hiddenEdges;
    const vis = (l: number[]) => [...new Set(l)].filter((e) => !hide?.has(e));
    stroke.push({ edges: vis(errEdges), color: err }, { edges: vis(selEdges), color: selStroke }, { edges: vis(preEdges), color: pre });
    const dim = this.dimmed.has(id) ? 0.55 : 0;
    const bg = new THREE.Color(t.background);
    if (this.mode === "hiddenLine") p.paint(new THREE.Color(t.hiddenLineFill), tints, 0, bg);
    else p.paint(base, tints, dim, bg);
    p.setOverlay(stroke);
    p.setMarkers(marks);
    p.overlay.userData.active = stroke.some((s) => s.edges.length);
    this.applyMode(p);
  }

  // ---------- display ----------
  setDisplayMode(m: DisplayMode) {
    this.mode = m;
    for (const id of this.parts.keys()) this.restyle(id);
    if (this.section) for (const p of this.parts.values()) this.applyClip(p);
    this.requestRender();
  }
  getDisplayMode() {
    return this.mode;
  }

  private applyMode(p: PartObject) {
    const t = this.theme;
    const edge = new THREE.Color(t.edge);
    const dim = this.dimmed.has(p.id);
    switch (this.mode) {
      case "shaded":
        p.setFaceStyle({ visible: true });
        p.edgeLines.visible = false;
        break;
      case "shadedEdges":
        p.setFaceStyle({ visible: true });
        p.edgeLines.visible = true;
        p.setEdgeStyle(dim ? new THREE.Color(t.edgeHidden) : edge, 1.15, dim ? 0.7 : 0.9);
        break;
      case "wireframe":
        p.setFaceStyle({ visible: false });
        p.edgeLines.visible = true;
        p.setEdgeStyle(t.dark ? new THREE.Color("#f4f4f5") : edge, 1.25);
        break;
      case "hiddenLine":
        p.setFaceStyle({ visible: true, flat: new THREE.Color(t.hiddenLineFill) });
        p.edgeLines.visible = true;
        p.setEdgeStyle(edge, 1.25);
        break;
    }
    p.faceMesh.userData.shown = p.faceMesh.visible;
    // the silhouette is an inverted hull: behind see-through faces it would fill the part solid
    const sil = this.mode !== "wireframe" && !this.dimmed.has(p.id) && !p.translucent;
    p.setSilhouette(sil, new THREE.Color(t.silhouette));
    p.silhouette.userData.shown = sil;
  }

  setTheme(t: ViewerTheme) {
    this.theme = t;
    this.applyTheme();
    for (const id of this.parts.keys()) this.restyle(id);
    this.requestRender();
  }

  private applyTheme() {
    const t = this.theme;
    this.scene.background = new THREE.Color(t.background);
    this.scene.environmentIntensity = t.dark ? 0.34 : 0.4;
    const face = t.dark ? VC_FACE_DARK : VC_FACE_LIGHT;
    this.container.style.setProperty("--vc-face", `rgba(${face.join(",")})`);
    this.container.style.setProperty("--vc-shade-max", String(+viewCubeShadeMax(face, t.background).toFixed(4)));
    this.container.style.setProperty("--vc-face-hover", t.dark ? "#3f3f46" : "#ffffff");
    this.container.style.setProperty("--vc-border", t.dark ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.12)");
    this.container.style.setProperty("--vc-fg", t.dark ? "#a1a1aa" : "#71717a");
    this.container.style.setProperty("--vc-fg-hover", t.dark ? "#fafafa" : "#18181b");
    this.container.style.setProperty("--vc-axis-x", t.axisX);
    this.container.style.setProperty("--vc-axis-y", t.axisY);
    this.container.style.setProperty("--vc-axis-z", t.axisZ);
    this.container.style.setProperty("--vc-axis-opacity", String(AXIS_OPACITY));
    this.updateGrid();
  }

  setProjection(ortho: boolean) {
    if (ortho === this.useOrtho) return;
    const from = this.camera;
    this.useOrtho = ortho;
    const to = this.camera;
    to.position.copy(from.position);
    to.up.copy(from.up);
    to.lookAt(this.controls.target);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    if (ortho) {
      const d = from.position.distanceTo(this.controls.target);
      this.controls.orthoHeight = 2 * d * tanHalf;
    } else {
      // ortho zoom doesn't move the camera: put it where the perspective view shows the same height
      const dir = from.position.clone().sub(this.controls.target).normalize();
      to.position.copy(this.controls.target).add(dir.multiplyScalar(this.controls.orthoHeight / (2 * tanHalf)));
    }
    this.syncCameras();
  }
  isOrtho() {
    return this.useOrtho;
  }

  setNavPreset(p: NavPreset) {
    this.controls.preset = p;
  }

  /** What a two-finger trackpad scroll does (shift swaps to the other). */
  setTrackpadScroll(m: TrackpadScroll) {
    this.controls.trackpadScroll = m;
  }

  /** Navigate on wheel/pinch over `root`'s overlays too (pins, pills, toolbars). Returns a disposer. */
  listenOn(root: HTMLElement) {
    return this.controls.listenOn(root);
  }

  // ---------- views ----------
  /** Model bounds of visible parts. */
  bounds(parts?: string[]): THREE.Box3 {
    if (!parts && this.boundsCache) return this.boundsCache.clone();
    const box = new THREE.Box3();
    for (const [id, p] of this.parts) {
      if (parts && !parts.includes(id)) continue;
      if (!p.group.visible) continue;
      const b = p.faceMesh.geometry.boundingBox;
      if (b) box.union(b.clone().applyMatrix4(p.group.matrix));
    }
    if (!parts) {
      this.boundsCache = box.clone();
      box.getBoundingSphere(this.sphereCache);
    }
    return box;
  }

  /** Bounding sphere of the visible model (cached with bounds(); don't mutate). */
  private modelSphere(): THREE.Sphere {
    if (!this.boundsCache) this.bounds();
    return this.sphereCache;
  }

  /** Fit the camera to `box` (default: everything), keeping the view direction. */
  fit(box = this.bounds(), animate = true, dir?: THREE.Vector3) {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const cam = this.camera;
    const d = (dir ?? cam.position.clone().sub(this.controls.target)).normalize();
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    const fov = THREE.MathUtils.degToRad(this.persp.fov);
    const fitH = sphere.radius / Math.sin(fov / 2);
    const fitW = sphere.radius / Math.sin(Math.atan(Math.tan(fov / 2) * aspect));
    const dist = Math.max(fitH, fitW) * 1.12;
    const up = Math.abs(d.z) > 0.999 ? new THREE.Vector3(0, d.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
    const to: CamState = { position: sphere.center.clone().add(d.multiplyScalar(dist)), target: sphere.center.clone(), up, orthoHeight: sphere.radius * 2.3 * Math.max(1, 1 / aspect) };
    if (animate) this.controls.animateTo(to);
    else this.controls.apply(to);
    this.requestRender();
  }

  /** Fit the selection; `orient` also turns the view to look along the selected faces' mean normal. */
  fitSelection(animate = true, orient = false) {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const r of this.selection.refs) {
      const p = this.parts.get(r.part);
      if (!p) continue;
      if (r.kind === "face") {
        const lo = p.faceVerts[r.index * 2],
          cnt = p.faceVerts[r.index * 2 + 1];
        for (let i = lo; i < lo + cnt; i++) box.expandByPoint(v.fromArray(p.data.mesh.positions, i * 3).applyMatrix4(p.group.matrix));
      } else if (r.kind === "edge") {
        const s = p.data.mesh.edgeRanges[r.index * 2],
          c = p.data.mesh.edgeRanges[r.index * 2 + 1];
        for (let i = s; i < s + c; i++) box.expandByPoint(v.fromArray(p.data.mesh.edgePositions, i * 3).applyMatrix4(p.group.matrix));
      } else if (r.kind === "vertex") {
        const at = p.data.vertices?.[r.index];
        if (at) box.expandByPoint(v.set(...at).applyMatrix4(p.group.matrix));
      } else if (p.faceMesh.geometry.boundingBox) box.union(p.faceMesh.geometry.boundingBox.clone().applyMatrix4(p.group.matrix));
    }
    if (!box.isEmpty()) this.fit(box, animate, (orient && this.selectionNormal()) || undefined);
  }

  /** Mean outward normal of the selected faces (each area-weighted, then averaged), or null if none/degenerate. */
  selectionNormal(): THREE.Vector3 | null {
    const sum = new THREE.Vector3();
    const n = new THREE.Vector3(),
      a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3();
    for (const r of this.selection.refs) {
      const p = this.parts.get(r.part);
      if (!p || r.kind !== "face") continue;
      const m = p.data.mesh;
      const start = m.faceRanges[r.index * 2],
        count = m.faceRanges[r.index * 2 + 1];
      n.set(0, 0, 0);
      for (let i = start; i < start + count; i += 3) {
        a.fromArray(m.positions, m.indices[i] * 3);
        b.fromArray(m.positions, m.indices[i + 1] * 3).sub(a);
        c.fromArray(m.positions, m.indices[i + 2] * 3).sub(a);
        n.add(b.cross(c));
      }
      if (n.lengthSq() > 0) sum.add(n.normalize().transformDirection(p.group.matrix));
    }
    return sum.lengthSq() > 1e-12 ? sum.normalize() : null;
  }

  /** Fit all; if the view is already fitted (nothing would move), go to the default iso view instead. */
  fitOrHome(animate = true) {
    const box = this.bounds();
    if (box.isEmpty()) return;
    const before = this.controls.state();
    this.fit(box, false);
    const after = this.controls.state();
    this.controls.apply(before);
    const r = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
    const same = before.position.distanceTo(after.position) < r * 0.02 && before.target.distanceTo(after.target) < r * 0.02 && Math.abs(before.orthoHeight - after.orthoHeight) < r * 0.02;
    if (same) this.setView("iso", animate);
    else this.controls.animateTo(after), this.requestRender();
  }

  setView(name: keyof typeof VIEW_DIRS, animate = true) {
    this.setViewDir(VIEW_DIRS[name].clone(), animate);
  }

  setViewDir(dir: THREE.Vector3, animate = true) {
    this.fit(this.bounds(), animate, dir);
  }

  cameraState() {
    const c = this.camera;
    return { position: c.position.toArray(), target: this.controls.target.toArray(), up: c.up.toArray(), fov: this.persp.fov, ortho: this.useOrtho, orthoHeight: this.controls.orthoHeight };
  }

  setCameraState(s: { position: number[]; target: number[]; up: number[]; ortho?: boolean; orthoHeight?: number }, animate = true) {
    if (s.ortho !== undefined) this.setProjection(s.ortho);
    const to: CamState = { position: new THREE.Vector3().fromArray(s.position), target: new THREE.Vector3().fromArray(s.target), up: new THREE.Vector3().fromArray(s.up), orthoHeight: s.orthoHeight ?? this.controls.orthoHeight };
    animate ? this.controls.animateTo(to) : this.controls.apply(to);
  }

  // ---------- assembly poses ----------
  /**
   * Move a part from where it's modeled (assembly drag): a column-major 4×4 rigid transform, or
   * null for the modeled position. Picking, bounds, pins and highlights all follow.
   */
  setPartTransform(id: string, m: ArrayLike<number> | null) {
    const prev = this.transforms.get(id);
    if (!m) {
      if (!prev) return;
      this.transforms.delete(id);
    } else if (prev) prev.fromArray(m as number[]);
    else this.transforms.set(id, new THREE.Matrix4().fromArray(m as number[]));
    const p = this.parts.get(id);
    if (p) {
      this.placeGroup(p.group, id);
      if (this.section) this.applyClip(p);
    }
    const g = this.ghosts.get(id);
    if (g) this.placeGroup(g, id);
    for (const o of this.overlaps.children) if (o.userData.part === id) this.placeGroup(o, id);
    for (const l of this.markup.children) if (l.userData.part === id) this.placeGroup(l, id);
    this.boundsCache = null;
    this.requestRender();
    this.emit("poses", id);
  }

  /** A part's transform from its modeled position (identity when it hasn't moved). */
  partTransform(id: string): THREE.Matrix4 {
    return this.transforms.get(id)?.clone() ?? new THREE.Matrix4();
  }

  /** Part coordinates -> world. */
  toWorld(part: string, v: THREE.Vector3): THREE.Vector3 {
    const m = this.transforms.get(part);
    return m ? v.clone().applyMatrix4(m) : v.clone();
  }

  /** World -> part coordinates. */
  toLocal(part: string, v: THREE.Vector3): THREE.Vector3 {
    const m = this.transforms.get(part);
    return m ? v.clone().applyMatrix4(m.clone().invert()) : v.clone();
  }

  private placeGroup(o: THREE.Object3D, part: string) {
    const m = this.transforms.get(part);
    o.matrixAutoUpdate = false;
    if (m) o.matrix.copy(m);
    else o.matrix.identity();
    o.matrixWorldNeedsUpdate = true;
  }

  /**
   * Where parts overlap (interference): red volumes, each mesh in part `a`'s coordinates. Drawn
   * solid where visible and, when `overlapsOnTop`, faintly through whatever covers them so buried
   * overlaps still read.
   */
  setInterferences(list: { a: string; b: string; mesh: import("./part").PartMesh }[]) {
    for (const o of [...this.overlaps.children]) {
      o.traverse((c: any) => (c.geometry?.dispose(), c.material?.dispose?.()));
      this.overlaps.remove(o);
    }
    const red = new THREE.Color(this.theme.error);
    for (const x of list) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(x.mesh.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(x.mesh.normals, 3));
      g.setIndex(new THREE.BufferAttribute(x.mesh.indices, 1));
      const grp = new THREE.Group();
      // through other geometry: faint
      const ghost = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: red, transparent: true, opacity: 0.28, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      ghost.renderOrder = 8;
      ghost.userData.ghost = true;
      // where it's the nearest surface: solid, lit a little so its shape reads
      const solid = new THREE.Mesh(g, withDepthBias(new THREE.MeshStandardMaterial({ color: red, emissive: red, emissiveIntensity: 0.35, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 0.0005));
      solid.renderOrder = 9;
      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.BufferAttribute(x.mesh.edgePositions, 3));
      const edges = new THREE.LineSegments(eg, withDepthBias(new THREE.LineBasicMaterial({ color: red, transparent: true, opacity: 0.9 }), 0.001));
      edges.renderOrder = 10;
      grp.add(ghost, solid, edges);
      grp.userData.part = x.a;
      grp.userData.pair = [x.a, x.b];
      this.placeGroup(grp, x.a);
      this.overlaps.add(grp);
    }
    this.syncOverlaps();
    this.requestRender();
  }

  // ---------- markup (pencil strokes) ----------
  /** Replace the drawn markup strokes (world coordinates). */
  setMarkup(strokes: MarkupStroke[]) {
    for (const c of this.markup.children) {
      (c as Line2).geometry.dispose();
      ((c as Line2).material as LineMaterial).dispose();
    }
    this.markup.clear();
    for (const s of strokes) {
      if (!s.points.length) continue;
      const g = new LineGeometry();
      // A click is a dot. A tiny segment gives Line2 round caps without a zero-length direction.
      let points = s.points;
      if (points.length === 1) {
        const point = new THREE.Vector3(...points[0]);
        const start = s.part ? this.toWorld(s.part, point) : point;
        const end = start.clone().addScaledVector(new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0), Math.max(1, this.camera.position.distanceTo(start)) * 1e-6);
        points = [points[0], (s.part ? this.toLocal(s.part, end) : end).toArray() as [number, number, number]];
      }
      g.setPositions(points.flat());
      const m = withDepthBias(new LineMaterial({ color: new THREE.Color(s.color), linewidth: s.width ?? 3, resolution: this.resolution, worldUnits: false, transparent: true, opacity: s.dim ? 0.35 : 0.95, depthTest: true }), 0.001) as LineMaterial;
      const l = new Line2(g, m);
      l.computeLineDistances();
      l.renderOrder = 4;
      l.userData.id = s.id;
      l.userData.part = s.part;
      if (s.part) this.placeGroup(l, s.part);
      this.markup.add(l);
    }
    this.requestRender();
  }

  // ---------- section view ----------
  private section: THREE.Plane | null = null;

  /** Clip the model by a plane (normal points at the removed side), or null to clear. */
  setSection(plane: { origin: number[]; normal: number[] } | null) {
    this.renderer.localClippingEnabled = true;
    this.section = plane ? new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3().fromArray(plane.normal).normalize().negate(), new THREE.Vector3().fromArray(plane.origin)) : null;
    for (const p of this.parts.values()) this.applyClip(p);
    this.syncOverlaps();
    this.sectionArrow.visible = !!this.section;
    this.requestRender();
  }

  /**
   * The section handle: an arrow standing on the plane (opposite the model's centre), pointing at
   * the cut-away side. It keeps a constant size on screen; the app drags it
   * along its axis to move the plane and clicks it to flip.
   */
  private sectionArrow = (() => {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92, depthTest: false, depthWrite: false, toneMapped: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 12).translate(0, 0.35, 0), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 20).translate(0, 0.85, 0), mat);
    const base = new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 12), mat);
    // generous, invisible grab target around the whole arrow
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.1, 8).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ visible: false }));
    hit.name = "hit";
    g.add(shaft, head, base, hit);
    for (const c of g.children) c.renderOrder = 30;
    g.visible = false;
    return g;
  })();
  private sectionArrowHover = false;
  private static readonly ARROW_PX = 64;

  /** Place and size the section arrow for this frame. */
  private syncSectionArrow() {
    const a = this.sectionArrow,
      pl = this.section;
    if (!pl) return void (a.visible = false);
    if (!a.parent) this.scene.add(a);
    a.visible = true;
    const b = this.bounds();
    const c = b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3());
    pl.projectPoint(c, a.position);
    a.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pl.normal.clone().negate());
    this.camera.updateMatrixWorld();
    a.scale.setScalar(this.worldPerPx(a.position) * Viewer.ARROW_PX * (this.sectionArrowHover ? 1.12 : 1));
    ((a.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(this.sectionArrowHover ? this.theme.measureHover : this.theme.measure);
  }

  /** World units per CSS pixel at a point. */
  private worldPerPx(p: THREE.Vector3) {
    const cam = this.camera,
      h = Math.max(this.container.clientHeight, 1);
    if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const depth = -p.clone().applyMatrix4(cam.matrixWorldInverse).z;
      return (2 * Math.max(depth, 1e-6) * Math.tan(THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov / 2))) / h;
    }
    const o = cam as THREE.OrthographicCamera;
    return (o.top - o.bottom) / o.zoom / h;
  }

  /** Is the section arrow under this screen point (CSS px)? */
  sectionArrowAt(x: number, y: number): boolean {
    if (!this.section || !this.sectionArrow.visible) return false;
    this.syncSectionArrow();
    this.sectionArrow.updateMatrixWorld(true);
    const rc = new THREE.Raycaster();
    rc.ray.copy(this.rayAt(x, y));
    return rc.intersectObject(this.sectionArrow.getObjectByName("hit")!, false).length > 0;
  }

  setSectionArrowHover(on: boolean) {
    if (on === this.sectionArrowHover) return;
    this.sectionArrowHover = on;
    this.requestRender();
  }

  /**
   * Where the pointer is along the section arrow's axis (world units toward the kept side, from
   * the arrow's base), or null when looking straight down the axis.
   */
  sectionAxisAt(x: number, y: number): number | null {
    if (!this.section) return null;
    const ray = this.rayAt(x, y),
      u = this.section.normal,
      b0 = this.bounds(),
      w = this.section.projectPoint(b0.isEmpty() ? new THREE.Vector3() : b0.getCenter(new THREE.Vector3()), new THREE.Vector3()).sub(ray.origin);
    const b = u.dot(ray.direction),
      den = 1 - b * b;
    if (den < 1e-4) return null;
    return (b * ray.direction.dot(w) - u.dot(w)) / den;
  }

  /** Draw overlap volumes on top of the geometry covering them (x-ray), or depth-tested like any surface. */
  setOverlapsOnTop(on: boolean) {
    if (on === this.overlapsOnTop) return;
    this.overlapsOnTop = on;
    this.syncOverlaps();
    this.requestRender();
  }

  /** Overlap volumes show while both of their parts do, and are cut by the section plane. */
  private syncOverlaps() {
    for (const o of this.overlaps.children) {
      const [a, b] = o.userData.pair as [string, string];
      o.visible = !!this.parts.get(a)?.group.visible && !!this.parts.get(b)?.group.visible;
      o.traverse((c: any) => {
        if (!c.material) return;
        if (c.userData.ghost) c.visible = this.overlapsOnTop;
        if (c.isLineSegments) c.material.depthTest = !this.overlapsOnTop;
        c.material.clippingPlanes = this.section ? [this.section] : null;
        c.material.needsUpdate = true;
      });
    }
  }

  private applyClip(p: PartObject) {
    if (!this.section) return p.setClip([]);
    // varied per part (stable across regenerations: keyed on the id), like drafting section hatches
    let h = 2166136261;
    for (let i = 0; i < p.id.length; i++) h = Math.imul(h ^ p.id.charCodeAt(i), 16777619);
    h >>>= 0;
    const angles = [45, 135, 60, 120, 30, 150, 75, 105];
    const scales = [1, 0.75, 1.3];
    // ~80 lines across a part's bounding diameter, whatever its size (the shader fades them out if they get too dense on screen)
    const spacing = Math.max(p.faceMesh.geometry.boundingSphere?.radius ?? 1, 1e-3) / 40;
    p.setClip([this.section], { angle: (angles[h % angles.length] * Math.PI) / 180, spacing: spacing * scales[(h >>> 8) % scales.length], pixelRatio: this.renderer.getPixelRatio() });
  }

  /** Plane of a planar face (outward normal, centroid), or null if the face is curved. */
  facePlane(ref: EntityRef): { origin: number[]; normal: number[] } | null {
    const p = this.parts.get(ref.part);
    if (!p || ref.kind !== "face") return null;
    const m = p.data.mesh;
    const start = m.faceRanges[ref.index * 2],
      count = m.faceRanges[ref.index * 2 + 1];
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3(),
      n = new THREE.Vector3(),
      o = new THREE.Vector3();
    let area = 0;
    for (let i = start; i < start + count; i += 3) {
      a.fromArray(m.positions, m.indices[i] * 3);
      b.fromArray(m.positions, m.indices[i + 1] * 3);
      c.fromArray(m.positions, m.indices[i + 2] * 3);
      const tn = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
      const ta = tn.length() / 2;
      n.add(tn);
      o.addScaledVector(a.add(b).add(c).divideScalar(3), ta);
      area += ta;
    }
    if (area <= 0 || n.lengthSq() === 0) return null;
    n.normalize();
    o.divideScalar(area);
    // planar: every vertex lies on the mean plane (within a hair of the face's size)
    const lo = p.faceVerts[ref.index * 2],
      cnt = p.faceVerts[ref.index * 2 + 1];
    const tol = Math.max(Math.sqrt(area) * 1e-4, 1e-6);
    for (let v = lo; v < lo + cnt; v++) if (Math.abs(a.fromArray(m.positions, v * 3).sub(o).dot(n)) > tol) return null;
    return { origin: o.applyMatrix4(p.group.matrix).toArray(), normal: n.transformDirection(p.group.matrix).toArray() };
  }

  getSection() {
    if (!this.section) return null;
    const n = this.section.normal.clone().negate();
    return { origin: this.section.coplanarPoint(new THREE.Vector3()).toArray(), normal: n.toArray() };
  }

  // ---------- dimensions (measure tool) ----------
  private dims = new THREE.Group();
  /** Draw a dimension between two points (or clear with null). */
  setDimension(a: THREE.Vector3 | null, b?: THREE.Vector3) {
    for (const c of this.dims.children) (c as any).geometry?.dispose?.(), (c as any).material?.dispose?.();
    this.dims.clear();
    if (!this.dims.parent) this.scene.add(this.dims);
    if (a && b) {
      const g = new LineGeometry();
      g.setPositions([...a.toArray(), ...b.toArray()]);
      const line = new Line2(g, withDepthBias(new LineMaterial({ color: new THREE.Color(this.theme.measure), linewidth: 2, resolution: this.resolution, worldUnits: false, depthTest: false, transparent: true }), 0.001) as LineMaterial);
      line.renderOrder = 7;
      const r = Math.max(0.3, a.distanceTo(b) * 0.012);
      const dotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(this.theme.measure), depthTest: false, transparent: true });
      for (const p of [a, b]) {
        const d = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), dotMat);
        d.position.copy(p);
        d.renderOrder = 7;
        this.dims.add(d);
      }
      this.dims.add(line);
    }
    this.requestRender();
  }

  // ---------- compare (ghost of previous geometry) ----------
  /** Show `mesh` as the "before" ghost of `part` (null removes it). */
  setGhost(part: string, mesh: import("./part").PartMesh | null) {
    const prev = this.ghosts.get(part);
    if (prev) {
      this.scene.remove(prev);
      prev.traverse((o: any) => (o.geometry?.dispose(), o.material?.dispose?.()));
      this.ghosts.delete(part);
    }
    if (mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.theme.ghost), roughness: 0.6, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.BufferAttribute(mesh.edgePositions, 3));
      // ghost edges draw through the current geometry, so a change inside it still reads
      const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: new THREE.Color(this.theme.accent), transparent: true, depthWrite: false, depthTest: false }));
      edges.renderOrder = 6;
      const grp = new THREE.Group();
      grp.add(new THREE.Mesh(g, mat), edges);
      grp.renderOrder = 5;
      this.placeGroup(grp, part);
      this.ghosts.set(part, grp);
      this.scene.add(grp);
    }
    this.applyBlend();
  }

  clearGhosts() {
    for (const p of [...this.ghosts.keys()]) this.setGhost(p, null);
  }

  /**
   * Before ↔ after (§8 Compare): 0 = old geometry alone (solid), 0.5 = ghost overlay,
   * 1 = new geometry alone.
   */
  setBlend(t: number) {
    this.blend = THREE.MathUtils.clamp(t, 0, 1);
    this.applyBlend();
  }

  private applyBlend() {
    const t = this.blend;
    const comparing = this.ghosts.size > 0;
    // ghost: opaque at 0, faint at 0.5, gone at 1
    const ghostOpacity = t <= 0.5 ? 1 - t * 1.3 : Math.max(0, 0.35 - (t - 0.5) * 0.7);
    for (const g of this.ghosts.values()) {
      g.visible = ghostOpacity > 0.01 || (t > 0 && t < 1);
      g.traverse((o: any) => {
        if (o.material) {
          o.material.opacity = o.isLineSegments ? (t >= 1 ? 0 : t <= 0 ? 0 : Math.min(0.9, 0.35 + ghostOpacity)) : ghostOpacity;
          o.material.depthWrite = ghostOpacity > 0.95;
        }
      });
    }
    // current: hidden at 0, full from 0.5
    const cur = !comparing ? 1 : t >= 0.5 ? 1 : t * 2;
    for (const [id, p] of this.parts) if (this.ghosts.has(id)) p.setFaceStyle({ visible: cur > 0.02, opacity: cur }), (p.edgeLines.visible = cur > 0.3 && this.mode !== "shaded");
    this.requestRender();
  }

  // ---------- picking ----------
  /**
   * GPU ID-buffer pick at CSS pixel (x, y): renders a small window around the cursor with pick
   * materials and returns the closest entity to the center (edges win within their wide proxy).
   */
  pick(x: number, y: number): EntityRef | null {
    const t0 = performance.now();
    const cam = this.camera;
    const dpr = this.renderer.getPixelRatio();
    const W = this.canvas.width,
      H = this.canvas.height;
    // snap radii in device px: a vertex within VERTEX_SNAP CSS px wins, then an edge within EDGE_SNAP
    const vSnap = VERTEX_SNAP * dpr,
      eSnap = EDGE_SNAP * dpr;
    const R = Math.ceil(Math.max(vSnap, eSnap));
    const size = R * 2 + 1;
    if (this.pickTarget.width !== size) this.pickTarget.setSize(size, size);
    if (this.pickBuf.length !== size * size * 4) this.pickBuf = new Float32Array(size * size * 4);
    const px = Math.round(x * dpr),
      py = Math.round(y * dpr);
    const lines = this.mode !== "shaded";
    cam.setViewOffset(W, H, px - R, py - R, size, size);
    this.renderIds(this.pickTarget, this.filter.edge && lines, this.filter.face || this.filter.part, this.filter.vertex && lines, { edge: eSnap * 2 + 1, vertex: vSnap * 2 + 1 });
    cam.clearViewOffset();
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, size, size, this.pickBuf);
    // edges and vertices are thin: within their snap radius they win over the face under the cursor
    type Hit = { d: number; id: NonNullable<ReturnType<typeof decodeId>> };
    let center: ReturnType<typeof decodeId> = null;
    let bestVert: Hit | null = null,
      bestEdge: Hit | null = null,
      bestAny: Hit | null = null;
    const visibleVertices = new Map<string, boolean>();
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const o = (j * size + i) * 4;
        const id = decodeId(this.pickBuf[o], this.pickBuf[o + 1], this.pickBuf[o + 2]);
        if (!id) continue;
        if (id.kind === "vertex") {
          const key = `${id.slot}:${id.index}`;
          if (!visibleVertices.has(key)) visibleVertices.set(key, this.vertexVisible(this.slots[id.slot]!, id.index));
          if (!visibleVertices.get(key)) continue;
        }
        const d = (i - R) ** 2 + (j - R) ** 2;
        if (d === 0) center = id;
        if (id.kind === "vertex" && d <= vSnap * vSnap && (!bestVert || d < bestVert.d)) bestVert = { d, id };
        if (id.kind === "edge" && d <= eSnap * eSnap && (!bestEdge || d < bestEdge.d)) bestEdge = { d, id };
        if (id.kind !== "vertex" && (!bestAny || d < bestAny.d)) bestAny = { d, id };
      }
    // the disc proxies cover the cursor well beyond the vertex itself: only a snapped vertex counts
    if (center?.kind === "vertex") center = null;
    // an edge only wins within a band proportional to the face under the cursor, so small faces stay pickable
    if (bestEdge && !bestVert && this.filter.face) {
      const under = this.faceUnder(px, py, eSnap, W, H);
      if (under && bestEdge.d > under.snap * under.snap) (bestEdge = null), (center = under.id);
    }
    const best = { id: bestVert?.id ?? bestEdge?.id ?? center ?? (bestAny && bestAny.d <= 4 * dpr * dpr ? bestAny.id : null) };
    this.stats.lastPickMs = performance.now() - t0;
    if (!best?.id) return null;
    const part = this.slots[best.id.slot];
    if (!part) return null;
    if (this.filter.part && !this.filter.face && !this.filter.edge && !this.filter.vertex) return { part, kind: "part" as any, index: 0 };
    if (best.id.kind === "face" && !this.filter.face) return this.filter.part ? { part, kind: "part" as any, index: 0 } : null;
    return { part, kind: best.id.kind, index: best.id.index };
  }

  /**
   * The face under device pixel (px, py), from a faces-only ID pass, with the edge snap radius it
   * allows: a fraction of the face's width across the cursor, measured toward its nearest boundary
   * and away from it. Faces wide enough for the full `eSnap` measure as such.
   */
  private faceUnder(px: number, py: number, eSnap: number, W: number, H: number): { id: NonNullable<ReturnType<typeof decodeId>>; snap: number } | null {
    const full = eSnap / EDGE_SNAP_FACE_FRACTION;
    const R = Math.ceil(full);
    const size = R * 2 + 1;
    if (this.facePickTarget.width !== size) this.facePickTarget.setSize(size, size);
    if (this.facePickBuf.length !== size * size * 4) this.facePickBuf = new Float32Array(size * size * 4);
    this.camera.setViewOffset(W, H, px - R, py - R, size, size);
    this.renderIds(this.facePickTarget, false, true);
    this.camera.clearViewOffset();
    const buf = this.facePickBuf;
    this.renderer.readRenderTargetPixels(this.facePickTarget, 0, 0, size, size, buf);
    const at = (i: number, j: number) => (j * size + i) * 4;
    const c = at(R, R);
    const id = decodeId(buf[c], buf[c + 1], buf[c + 2]);
    if (id?.kind !== "face") return null;
    const same = (i: number, j: number) => {
      const o = at(i, j);
      return buf[o] === buf[c] && buf[o + 1] === buf[c + 1] && buf[o + 2] === buf[c + 2] && buf[o + 3] === buf[c + 3];
    };
    // nearest pixel off this face
    let bi = -1,
      bj = -1,
      bd = Infinity;
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const d = (i - R) ** 2 + (j - R) ** 2;
        if (d < bd && !same(i, j)) (bd = d), (bi = i), (bj = j);
      }
    if (bi < 0) return { id, snap: eSnap };
    const near = Math.sqrt(bd);
    // walk away from that boundary until leaving the face (or the window: wide enough)
    const ux = (R - bi) / near,
      uy = (R - bj) / near;
    let far = Infinity;
    for (let t = 0.5; t <= R * 1.5; t += 0.5) {
      const i = Math.round(R + ux * t),
        j = Math.round(R + uy * t);
      if (i < 0 || j < 0 || i >= size || j >= size) break;
      if (!same(i, j)) {
        far = t;
        break;
      }
    }
    const width = near + far;
    const floor = EDGE_SNAP_MIN * this.renderer.getPixelRatio();
    return { id, snap: Math.min(eSnap, Math.max(floor, width * EDGE_SNAP_FACE_FRACTION)) };
  }

  /** A vertex disc can extend beyond an occluder's silhouette even when its center is hidden. */
  private vertexVisible(part: string, index: number): boolean {
    const p = this.parts.get(part);
    const vertex = p?.data.vertices?.[index];
    if (!p || !vertex) return false;
    const point = new THREE.Vector3(...vertex).applyMatrix4(p.group.matrixWorld);
    const screen = this.project(point);
    if (!screen) return false;
    const ray = this.rayAt(screen.x, screen.y);
    const distance = ray.origin.distanceTo(point);
    const rc = new THREE.Raycaster(ray.origin, ray.direction, 0, distance - Math.max(1, distance) * 1e-7);
    for (const other of this.parts.values()) {
      if (!other.group.visible) continue;
      if (rc.intersectObject(other.faceMesh, false).some((hit) => !this.section || this.section.distanceToPoint(hit.point) >= 0)) return false;
    }
    return true;
  }

  /**
   * Render the ID buffer (pick materials; no background, helpers or markup) into `rt` with the
   * current camera, view offset included. Edges draw on top of faces within their pixel footprint.
   */
  private renderIds(rt: THREE.WebGLRenderTarget, edges: boolean, faces: boolean, vertices = false, px?: { edge: number; vertex: number }) {
    const r = this.renderer;
    for (const p of this.parts.values()) p.pickMode(true, edges, faces, vertices, px);
    const bg = this.scene.background,
      env = this.scene.environment,
      tm = r.toneMapping;
    this.scene.background = null;
    this.scene.environment = null;
    this.grid.visible = this.triad.visible = this.markup.visible = this.sectionArrow.visible = false;
    const overlaps = this.overlaps.visible;
    this.overlaps.visible = false;
    r.toneMapping = THREE.NoToneMapping;
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    r.toneMapping = tm;
    this.scene.background = bg;
    this.scene.environment = env;
    this.restoreHelpers();
    this.markup.visible = true;
    this.sectionArrow.visible = !!this.section;
    this.overlaps.visible = overlaps;
    for (const p of this.parts.values()) p.pickMode(false, false, false);
  }

  /**
   * Box select (§8 Selection): both modes require visibility. `window` additionally requires
   * the entity's projected geometry to be fully inside the rectangle.
   */
  pickRect(x0: number, y0: number, x1: number, y1: number, mode: "window" | "crossing"): EntityRef[] {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const out: EntityRef[] = [];
    const wantFace = this.filter.face,
      wantEdge = this.filter.edge && this.mode !== "shaded",
      wantVertex = this.filter.vertex && this.mode !== "shaded";
    if (mode === "window") {
      const visible = new Set(this.pickRect(x0, y0, x1, y1, "crossing").map((r) => `${r.part}:${r.kind}:${r.index}`));
      const v = new THREE.Vector3();
      let place = new THREE.Matrix4();
      const inside = (arr: Float32Array, i: number) => {
        v.fromArray(arr, i * 3).applyMatrix4(place).project(this.camera);
        const sx = ((v.x + 1) / 2) * this.container.clientWidth,
          sy = ((1 - v.y) / 2) * this.container.clientHeight;
        return sx >= ax && sx <= bx && sy >= ay && sy <= by && v.z <= 1;
      };
      for (const [id, p] of this.parts) {
        if (!p.group.visible) continue;
        const m = p.data.mesh;
        place = p.group.matrix;
        if (this.filter.part && !wantFace && !wantEdge && !wantVertex) {
          let all = true;
          for (let i = 0; i < m.positions.length / 3 && all; i += 7) all = inside(m.positions, i);
          if (all) out.push({ part: id, kind: "part" as any, index: 0 });
          continue;
        }
        if (wantFace)
          for (let f = 0; f < m.faceRanges.length / 2; f++) {
            const lo = p.faceVerts[f * 2],
              cnt = p.faceVerts[f * 2 + 1];
            if (!cnt) continue;
            let all = true;
            for (let i = lo; i < lo + cnt && all; i++) all = inside(m.positions, i);
            if (all) out.push({ part: id, kind: "face", index: f });
          }
        if (wantEdge)
          for (let e = 0; e < m.edgeRanges.length / 2; e++) {
            if (p.data.hiddenEdges?.has(e)) continue;
            const s0 = m.edgeRanges[e * 2],
              c = m.edgeRanges[e * 2 + 1];
            if (!c) continue;
            let all = true;
            for (let i = s0; i < s0 + c && all; i++) all = inside(m.edgePositions, i);
            if (all) out.push({ part: id, kind: "edge", index: e });
          }
        if (wantVertex)
          for (const index of p.pickableVertices) {
            v.fromArray(p.data.vertices![index]).applyMatrix4(place);
            const s = this.project(v);
            if (s && s.x >= ax && s.x <= bx && s.y >= ay && s.y <= by) out.push({ part: id, kind: "vertex", index });
          }
      }
      return out.filter((r) => visible.has(`${r.part}:${r.kind}:${r.index}`));
    }
    // crossing: render the ID pass over the rectangle
    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.round((bx - ax) * dpr)),
      h = Math.max(1, Math.round((by - ay) * dpr));
    const scale = Math.min(1, 512 / Math.max(w, h)); // cap the readback
    const rw = Math.max(1, Math.round(w * scale)),
      rh = Math.max(1, Math.round(h * scale));
    const rt = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.FloatType });
    const cam = this.camera;
    cam.setViewOffset(this.canvas.width, this.canvas.height, Math.round(ax * dpr), Math.round(ay * dpr), w, h);
    this.renderIds(rt, wantEdge, wantFace || this.filter.part, wantVertex);
    cam.clearViewOffset();
    const buf = new Float32Array(rw * rh * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, rw, rh, buf);
    rt.dispose();
    const seen = new Set<string>();
    for (let i = 0; i < buf.length; i += 4) {
      const id = decodeId(buf[i], buf[i + 1], buf[i + 2]);
      if (!id) continue;
      const part = this.slots[id.slot];
      if (!part) continue;
      const ref: EntityRef = this.filter.part && !wantFace && !wantEdge && !wantVertex
        ? { part, kind: "part" as any, index: 0 }
        : { part, kind: id.kind, index: id.index };
      const k = `${ref.part}:${ref.kind}:${ref.index}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (ref.kind === "vertex" && !this.vertexVisible(part, ref.index)) continue;
      out.push(ref);
    }
    this.requestRender();
    return out;
  }

  /** The visible face under (x, y); Tab must not expose faces behind another surface. */
  facesUnder(x: number, y: number): EntityRef[] {
    const hit = this.pickPoint(x, y);
    return hit ? [{ part: hit.part, kind: hit.kind, index: hit.index }] : [];
  }

  /**
   * Pick plus the exact surface point and normal (ray vs. the picked face's triangles). `picked`
   * skips the GPU pick when the face under (x, y) is already known.
   */
  pickPoint(x: number, y: number, picked?: EntityRef | null): (EntityRef & { point: THREE.Vector3; normal?: THREE.Vector3; local?: THREE.Vector3 }) | null {
    let ref = picked;
    if (ref === undefined) {
      const saved = this.filter;
      this.filter = { face: true, edge: false, vertex: false, part: false };
      ref = this.pick(x, y);
      this.filter = saved;
    }
    if (!ref || ref.kind !== "face") return null;
    const p = this.parts.get(ref.part)!;
    // the mesh is in part coordinates: intersect there, answer in world coordinates
    const ray = this.rayAt(x, y).applyMatrix4(p.group.matrix.clone().invert());
    const m = p.data.mesh;
    const start = m.faceRanges[ref.index * 2],
      count = m.faceRanges[ref.index * 2 + 1];
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3(),
      hit = new THREE.Vector3();
    let best: THREE.Vector3 | null = null,
      bd = Infinity,
      bn: THREE.Vector3 | undefined;
    for (let i = start; i < start + count; i += 3) {
      a.fromArray(m.positions, m.indices[i] * 3);
      b.fromArray(m.positions, m.indices[i + 1] * 3);
      c.fromArray(m.positions, m.indices[i + 2] * 3);
      const h = ray.intersectTriangle(a, b, c, false, hit);
      if (h) {
        const d = h.distanceTo(ray.origin);
        if (d < bd) {
          bd = d;
          best = h.clone();
          bn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
        }
      }
    }
    if (!best) {
      // grazing hit (the ID buffer saw the face, the ray just misses its triangles): take the point
      // on the cursor ray nearest the face's closest vertex, which keeps the pivot under the cursor
      let vd = Infinity;
      for (let i = start; i < start + count; i++) {
        a.fromArray(m.positions, m.indices[i] * 3);
        const d = ray.distanceSqToPoint(a);
        if (d < vd) (vd = d), b.copy(a);
      }
      best = vd < Infinity ? ray.closestPointToPoint(b, new THREE.Vector3()) : p.faceCenter(ref.index, new THREE.Vector3());
    }
    return { ...ref, point: best.clone().applyMatrix4(p.group.matrix), normal: bn?.transformDirection(p.group.matrix), local: best };
  }

  rayAt(x: number, y: number): THREE.Ray {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), this.camera);
    return rc.ray;
  }

  /**
   * Is `p` (on a surface) visible from the camera? Compares the depth of the surface under its
   * screen position with the point's own distance. Used to hide pins behind geometry.
   */
  isPointVisible(p: THREE.Vector3, tolerance = 0.02): boolean {
    const s = this.project(p);
    if (!s || s.x < 0 || s.y < 0 || s.x > this.container.clientWidth || s.y > this.container.clientHeight) return false;
    const hit = this.pickPoint(s.x, s.y);
    if (!hit) return true;
    const cam = this.camera.position;
    const dp = cam.distanceTo(p),
      dh = cam.distanceTo(hit.point);
    const scale = Math.max(1, this.modelSphere().radius);
    return dp <= dh + tolerance * scale;
  }

  /**
   * isPointVisible for many points at once: one ID render of the whole view (at CSS resolution)
   * and a pixel read per point, instead of a full pick (render + GPU stall) each.
   */
  pointsVisible(points: THREE.Vector3[], tolerance = 0.02): boolean[] {
    const W = Math.max(1, this.container.clientWidth),
      H = Math.max(1, this.container.clientHeight);
    const screen = points.map((p) => {
      const s = this.project(p);
      return s && s.x >= 0 && s.y >= 0 && s.x <= W && s.y <= H ? s : null;
    });
    if (!screen.some(Boolean)) return points.map(() => false);
    const rt = (this.visTarget ??= new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: true }));
    if (rt.width !== W || rt.height !== H) rt.setSize(W, H);
    this.renderIds(rt, false, true);
    const px = new Float32Array(4);
    const cam = this.camera.position;
    const scale = Math.max(1, this.modelSphere().radius);
    return points.map((p, i) => {
      const s = screen[i];
      if (!s) return false;
      this.renderer.readRenderTargetPixels(rt, Math.min(W - 1, Math.floor(s.x)), H - 1 - Math.min(H - 1, Math.floor(s.y)), 1, 1, px);
      const id = decodeId(px[0], px[1], px[2]);
      const part = id?.kind === "face" ? this.slots[id.slot] : null;
      if (!id || !part) return true;
      const hit = this.pickPoint(s.x, s.y, { part, kind: "face", index: id.index });
      return !hit || cam.distanceTo(p) <= cam.distanceTo(hit.point) + tolerance * scale;
    });
  }
  private visTarget: THREE.WebGLRenderTarget | null = null;

  /** Screen position (CSS px) of a world point, or null if behind the camera. */
  project(p: THREE.Vector3): { x: number; y: number } | null {
    const v = p.clone().project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
  }

  /** Center of an entity in world space. */
  entityCenter(r: EntityRef): THREE.Vector3 | null {
    const p = this.parts.get(r.part);
    if (!p) return null;
    if (r.kind === "face") return p.faceCenter(r.index, new THREE.Vector3()).applyMatrix4(p.group.matrix);
    if (r.kind === "edge") {
      const m = p.data.mesh;
      const s = m.edgeRanges[r.index * 2],
        c = m.edgeRanges[r.index * 2 + 1];
      const mid = s + Math.floor(c / 2);
      return new THREE.Vector3().fromArray(m.edgePositions, mid * 3).applyMatrix4(p.group.matrix);
    }
    if (r.kind === "vertex") {
      const at = p.data.vertices?.[r.index];
      return at ? new THREE.Vector3(...at).applyMatrix4(p.group.matrix) : null;
    }
    return p.faceMesh.geometry.boundingSphere?.center.clone().applyMatrix4(p.group.matrix) ?? null;
  }

  // ---------- frame loop ----------
  requestRender() {
    if (this.disposed) return;
    this.needsRender = true;
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  private syncCameras() {
    const w = Math.max(1, this.container.clientWidth),
      h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    const oh = this.controls.orthoHeight;
    this.ortho.left = (-oh * aspect) / 2;
    this.ortho.right = (oh * aspect) / 2;
    this.ortho.top = oh / 2;
    this.ortho.bottom = -oh / 2;
    this.ortho.updateProjectionMatrix();
    // near/far from scene size, so depth precision stays good
    const s = this.modelSphere();
    if (!s.isEmpty()) {
      const d = this.persp.position.distanceTo(s.center);
      this.persp.near = Math.max(0.01, (d - s.radius * 4) * 0.5, s.radius / 2000);
      this.persp.far = d + s.radius * 20;
      this.persp.updateProjectionMatrix();
    }
    this.requestRender();
    this.emit("camera", null);
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth),
      h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.getDrawingBufferSize(this.resolution);
    this.pixelRatio.value = this.renderer.getPixelRatio();
    for (const b of [this.aoFull, this.aoFast]) if (b) this.sizeAO(b, b === this.aoFull ? this.renderer.getPixelRatio() : 1);
    this.syncCameras();
    this.renderNow();
  }

  private loop = () => {
    this.raf = 0;
    if (this.disposed) return;
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    // only a camera animation moves the camera; fades just redraw
    if (this.controls.tick(now)) this.syncCameras();
    // Camera changes and crossfades request their next frame; idle viewers schedule nothing.
    if (this.tickFades(now)) this.requestRender();
    if (!this.needsRender) return;
    // motion that can't hold ~45 fps drops to 1× pixel ratio until the camera stops
    if (this.moving && !this.lowRes && this.baseDpr > 1) {
      this.slowFrames = dt > 22 && dt < 250 ? this.slowFrames + 1 : 0;
      if (this.slowFrames >= 4) return this.setLowRes(true); // resize() renders
    }
    this.renderNow();
  };

  /**
   * AO + depth halo, every frame (orbiting included, like Onshape). A G-buffer of the faces alone
   * feeds GTAO (ao.ts) and the halo (halo.ts): per device pixel at rest (per CSS pixel, a 2×
   * display turns contact shading blocky along creases), per CSS pixel while the camera moves,
   * where a quarter of the cost matters more than the fine detail. The face material then reads
   * both at its own pixels (shading.ts).
   */
  private makeAO(scale: number): AOBuffer {
    const pass = new GTAOPass(this.scene, this.camera, 1, 1);
    pass.output = GTAOPass.OUTPUT.Off; // compute only; the face material applies it
    // float depth: GTAO's default 24-bit buffer can't resolve reversed-Z at range, and the
    // quantization reads as occlusion on flat surfaces (a uniform grey wash instead of contact AO)
    pass.depthTexture.type = THREE.FloatType;
    // each buffer's sample count stays fixed so nothing recompiles mid-orbit
    setupAO(pass, scale > 1 ? 16 : 12);
    const halo = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const b = { pass, halo, haloScratch: halo.clone(), scale, radius: 0 };
    this.sizeAO(b, scale);
    return b;
  }

  private sizeAO(b: AOBuffer, scale: number) {
    const w = Math.max(1, this.container.clientWidth),
      h = Math.max(1, this.container.clientHeight);
    b.scale = scale;
    b.pass.setSize(Math.round(w * scale), Math.round(h * scale));
    b.halo.setSize(Math.round(w * scale), Math.round(h * scale));
    b.haloScratch.setSize(Math.round(w * scale), Math.round(h * scale));
    sizeAO(b.pass, scale);
  }

  /**
   * The shaded frame: 1) G-buffer, AO and halo from the faces, 2) the faces, lit with AO and
   * multiplied by the halo, 3) everything else (edges, silhouettes, overlays, markup) over that,
   * depth-tested against the faces. Lines and helpers are never darkened and blend exactly as in
   * a plain render.
   */
  private renderShaded() {
    const r = this.renderer,
      cam = this.camera;
    // both up front, so the first orbit doesn't stall allocating the fast one
    this.aoFull ??= this.makeAO(r.getPixelRatio());
    this.aoFast ??= this.makeAO(1);
    const b = this.moving ? this.aoFast : this.aoFull;
    const ao = b.pass,
      halo = (this.haloPass ??= new HaloPass(cam));
    (ao as any).camera = cam;
    halo.camera = cam;
    // scale the AO radius and the halo's overlap gap with the model
    const sr = this.modelSphere().radius,
      radius = sr > 0 ? sr : 10;
    if (radius !== b.radius) scaleAO(ao, radius), (b.radius = radius);
    halo.threshold = radius * 0.02;
    halo.range = radius * 0.2;
    const layers = cam.layers.mask,
      autoClear = r.autoClear,
      bg = this.scene.background,
      s = screenShading;
    cam.layers.set(FACE_LAYER);
    ao.render(r, null as any, null as any, 0, false);
    halo.render(r, { depth: ao.depthTexture, normal: ao.normalTexture, width: ao.width, height: ao.height, scale: b.scale }, b.halo, b.haloScratch, this.moving);
    // from here on everything draws over what's on the canvas: no clears
    r.autoClear = false;
    r.setRenderTarget(null);
    s.psAO.value = ao.pdRenderTarget.texture;
    s.psHalo.value = b.halo.texture;
    s.psDepth.value = ao.depthTexture;
    s.psProjInv.value.copy(cam.projectionMatrixInverse);
    s.psViewport.value.copy(this.resolution);
    s.psOn.value = true;
    try {
      r.render(this.scene, cam);
    } finally {
      s.psOn.value = false;
      s.psAO.value = s.psHalo.value = s.psDepth.value = null;
      cam.layers.mask = layers;
    }
    const faces = this.faceVis;
    faces.length = 0;
    // opaque faces are drawn; a translucent part's faces blend in now, over everything
    for (const p of this.parts.values()) if (!p.translucent) faces.push([p.faceMesh, p.faceMesh.visible]), (p.faceMesh.visible = false);
    this.scene.background = null;
    r.render(this.scene, cam);
    for (const [m, v] of faces) m.visible = v;
    faces.length = 0;
    this.scene.background = bg;
    r.autoClear = autoClear;
  }

  private tickFades(now: number): boolean {
    if (!this.fading.length) return false;
    const DUR = 220;
    this.fading = this.fading.filter((f) => {
      const t = Math.min(1, (now - f.t0) / DUR);
      f.obj.setFaceStyle({ visible: true, opacity: 1 - t });
      f.obj.edgeLines.visible = t < 0.5;
      f.obj.silhouette.visible = false;
      if (t >= 1) {
        this.scene.remove(f.group);
        f.obj.dispose();
        return false;
      }
      return true;
    });
    return true;
  }

  renderNow() {
    const t0 = performance.now();
    this.needsRender = false;
    this.viewCube?.update(this.camera);
    this.syncHelpers();
    // mid-build the faces are moving: the AO pass would shade the finished shape
    const useAO = this.ao && this.aoEnabledByDepth && this.parts.size > 0 && !this.section && (this.build === null || this.build >= 1);
    const r = this.renderer, cam = this.camera;
    const layers = cam.layers.mask, autoClear = r.autoClear, bg = this.scene.background;
    const shake = this.build !== null && this.build < 1 ? this.buildShake(this.build) : null;
    if (shake) cam.position.add(shake), cam.updateMatrixWorld();
    try {
      // Paint the grid first, then depth-test axes and parts together over it.
      r.setRenderTarget(null);
      cam.layers.set(BACKGROUND_LAYER);
      r.render(this.scene, cam);
      cam.layers.mask = layers;
      r.autoClear = false;
      this.scene.background = null;
      if (useAO) this.renderShaded();
      else r.render(this.scene, cam);
    } finally {
      cam.layers.mask = layers;
      r.autoClear = autoClear;
      this.scene.background = bg;
      if (shake) cam.position.sub(shake), cam.updateMatrixWorld();
    }
    this.stats.frames++;
    this.stats.lastFrameMs = performance.now() - t0;
    this.emit("rendered", null);
  }

  /** Ground grid and origin triad visibility. */
  setHelpers(o: { grid?: boolean; origin?: boolean }) {
    if (o.grid !== undefined) this.showGrid = o.grid;
    if (o.origin !== undefined) this.showOrigin = o.origin;
    this.restoreHelpers();
    this.requestRender();
  }

  private restoreHelpers() {
    this.grid.visible = this.showGrid;
    this.triad.visible = this.showOrigin;
  }

  private updateGrid() {
    this.triad.clear();
    const b = this.bounds();
    const size = b.isEmpty() ? 100 : Math.max(b.max.x - b.min.x, b.max.y - b.min.y) * 1.6;
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(size, 1) / 8)));
    const t = this.theme;
    this.groundGrid.configure(step, 0, t.grid, t.gridMajor);
    // Origin axes share the parts' depth buffer without a bias. Unit length here;
    // syncHelpers scales them out to the far plane so they run to the horizon.
    const axis = (d: number[], c: string) => {
      const g = new LineGeometry();
      g.setPositions([0, 0, 0, ...d]);
      const m = new LineMaterial({ color: new THREE.Color(c), linewidth: 2, resolution: this.resolution, worldUnits: false, transparent: true, opacity: AXIS_OPACITY, depthTest: true, depthWrite: false });
      const l = new Line2(g, m);
      l.frustumCulled = false;
      return l;
    };
    for (const [d, c] of [[[1, 0, 0], t.axisX], [[0, 1, 0], t.axisY], [[0, 0, 1], t.axisZ]] as [number[], string][])
      this.triad.add(axis(d, c));
  }

  /** Keep the grid and axes reaching the horizon from wherever the camera is. */
  private syncHelpers() {
    const cam = this.camera;
    this.groundGrid.update(cam, this.controls.target);
    const reach = (cam as THREE.PerspectiveCamera).isPerspectiveCamera ? (cam as THREE.PerspectiveCamera).far : cam.position.distanceTo(this.controls.target) * 50 + 1e3;
    this.triad.scale.setScalar(reach);
    this.syncSectionArrow();
  }

  /** PNG of the current view (for note snapshots and renders). */
  async snapshot(type = "image/png", quality?: number): Promise<Blob> {
    this.renderNow();
    return await new Promise((res, rej) => this.canvas.toBlob((b) => (b ? res(b) : rej(new Error("snapshot failed"))), type, quality));
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.viewCube?.dispose();
    this.groundGrid.dispose();
    for (const p of this.parts.values()) p.dispose();
    this.pickTarget.dispose();
    this.facePickTarget.dispose();
    this.visTarget?.dispose();
    this.aoFull?.pass.dispose();
    this.aoFast?.pass.dispose();
    for (const b of [this.aoFull, this.aoFast]) b?.halo.dispose(), b?.haloScratch.dispose();
    this.haloPass?.dispose();
    this.envTex?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
