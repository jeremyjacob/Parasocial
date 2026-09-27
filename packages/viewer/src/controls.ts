// CAD navigation (§8 Viewport): orbit about the point under the cursor, zoom to cursor, pan,
// trackpad pinch/scroll, Space-drag pan, configurable presets. Z is up. Camera moves are
// animated (ease-out, interruptible) and never delay input.
import * as THREE from "three";

export type NavPreset = "onshape" | "solidworks" | "fusion" | "trackpad";
type Gesture = "orbit" | "pan" | null;

export type ControlsHost = {
  camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera;
  /** World point under the screen position, if any geometry is there. */
  pickPoint(x: number, y: number): THREE.Vector3 | null;
  /** Center of the visible model, if any (orbit pivot depth when the cursor is over nothing). */
  sceneCenter?(): THREE.Vector3 | null;
  changed(): void;
  /** Called when navigation starts/stops (e.g. drop AO while moving). */
  moving(on: boolean): void;
};

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

export class CadControls {
  target = new THREE.Vector3();
  preset: NavPreset = "onshape";
  enabled = true;
  reducedMotion = false;
  /** Holding Space turns left-drag into pan (Figma convention). */
  spaceHeld = false;
  private gesture: Gesture = null;
  private last = new THREE.Vector2();
  private pivot = new THREE.Vector3();
  /** Depth (along the view axis) of the point grabbed when a pan starts; pan speed keeps it under the cursor. */
  private panDepth = 0;
  private anim: { from: CamState; to: CamState; t0: number; dur: number } | null = null;
  private movingTimer: any = null;
  /** for orthographic zoom */
  orthoHeight = 100;

  constructor(
    private el: HTMLElement,
    private host: ControlsHost,
  ) {
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("contextmenu", this.onContext);
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
  }

  dispose() {
    this.el.removeEventListener("pointerdown", this.onDown);
    this.el.removeEventListener("wheel", this.onWheel);
    this.el.removeEventListener("contextmenu", this.onContext);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
  }

  private suppressContext = false;
  private onContext = (e: MouseEvent) => {
    // a right-drag orbit shouldn't open the context menu
    if (this.suppressContext) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.suppressContext = false;
    }
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.code !== "Space") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    this.spaceHeld = e.type === "keydown";
    this.el.style.cursor = this.spaceHeld ? "grab" : "";
  };

  /** Which gesture a pointer-down starts, per preset. Left-drag stays with the app (select / box). */
  private gestureFor(e: PointerEvent): Gesture {
    if (e.button === 0 && this.spaceHeld) return "pan";
    if (e.button === 0 && e.altKey && !e.shiftKey) return "orbit";
    switch (this.preset) {
      case "onshape":
        if (e.button === 2) return e.ctrlKey || e.shiftKey ? "pan" : "orbit";
        if (e.button === 1) return "pan";
        return null;
      case "solidworks":
        if (e.button === 1) return e.ctrlKey ? "pan" : "orbit";
        if (e.button === 2 && e.ctrlKey) return "pan";
        return null;
      case "fusion":
        if (e.button === 1) return e.shiftKey ? "orbit" : "pan";
        return null;
      case "trackpad":
        if (e.button === 2) return "orbit";
        if (e.button === 1) return "pan";
        return null;
    }
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    const g = this.gestureFor(e);
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    this.stopAnim();
    this.gesture = g;
    this.startButtons = e.buttons;
    this.moved = 0;
    this.last.set(e.clientX, e.clientY);
    const r = this.el.getBoundingClientRect();
    if (g === "orbit") this.pivot.copy(this.host.pickPoint(e.clientX - r.left, e.clientY - r.top) ?? this.viewCenterPivot());
    else this.panDepth = this.depthAt(e.clientX - r.left, e.clientY - r.top);
    this.el.setPointerCapture(e.pointerId);
    this.el.addEventListener("pointermove", this.onMove);
    this.el.addEventListener("pointerup", this.onUp);
    this.el.addEventListener("pointercancel", this.onUp);
    if (g === "pan") this.el.style.cursor = "grabbing";
    this.host.moving(true);
  };

  /**
   * Over empty space, orbit about the screen center at the model's depth (Onshape-like): the point
   * on the view axis nearest the model center. Falls back to the target.
   */
  private viewCenterPivot(): THREE.Vector3 {
    const c = this.host.sceneCenter?.();
    if (!c) return this.target.clone();
    const cam = this.host.camera();
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const depth = c.clone().sub(cam.position).dot(fwd);
    if (depth <= 1e-6) return this.target.clone();
    return cam.position.clone().add(fwd.multiplyScalar(depth));
  }

  /**
   * View-axis depth of the surface under (x, y), else of the model center, else of the target.
   * Pan at this depth moves the grabbed point exactly with the cursor (Onshape-like).
   */
  private depthAt(x: number, y: number): number {
    const cam = this.host.camera();
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    for (const p of [this.host.pickPoint(x, y), this.host.sceneCenter?.()]) {
      const d = p ? p.clone().sub(cam.position).dot(fwd) : 0;
      if (d > 1e-6) return d;
    }
    return cam.position.distanceTo(this.target);
  }

  private moved = 0;
  private startButtons = 0;
  private onMove = (e: PointerEvent) => {
    // a chorded left press (arrives as a move with buttons changed) or a lost release ends the gesture
    if (this.gesture && (this.startButtons & ~e.buttons || (e.buttons & 1 && !(this.startButtons & 1)))) return this.onUp(e);
    const dx = e.clientX - this.last.x,
      dy = e.clientY - this.last.y;
    this.last.set(e.clientX, e.clientY);
    this.moved += Math.abs(dx) + Math.abs(dy);
    if (this.gesture === "orbit") this.orbit(dx, dy, this.pivot);
    else if (this.gesture === "pan") this.pan(dx, dy, this.panDepth);
  };

  private onUp = (e: PointerEvent) => {
    if (!this.gesture) return;
    if ((e.button === 2 || this.startButtons & 2) && this.moved > 3) this.suppressContext = true;
    this.gesture = null;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    this.el.removeEventListener("pointermove", this.onMove);
    this.el.removeEventListener("pointerup", this.onUp);
    this.el.removeEventListener("pointercancel", this.onUp);
    this.el.style.cursor = this.spaceHeld ? "grab" : "";
    this.host.moving(false);
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.stopAnim();
    const r = this.el.getBoundingClientRect();
    const x = e.clientX - r.left,
      y = e.clientY - r.top;
    const scale = e.deltaMode === 1 ? 16 : 1;
    const isPinch = e.ctrlKey; // trackpad pinch arrives as ctrl+wheel
    if (this.preset === "trackpad" && !isPinch) {
      const now = performance.now();
      if (e.shiftKey) this.pan(-e.deltaX * scale, -e.deltaY * scale, this.depthAt(x, y));
      else if (!this.isCoasting(Math.hypot(e.deltaX, e.deltaY) * scale, now)) this.orbit(-e.deltaX * scale * 0.6, -e.deltaY * scale * 0.6, this.target);
    } else {
      // clamp each event so momentum bursts don't lurch, then accelerate gently while the wheel
      // keeps turning (consecutive events within ~90 ms ramp up to 2.2×)
      const raw = e.deltaY * scale;
      const now = performance.now();
      this.wheelStreak = now - this.lastWheel < 90 && Math.sign(raw) === this.wheelSign ? Math.min(this.wheelStreak + 1, 12) : 0;
      this.lastWheel = now;
      this.wheelSign = Math.sign(raw);
      const accel = 1 + this.wheelStreak * 0.1;
      const d = isPinch ? THREE.MathUtils.clamp(raw * 0.012, -0.1, 0.1) : THREE.MathUtils.clamp(raw, -100, 100) * 0.0019 * accel;
      this.zoomAt(x, y, Math.exp(d));
    }
    this.pulseMoving();
  };

  /**
   * macOS keeps sending scroll events after the fingers lift (momentum). CAD orbit shouldn't
   * coast, so once a scroll stream decays smoothly for a few events, drop the rest of it until
   * the stream ends (a gap) or picks up again (fingers back on the pad). Browsers don't expose
   * the momentum phase, so this is a heuristic on the delta envelope.
   */
  private isCoasting(mag: number, now: number): boolean {
    const c = this.coast;
    if (now - c.t > 120) c.prev = Infinity, c.decays = 0, c.drop = false; // a new stream
    c.t = now;
    if (mag < c.prev * 0.97 && c.prev !== Infinity) c.decays++;
    else if (mag > c.prev * 1.03) c.decays = 0, c.drop = false;
    c.prev = mag;
    if (c.decays >= 4) c.drop = true;
    return c.drop;
  }
  private coast = { t: 0, prev: Infinity, decays: 0, drop: false };

  private lastWheel = 0;
  private wheelSign = 0;
  private wheelStreak = 0;

  private pulseMoving() {
    this.host.moving(true);
    clearTimeout(this.movingTimer);
    this.movingTimer = setTimeout(() => this.host.moving(false), 140);
  }

  orbit(dx: number, dy: number, pivot: THREE.Vector3) {
    const cam = this.host.camera();
    const speed = 0.0065;
    const up = new THREE.Vector3(0, 0, 1);
    // yaw around world Z, pitch around camera right
    const qYaw = new THREE.Quaternion().setFromAxisAngle(up, -dx * speed);
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    // keep pitch from flipping over the pole
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const pitch = -dy * speed;
    const cur = Math.asin(THREE.MathUtils.clamp(fwd.z, -1, 1));
    // rotating about camera-right by θ raises the view elevation by θ; clamp the elevation, not the step
    const next = THREE.MathUtils.clamp(cur + pitch, -Math.PI / 2 + 1e-4, Math.PI / 2 - 1e-4);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, next - cur);
    const q = qYaw.multiply(qPitch);
    for (const v of [cam.position, this.target]) v.sub(pivot).applyQuaternion(q).add(pivot);
    // rotate the orientation itself: lookAt with a Z up is degenerate looking straight up/down
    cam.quaternion.premultiply(q);
    cam.up.set(0, 0, 1);
    cam.updateMatrixWorld();
    this.host.changed();
  }

  /** Pan by screen pixels; in perspective, points at view-axis `depth` track the cursor exactly. */
  pan(dx: number, dy: number, depth = this.host.camera().position.distanceTo(this.target)) {
    const cam = this.host.camera();
    const h = this.el.clientHeight || 1;
    let worldPerPx: number;
    if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const p = cam as THREE.PerspectiveCamera;
      worldPerPx = (2 * depth * Math.tan(THREE.MathUtils.degToRad(p.fov / 2))) / h;
    } else worldPerPx = this.orthoHeight / h;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const upv = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const move = right.multiplyScalar(-dx * worldPerPx).add(upv.multiplyScalar(dy * worldPerPx));
    cam.position.add(move);
    this.target.add(move);
    cam.updateMatrixWorld();
    this.host.changed();
  }

  /** Zoom by `factor` (>1 = out) toward the point under (x, y). */
  zoomAt(x: number, y: number, factor: number) {
    const cam = this.host.camera();
    const hit = this.zoomFocus(x, y);
    const w = this.el.clientWidth,
      h = this.el.clientHeight;
    if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const focus = hit ?? this.rayPointAtTargetDepth(x, y, w, h);
      const dist = cam.position.distanceTo(focus);
      const k = THREE.MathUtils.clamp(dist * factor, 0.05, 1e6) / Math.max(dist, 1e-9);
      // scale the camera and the target about the focus by the same factor: the view direction is
      // unchanged and the camera→target distance follows the zoom, so everything that reads it
      // (pan speed, empty-space zoom, orbit about the target, ortho size) stays in step
      cam.position.sub(focus).multiplyScalar(k).add(focus);
      this.target.sub(focus).multiplyScalar(k).add(focus);
    } else {
      const before = this.screenToOrthoWorld(x, y, w, h);
      this.orthoHeight = THREE.MathUtils.clamp(this.orthoHeight * factor, 0.01, 1e6);
      this.host.changed();
      const after = this.screenToOrthoWorld(x, y, w, h);
      const d = before.sub(after);
      cam.position.add(d);
      this.target.add(d);
    }
    cam.updateMatrixWorld();
    this.host.changed();
  }

  /**
   * The point under the cursor for zooming, reused across a wheel burst (same pointer, events
   * <150 ms apart): a pick stalls on the GPU, and zooming about a point keeps the cursor ray fixed,
   * so the answer doesn't change until the pointer moves.
   */
  private zoomHit: { x: number; y: number; t: number; p: THREE.Vector3 | null } | null = null;
  private zoomFocus(x: number, y: number) {
    const now = performance.now(),
      z = this.zoomHit;
    if (z && z.x === x && z.y === y && now - z.t < 150) {
      z.t = now;
      return z.p?.clone() ?? null;
    }
    const p = this.host.pickPoint(x, y);
    this.zoomHit = { x, y, t: now, p: p?.clone() ?? null };
    return p;
  }

  private rayPointAtTargetDepth(x: number, y: number, w: number, h: number) {
    const cam = this.host.camera();
    const ndc = new THREE.Vector3((x / w) * 2 - 1, -(y / h) * 2 + 1, 0.5);
    const p = ndc.unproject(cam);
    const dir = p.sub(cam.position).normalize();
    const d = cam.position.distanceTo(this.target);
    return cam.position.clone().add(dir.multiplyScalar(d));
  }

  private screenToOrthoWorld(x: number, y: number, w: number, h: number) {
    const cam = this.host.camera();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const aspect = w / h;
    const sx = (x / w - 0.5) * this.orthoHeight * aspect;
    const sy = (0.5 - y / h) * this.orthoHeight;
    return cam.position.clone().add(right.multiplyScalar(sx)).add(up.multiplyScalar(sy));
  }

  // ---------- animated camera moves ----------

  state(): CamState {
    const cam = this.host.camera();
    return { position: cam.position.clone(), target: this.target.clone(), up: cam.up.clone(), orthoHeight: this.orthoHeight };
  }

  animateTo(to: CamState, dur = 220) {
    if (this.reducedMotion || dur <= 0) {
      this.apply(to);
      return;
    }
    this.anim = { from: this.state(), to, t0: performance.now(), dur };
    this.host.moving(true);
    this.host.changed();
  }

  /** Advance an animation; returns true while animating (the viewer keeps rendering). */
  tick(now: number): boolean {
    if (!this.anim) return false;
    const t = Math.min(1, (now - this.anim.t0) / this.anim.dur);
    const k = ease(t);
    const { from, to } = this.anim;
    const cam = this.host.camera();
    // interpolate around the target so rotations arc instead of cutting through the model
    const tgt = from.target.clone().lerp(to.target, k);
    const d0 = from.position.clone().sub(from.target),
      d1 = to.position.clone().sub(to.target);
    const q = new THREE.Quaternion().setFromUnitVectors(d0.clone().normalize(), d1.clone().normalize());
    const qk = new THREE.Quaternion().slerp(q, k);
    const len = THREE.MathUtils.lerp(d0.length(), d1.length(), k);
    const dir = d0.normalize().applyQuaternion(qk).multiplyScalar(len);
    cam.position.copy(tgt).add(dir);
    this.target.copy(tgt);
    cam.up.copy(from.up).lerp(to.up, k).normalize();
    this.orthoHeight = THREE.MathUtils.lerp(from.orthoHeight, to.orthoHeight, k);
    cam.lookAt(this.target);
    cam.updateMatrixWorld();
    if (t >= 1) {
      this.anim = null;
      this.host.moving(false);
    }
    return true;
  }

  stopAnim() {
    if (!this.anim) return;
    this.anim = null;
    // `up` is blended mid-animation, so the camera can be slightly rolled; orbit only rotates from
    // wherever it is, so level the horizon again (unless looking straight down/up, where Z-up is degenerate)
    const cam = this.host.camera();
    if (Math.abs(cam.getWorldDirection(new THREE.Vector3()).z) < 0.999) {
      cam.up.set(0, 0, 1);
      cam.lookAt(this.target);
      cam.updateMatrixWorld();
      this.host.changed();
    }
    this.host.moving(false);
  }

  apply(s: CamState) {
    const cam = this.host.camera();
    cam.position.copy(s.position);
    cam.up.copy(s.up);
    this.target.copy(s.target);
    this.orthoHeight = s.orthoHeight;
    cam.lookAt(this.target);
    cam.updateMatrixWorld();
    this.host.changed();
  }
}

export type CamState = { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; orthoHeight: number };
