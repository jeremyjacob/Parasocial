// CAD navigation (§8 Viewport): orbit about the point under the cursor, zoom to cursor, pan,
// trackpad pinch/scroll, configurable presets. Z is up. Camera moves are
// animated (ease-out, interruptible) and never delay input.
import * as THREE from "three";

/** Mouse button mapping. Trackpad gestures are recognized under every preset. */
export type NavPreset = "onshape" | "solidworks" | "fusion";
/** What a two-finger scroll does on a trackpad (shift swaps to the other). */
export type TrackpadScroll = "orbit" | "pan";
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
/** Time constant (ms) of the extra friction on a trackpad orbit's momentum tail: smaller stops sooner. */
const COAST_TAU = 60;
const newCoast = () => ({ prev: 0, ratio: 0, dir: 0, run: 0, dx: 0, dy: 0, t: 0, since: null as number | null });

export class CadControls {
  target = new THREE.Vector3();
  preset: NavPreset = "onshape";
  trackpadScroll: TrackpadScroll = "orbit";
  enabled = true;
  reducedMotion = false;
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
    el.addEventListener("gesturestart", this.onGestureStart);
    el.addEventListener("gesturechange", this.onGestureChange);
    el.addEventListener("gestureend", this.onGestureEnd);
  }

  dispose() {
    this.el.removeEventListener("pointerdown", this.onDown);
    this.el.removeEventListener("wheel", this.onWheel);
    this.el.removeEventListener("contextmenu", this.onContext);
    this.el.removeEventListener("gesturestart", this.onGestureStart);
    this.el.removeEventListener("gesturechange", this.onGestureChange);
    this.el.removeEventListener("gestureend", this.onGestureEnd);
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

  /** Which gesture a pointer-down starts, per preset. Left-drag stays with the app (select / box). */
  private gestureFor(e: PointerEvent): Gesture {
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
    this.el.style.cursor = "";
    this.host.moving(false);
  };

  /**
   * Also take wheel and pinch input over `root`'s overlays (pins, pills, toolbars, the view cube),
   * so a gesture doesn't die, or pinch-zoom the page, because the cursor crossed a chip. Anything
   * that can itself scroll the way the fingers are going keeps its own scroll.
   */
  listenOn(root: HTMLElement): () => void {
    const fromOverlay = (e: Event) => e.target !== this.el && !e.defaultPrevented && e.target instanceof Element;
    const wheel = (e: WheelEvent) => {
      if (fromOverlay(e) && (e.ctrlKey || !scrollsItself(e.target as Element, root, e))) this.onWheel(e);
    };
    const gesture = (e: Event) => {
      if (!fromOverlay(e)) return;
      if (e.type === "gesturestart") this.onGestureStart(e);
      else if (e.type === "gesturechange") this.onGestureChange(e);
      else this.onGestureEnd(e);
    };
    root.addEventListener("wheel", wheel, { passive: false });
    for (const t of GESTURES) root.addEventListener(t, gesture);
    return () => {
      root.removeEventListener("wheel", wheel);
      for (const t of GESTURES) root.removeEventListener(t, gesture);
    };
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    // Safari reports its pinch as gesture events; ignore any wheel echo of it
    if (this.gestureScale !== null) return;
    this.stopAnim();
    const r = this.el.getBoundingClientRect();
    const x = e.clientX - r.left,
      y = e.clientY - r.top;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.el.clientHeight || 800 : 1;
    const dx = e.deltaX * unit,
      dy = e.deltaY * unit;
    const s = this.wheelStream(e, x, y);

    if (e.ctrlKey && s.trackpad) {
      // pinch: Chromium sends deltaY = −100·ln(scale), so this keeps the model under the fingers 1:1
      this.zoomAt(x, y, Math.exp(THREE.MathUtils.clamp(dy / 100, -0.5, 0.5)));
    } else if (s.trackpad && e.metaKey) {
      // ⌘-scroll zooms (Figma convention), for when a pinch is awkward
      this.zoomAt(x, y, Math.exp(THREE.MathUtils.clamp(dy * 0.005, -0.5, 0.5)));
    } else if (s.trackpad) {
      const mode = e.shiftKey ? (this.trackpadScroll === "orbit" ? "pan" : "orbit") : this.trackpadScroll;
      if (mode === "pan") {
        // natural scrolling: the content follows the fingers, the grabbed point stays under the cursor
        s.panDepth ??= this.depthAt(x, y);
        this.pan(-dx, -dy, s.panDepth);
      } else {
        const k = this.momentumDamping(dx, dy, e.timeStamp);
        // about the view's center at the model's depth, not the cursor: on a trackpad the cursor is
        // wherever it was left, not a point you grabbed (a mouse drag grabs one, so it pivots there)
        s.pivot ??= this.viewCenterPivot();
        if (k) this.orbit(-dx * k, -dy * k, s.pivot);
      }
    } else {
      // a notched wheel zooms: clamp each event so fast spins don't lurch, then accelerate gently
      // while the wheel keeps turning (consecutive events within ~90 ms ramp up to 2.2×)
      const raw = dy || dx;
      const now = performance.now();
      this.wheelStreak = now - this.lastWheel < 90 && Math.sign(raw) === this.wheelSign ? Math.min(this.wheelStreak + 1, 12) : 0;
      this.lastWheel = now;
      this.wheelSign = Math.sign(raw);
      const accel = 1 + this.wheelStreak * 0.1;
      this.zoomAt(x, y, Math.exp(THREE.MathUtils.clamp(raw, -100, 100) * 0.0019 * accel));
    }
    this.pulseMoving();
  };

  /**
   * The scroll stream this event belongs to: events keep arriving every frame while fingers are down
   * and through the momentum tail, so a gap (or the cursor moving) starts a new one. Per stream we
   * decide trackpad vs wheel once, and fix the orbit pivot / pan depth once (a pick stalls on the GPU).
   */
  private wheelStream(e: WheelEvent, x: number, y: number) {
    const now = performance.now();
    let s = this.stream;
    if (!s || now - s.t > 200 || Math.abs(x - s.x) + Math.abs(y - s.y) > 3 || s.ctrl !== e.ctrlKey) {
      s = this.stream = { t: now, x, y, ctrl: e.ctrlKey, trackpad: fromTrackpad(e), pivot: null, panDepth: null };
      this.coast = newCoast();
    }
    s.t = now;
    // a mouse wheel only scrolls sideways with shift held: a diagonal delta is a trackpad
    if (!s.trackpad && e.deltaMode === 0 && e.deltaX !== 0 && e.deltaY !== 0) s.trackpad = true;
    return s;
  }
  private stream: { t: number; x: number; y: number; ctrl: boolean; trackpad: boolean; pivot: THREE.Vector3 | null; panDepth: number | null } | null = null;

  /**
   * macOS keeps scrolling after the fingers lift (momentum). CAD orbit shouldn't coast far past the
   * view you stopped on, so momentum gets extra friction on top of macOS's own decay. Once a run
   * looks like momentum (shrinking by a steady ratio in a fixed direction) each event is weighted
   * exp(−t/COAST_TAU), t since the run was recognized: the weight starts at 1, so the release speed
   * carries on unbroken and then eases out faster than the OS would — a shorter native glide, not a
   * brake. It's timed, not counted, so 60 and 120 Hz feel the same. Fingers slowing on purpose
   * wobble in size and direction, which resets the run, so they keep control; a pickup (fingers
   * back on the pad: a pause, a reversal, or growing again) ends it. Browsers don't expose the
   * scroll phase, so this reads the delta envelope. Returns the weight to apply the event with.
   */
  private momentumDamping(dx: number, dy: number, t: number): number {
    const c = this.coast;
    const mag = Math.hypot(dx, dy);
    if (!mag) return 0;
    const dir = Math.atan2(dy, dx);
    if (c.prev) {
      const r = mag / c.prev;
      if (c.since !== null) {
        // confirmed: momentum arrives every frame, never grows and never reverses (it only
        // shrinks, or repeats a value through integer rounding); anything else is the fingers
        if (t - c.t > 60 || mag > c.prev + 1 || dx * c.dx < 0 || dy * c.dy < 0) (c.run = 0), (c.ratio = 0), (c.since = null);
      } else {
        // integer deltas make small vectors' directions coarse: only judge direction on bigger ones
        const turn = Math.abs(Math.atan2(Math.sin(dir - c.dir), Math.cos(dir - c.dir)));
        const straight = mag < 8 || turn < 0.08;
        if (r === 1 && straight) {
          // a repeated value (integer rounding) neither confirms nor breaks the run
        } else if (r < 1 && r > 0.6 && straight && (!c.ratio || Math.abs(r - c.ratio) < 0.08)) c.run++, (c.ratio = r);
        else (c.run = 0), (c.ratio = 0);
        if (c.run >= 2) c.since = t;
      }
    }
    c.prev = mag;
    c.dir = dir;
    c.dx = dx;
    c.dy = dy;
    c.t = t;
    return c.since === null ? 1 : Math.exp(-(t - c.since) / COAST_TAU);
  }
  private coast = newCoast();

  // Safari reports pinches as gesture events (scale since the gesture began), not ctrl+wheel
  private gestureScale: number | null = null;
  private onGestureStart = (e: any) => {
    e.preventDefault();
    if (!this.enabled) return;
    this.stopAnim();
    this.gestureScale = e.scale ?? 1;
  };
  private onGestureChange = (e: any) => {
    e.preventDefault();
    if (!this.enabled || this.gestureScale === null || !e.scale) return;
    const r = this.el.getBoundingClientRect();
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, this.gestureScale / e.scale);
    this.gestureScale = e.scale;
    this.pulseMoving();
  };
  private onGestureEnd = (e: any) => {
    e.preventDefault();
    this.gestureScale = null;
  };

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

const GESTURES = ["gesturestart", "gesturechange", "gestureend"];

/**
 * Whether a wheel event comes from a trackpad (or other precise device) rather than a notched wheel.
 * Chromium and WebKit derive the legacy wheelDelta from a precise delta as exactly −3×delta; a
 * notched wheel reports whole ticks (×120) against fractional or line deltas, so they don't match.
 */
function fromTrackpad(e: WheelEvent): boolean {
  if (e.deltaMode !== 0) return false;
  // a pinch arrives as ctrl+wheel with fractional or small deltas (ctrl+wheel on Windows steps by 100)
  if (e.ctrlKey && (!Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 10)) return true;
  const w = e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
  if (typeof w.wheelDeltaY === "number" && (e.deltaX || e.deltaY)) return w.wheelDeltaY === -3 * e.deltaY && w.wheelDeltaX === -3 * e.deltaX;
  // no legacy delta (Firefox): pinches and small pixel deltas are a trackpad
  return e.deltaX !== 0 || Math.abs(e.deltaY) < 50;
}

/** Whether something between `el` and `root` would scroll itself for this wheel event. */
function scrollsItself(el: Element, root: Element, e: WheelEvent): boolean {
  for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
    const st = getComputedStyle(n);
    const canY = /auto|scroll/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1;
    const canX = /auto|scroll/.test(st.overflowX) && n.scrollWidth > n.clientWidth + 1;
    if (canY && ((e.deltaY < 0 && n.scrollTop > 0) || (e.deltaY > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1))) return true;
    if (canX && ((e.deltaX < 0 && n.scrollLeft > 0) || (e.deltaX > 0 && n.scrollLeft + n.clientWidth < n.scrollWidth - 1))) return true;
    if (n instanceof HTMLTextAreaElement) return true;
  }
  return false;
}

export type CamState = { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; orthoHeight: number };
