// The 3D viewport (§8, §9): render on demand, GPU ID-buffer picking, preselect/selection
// overlays, display modes, views and fit. Framework-agnostic; geometry never enters app state.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { PartObject, decodeId, type EntityKind, type EntityRef, type PartData } from "./part";
import { CadControls, type NavPreset, type CamState } from "./controls";
import { ViewCube, VIEW_DIRS } from "./viewcube";
import { LIGHT, type ViewerTheme } from "./theme";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { withDepthBias } from "./depthbias";

export type MarkupStroke = { id: string; points: [number, number, number][]; color: string; width?: number; dim?: boolean };

export type DisplayMode = "shaded" | "shadedEdges" | "wireframe" | "hiddenLine";
export type SelectionFilter = { face: boolean; edge: boolean; vertex: boolean; part: boolean };
export type PickResult = EntityRef & { point?: THREE.Vector3 };

export type ViewerOptions = {
  theme?: ViewerTheme;
  nav?: NavPreset;
  viewCube?: boolean;
  /** device pixel ratio cap */
  maxDpr?: number;
  reducedMotion?: boolean;
  preserveDrawingBuffer?: boolean;
};

type Highlight = { refs: EntityRef[] };

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
  private pickTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true });
  private pickBuf = new Uint8Array(4 * 81);
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
  private markup = new THREE.Group();
  private ghosts = new Map<string, THREE.Group>();
  private blend = 0.5;
  private triad: THREE.Group;
  private envTex: THREE.Texture | null = null;
  filter: SelectionFilter = { face: true, edge: true, vertex: false, part: false };
  private listeners: { [k: string]: Set<(e: any) => void> } = {};
  private ro: ResizeObserver;
  private disposed = false;
  stats = { frames: 0, lastFrameMs: 0, lastPickMs: 0 };

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
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance", reversedDepthBuffer: reversed, logarithmicDepthBuffer: !reversed, preserveDrawingBuffer: o.preserveDrawingBuffer ?? false } as any);
    (this.renderer as any).__psReversed = reversed;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, o.maxDpr ?? 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    for (const cam of [this.persp, this.ortho]) cam.up.set(0, 0, 1);
    this.persp.position.set(120, -160, 110);
    this.ortho.position.copy(this.persp.position);

    // studio lighting: soft room environment + a key light
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(0.4, -0.6, 1);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a90, 0.35));
    // light follows the camera for consistent shading while orbiting
    this.persp.add(key);
    this.ortho.add(key.clone());
    this.scene.add(this.persp, this.ortho);

    this.grid = new THREE.Group();
    this.triad = new THREE.Group();
    this.scene.add(this.grid, this.triad, this.markup);
    this.markup.renderOrder = 4;

    this.controls = new CadControls(canvas, {
      camera: () => this.camera,
      pickPoint: (x, y) => this.pickPoint(x, y)?.point ?? null,
      changed: () => this.syncCameras(),
      moving: (on) => this.emit("moving", on),
    });
    this.controls.preset = o.nav ?? "onshape";
    this.controls.reducedMotion = o.reducedMotion ?? matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    if (o.viewCube !== false) {
      this.viewCube = new ViewCube(
        container,
        (dir) => this.setViewDir(dir),
        (dx, dy, phase) => {
          if (phase === "start") this.controls.stopAnim(), this.emit("moving", true);
          else if (phase === "end") this.emit("moving", false);
          else this.controls.orbit(dx, dy, this.controls.target);
        },
      );
      this.viewCube.el.style.top = "4px";
      this.viewCube.el.style.right = "8px";
    }

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.applyTheme();
    this.loop();
  }

  // ---------- events ----------
  on(ev: "moving" | "camera" | "rendered", fn: (e: any) => void) {
    (this.listeners[ev] ??= new Set()).add(fn);
    return () => this.listeners[ev].delete(fn);
  }
  private emit(ev: string, e: unknown) {
    this.listeners[ev]?.forEach((f) => f(e));
  }

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.useOrtho ? this.ortho : this.persp;
  }

  // ---------- parts ----------
  setPart(d: PartData) {
    const prev = this.parts.get(d.id);
    let slot = prev ? prev.slot : this.slots.indexOf(null);
    if (slot < 0) slot = this.slots.length;
    if (slot > 63) throw new Error("viewer supports up to 64 parts");
    this.slots[slot] = d.id;
    if (prev) {
      this.scene.remove(prev.group);
      prev.dispose();
    }
    const p = new PartObject(d, slot, this.resolution);
    this.parts.set(d.id, p);
    this.colors.set(d.id, new THREE.Color(d.color));
    if (d.dim) this.dimmed.add(d.id);
    else this.dimmed.delete(d.id);
    p.group.visible = !this.hidden.has(d.id);
    this.scene.add(p.group);
    // drop highlights that no longer exist
    const valid = (r: EntityRef) => r.part !== d.id || this.exists(r);
    this.selection.refs = this.selection.refs.filter(valid);
    if (this.preselect && !valid(this.preselect)) this.preselect = null;
    this.errors = this.errors.filter(valid);
    this.restyle(d.id);
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
    this.requestRender();
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
    this.requestRender();
  }

  /** Show only these parts (empty = show all). */
  isolate(ids: string[]) {
    for (const [id, p] of this.parts) p.group.visible = (!ids.length || ids.includes(id)) && !this.hidden.has(id);
    this.requestRender();
  }

  private exists(r: EntityRef) {
    const p = this.parts.get(r.part);
    if (!p) return false;
    const n = r.kind === "face" ? p.data.mesh.faceRanges.length / 2 : r.kind === "edge" ? p.data.mesh.edgeRanges.length / 2 : 0;
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
    const partSelected = this.selection.refs.some((r) => r.part === id && (r.kind as string) === "part");
    for (const r of this.errors) if (r.part === id) r.kind === "face" ? (tints.set(r.index, { color: err, amount: 0.55 }), errEdges.push(...(p.data.faceEdges[r.index] ?? []))) : r.kind === "edge" && errEdges.push(r.index);
    for (const r of this.selection.refs)
      if (r.part === id) {
        if (r.kind === "face") {
          tints.set(r.index, { color: selFill, amount: 0.42 });
          selEdges.push(...(p.data.faceEdges[r.index] ?? []));
        } else if (r.kind === "edge") selEdges.push(r.index);
      }
    if (partSelected) for (let f = 0; f < p.data.mesh.faceRanges.length / 2; f++) tints.set(f, { color: selFill, amount: 0.22 });
    if (this.preselect?.part === id) {
      if (this.preselect.kind === "face") preEdges.push(...(p.data.faceEdges[this.preselect.index] ?? []));
      else if (this.preselect.kind === "edge") preEdges.push(this.preselect.index);
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
    p.overlay.userData.active = stroke.some((s) => s.edges.length);
    this.applyMode(p);
  }

  // ---------- display ----------
  setDisplayMode(m: DisplayMode) {
    this.mode = m;
    for (const id of this.parts.keys()) this.restyle(id);
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
        p.setEdgeStyle(edge, 1.25);
        break;
      case "hiddenLine":
        p.setFaceStyle({ visible: true, flat: new THREE.Color(t.hiddenLineFill) });
        p.edgeLines.visible = true;
        p.setEdgeStyle(edge, 1.25);
        break;
    }
    p.faceMesh.userData.shown = p.faceMesh.visible;
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
    this.scene.environmentIntensity = t.dark ? 0.7 : 0.85;
    this.container.style.setProperty("--vc-face", t.dark ? "rgba(39,39,42,.92)" : "rgba(255,255,255,.94)");
    this.container.style.setProperty("--vc-face-hover", t.dark ? "#3f3f46" : "#ffffff");
    this.container.style.setProperty("--vc-border", t.dark ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.12)");
    this.container.style.setProperty("--vc-fg", t.dark ? "#a1a1aa" : "#71717a");
    this.container.style.setProperty("--vc-fg-hover", t.dark ? "#fafafa" : "#18181b");
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
    if (ortho) {
      const d = from.position.distanceTo(this.controls.target);
      this.controls.orthoHeight = 2 * d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    }
    this.syncCameras();
  }
  isOrtho() {
    return this.useOrtho;
  }

  setNavPreset(p: NavPreset) {
    this.controls.preset = p;
  }

  // ---------- views ----------
  /** Model bounds of visible parts. */
  bounds(parts?: string[]): THREE.Box3 {
    const box = new THREE.Box3();
    for (const [id, p] of this.parts) {
      if (parts && !parts.includes(id)) continue;
      if (!p.group.visible) continue;
      const b = p.faceMesh.geometry.boundingBox;
      if (b) box.union(b);
    }
    return box;
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

  fitSelection(animate = true) {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const r of this.selection.refs) {
      const p = this.parts.get(r.part);
      if (!p) continue;
      if (r.kind === "face") {
        const lo = p.faceVerts[r.index * 2],
          cnt = p.faceVerts[r.index * 2 + 1];
        for (let i = lo; i < lo + cnt; i++) box.expandByPoint(v.fromArray(p.data.mesh.positions, i * 3));
      } else if (r.kind === "edge") {
        const s = p.data.mesh.edgeRanges[r.index * 2],
          c = p.data.mesh.edgeRanges[r.index * 2 + 1];
        for (let i = s; i < s + c; i++) box.expandByPoint(v.fromArray(p.data.mesh.edgePositions, i * 3));
      } else if (p.faceMesh.geometry.boundingBox) box.union(p.faceMesh.geometry.boundingBox);
    }
    if (!box.isEmpty()) this.fit(box, animate);
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

  // ---------- markup (pencil strokes) ----------
  /** Replace the drawn markup strokes (world coordinates). */
  setMarkup(strokes: MarkupStroke[]) {
    for (const c of this.markup.children) {
      (c as Line2).geometry.dispose();
      ((c as Line2).material as LineMaterial).dispose();
    }
    this.markup.clear();
    for (const s of strokes) {
      if (s.points.length < 2) continue;
      const g = new LineGeometry();
      g.setPositions(s.points.flat());
      const m = withDepthBias(new LineMaterial({ color: new THREE.Color(s.color), linewidth: s.width ?? 3, resolution: this.resolution, worldUnits: false, transparent: true, opacity: s.dim ? 0.35 : 0.95, depthTest: true }), 0.001) as LineMaterial;
      const l = new Line2(g, m);
      l.computeLineDistances();
      l.renderOrder = 4;
      l.userData.id = s.id;
      this.markup.add(l);
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
    const R = 4; // 9x9 window
    const size = R * 2 + 1;
    if (this.pickTarget.width !== size) this.pickTarget.setSize(size, size);
    const px = Math.round(x * dpr),
      py = Math.round(y * dpr);
    cam.setViewOffset(W, H, px - R, py - R, size, size);
    for (const p of this.parts.values()) p.pickMode(true, this.filter.edge && this.mode !== "shaded", this.filter.face || this.filter.part);
    const bg = this.scene.background;
    this.scene.background = null;
    const env = this.scene.environment;
    this.scene.environment = null;
    this.grid.visible = this.triad.visible = false;
    const prevTM = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    // edges on top of faces within their pixel footprint: draw faces, then edges with depth test
    this.renderer.render(this.scene, cam);
    this.renderer.setRenderTarget(null);
    this.renderer.toneMapping = prevTM;
    this.scene.background = bg;
    this.scene.environment = env;
    this.grid.visible = this.triad.visible = true;
    for (const p of this.parts.values()) p.pickMode(false, false, false);
    cam.clearViewOffset();
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, size, size, this.pickBuf);
    // an edge within ~3.5 px wins (edges are thin); else whatever is under the cursor
    let center: ReturnType<typeof decodeId> = null;
    let bestEdge: { d: number; id: NonNullable<ReturnType<typeof decodeId>> } | null = null;
    let bestAny: { d: number; id: NonNullable<ReturnType<typeof decodeId>> } | null = null;
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const o = (j * size + i) * 4;
        const id = decodeId(this.pickBuf[o], this.pickBuf[o + 1], this.pickBuf[o + 2], this.pickBuf[o + 3]);
        if (!id) continue;
        const d = (i - R) ** 2 + (j - R) ** 2;
        if (d === 0) center = id;
        if (id.kind === "edge" && d <= 12 && (!bestEdge || d < bestEdge.d)) bestEdge = { d, id };
        if (!bestAny || d < bestAny.d) bestAny = { d, id };
      }
    const best = { id: bestEdge?.id ?? center ?? (bestAny && bestAny.d <= 4 ? bestAny.id : null) };
    this.stats.lastPickMs = performance.now() - t0;
    if (!best?.id) return null;
    const part = this.slots[best.id.slot];
    if (!part) return null;
    if (this.filter.part && !this.filter.face && !this.filter.edge) return { part, kind: "part" as any, index: 0 };
    if (best.id.kind === "face" && !this.filter.face) return this.filter.part ? { part, kind: "part" as any, index: 0 } : null;
    return { part, kind: best.id.kind, index: best.id.index };
  }

  /** Pick plus the exact surface point and normal (ray vs. the picked face's triangles). */
  pickPoint(x: number, y: number): (EntityRef & { point: THREE.Vector3; normal?: THREE.Vector3 }) | null {
    const saved = this.filter;
    this.filter = { face: true, edge: false, vertex: false, part: false };
    const ref = this.pick(x, y);
    this.filter = saved;
    if (!ref || ref.kind !== "face") return null;
    const p = this.parts.get(ref.part)!;
    const ray = this.rayAt(x, y);
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
      // grazing hit: fall back to the face center
      best = p.faceCenter(ref.index, new THREE.Vector3());
    }
    return { ...ref, point: best, normal: bn };
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
    const scale = Math.max(1, this.bounds().getBoundingSphere(new THREE.Sphere()).radius);
    return dp <= dh + tolerance * scale;
  }

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
    if (r.kind === "face") return p.faceCenter(r.index, new THREE.Vector3());
    if (r.kind === "edge") {
      const m = p.data.mesh;
      const s = m.edgeRanges[r.index * 2],
        c = m.edgeRanges[r.index * 2 + 1];
      const mid = s + Math.floor(c / 2);
      return new THREE.Vector3().fromArray(m.edgePositions, mid * 3);
    }
    return p.faceMesh.geometry.boundingSphere?.center.clone() ?? null;
  }

  // ---------- frame loop ----------
  requestRender() {
    this.needsRender = true;
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
    const b = this.bounds();
    if (!b.isEmpty()) {
      const s = b.getBoundingSphere(new THREE.Sphere());
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
    this.syncCameras();
    this.renderNow();
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const animating = this.controls.tick(performance.now());
    if (animating) this.syncCameras();
    if (this.needsRender || animating) this.renderNow();
  };

  renderNow() {
    const t0 = performance.now();
    this.needsRender = false;
    this.viewCube?.update(this.camera);
    this.renderer.render(this.scene, this.camera);
    this.stats.frames++;
    this.stats.lastFrameMs = performance.now() - t0;
    this.emit("rendered", null);
  }

  private updateGrid() {
    this.grid.clear();
    this.triad.clear();
    const b = this.bounds();
    const size = b.isEmpty() ? 100 : Math.max(b.max.x - b.min.x, b.max.y - b.min.y) * 1.6;
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(size, 1) / 8)));
    const half = Math.ceil(size / 2 / (step * 10)) * step * 10;
    const t = this.theme;
    const pts: number[] = [],
      major: number[] = [];
    for (let v = -half; v <= half + 1e-9; v += step) {
      const arr = Math.abs(Math.round(v / step) % 10) === 0 ? major : pts;
      arr.push(-half, v, 0, half, v, 0, v, -half, 0, v, half, 0);
    }
    const mk = (arr: number[], color: string, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      const l = new THREE.LineSegments(g, m);
      l.renderOrder = -1;
      return l;
    };
    const z = b.isEmpty() ? 0 : Math.min(0, b.min.z);
    const g1 = mk(pts, t.grid, 0.9),
      g2 = mk(major, t.gridMajor, 1);
    g1.position.z = g2.position.z = z - 1e-3 * half;
    this.grid.add(g1, g2);
    const L = step * 2;
    const axis = (x: number, y: number, zz: number, c: string) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, x * L, y * L, zz * L], 3));
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.9 }));
    };
    this.triad.add(axis(1, 0, 0, t.axisX), axis(0, 1, 0, t.axisY), axis(0, 0, 1, t.axisZ));
    this.triad.renderOrder = 3;
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
    for (const p of this.parts.values()) p.dispose();
    this.pickTarget.dispose();
    this.envTex?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
