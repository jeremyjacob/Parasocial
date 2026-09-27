// View cube: a crisp CSS 3D cube synced to the camera, in the style of Onshape's.
// Six rounded, semi-transparent face panels plus eight round corner targets are each their own
// hit region: left-click one to go to that view (face = axis, corner = normalized sum of its
// three face normals). Right-drag orbits. A small XYZ triad sits on the origin corner.
// DOM-only, so it's sharp at any DPR and costs nothing to render.
import * as THREE from "three";

export type ViewName = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";

/** Direction from target to camera for each view (Z up). */
export const VIEW_DIRS: Record<string, THREE.Vector3> = {
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  right: new THREE.Vector3(1, 0, 0),
  left: new THREE.Vector3(-1, 0, 0),
  top: new THREE.Vector3(0, 0, 1),
  bottom: new THREE.Vector3(0, 0, -1),
  iso: new THREE.Vector3(1, -1, 1).normalize(),
};

const LABELS: Record<string, string> = {
  front: "Front",
  back: "Back",
  right: "Right",
  left: "Left",
  top: "Top",
  bottom: "Bottom",
};

/** Face frames in world space: [u = label right, v = label up]; u × v = outward normal. */
const FRAMES: Record<string, [THREE.Vector3, THREE.Vector3]> = {
  front: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
  back: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1)],
  right: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
  left: [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1)],
  top: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
  bottom: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0)],
};

// Geometry (px). The farthest thing from the center is a corner target: its center sits
// √3·(HALF − CORNER_INSET) ≈ 44px out and it's CORNER/2 wide, so ≈ 51px. The container is
// BOX = 112px (56px half-extent), so every orientation stays in bounds.
const SIZE = 58;
const HALF = SIZE / 2;
const BOX = 112;
/** Face panels stop just short of the edges so the rounded tiles read as separate targets. */
const GAP = 0.25;
const PANEL = SIZE - 2 * GAP;
/** Corner targets: diameter, and how far their centers are pulled in from the true corner. */
const CORNER = 13;
const CORNER_INSET = 3.5;
/** Triad axis length from the origin corner, and label offset past the tip. */
const AXIS = 26;
const AXIS_LABEL = 6;
/** Perspective distance, and how far the cube is pushed back so the nearest point sits at z≈0
 *  (perspective then only ever shrinks, never magnifies past the container). */
const PERSPECTIVE = 900;
const DEPTH = Math.ceil(HALF * Math.sqrt(3));
/** Right-drag orbit gain: the cube is small, so a pixel on it should turn the view further
 *  than a pixel on the canvas does. */
const DRAG_GAIN = 2.5;

type Piece = { el: HTMLElement; n: THREE.Vector3 };
type Corner = { el: HTMLElement; p: THREE.Vector3; n: THREE.Vector3 };

export class ViewCube {
  readonly el: HTMLDivElement;
  private cube: HTMLDivElement;
  private overlay: HTMLDivElement;
  private pieces: Piece[] = [];
  private corners: Corner[] = [];
  private labels: { el: HTMLElement; p: THREE.Vector3 }[] = [];
  private rot = new THREE.Matrix4();
  private tmp = new THREE.Vector3();
  constructor(
    parent: HTMLElement,
    private onPick: (dir: THREE.Vector3, up?: THREE.Vector3) => void,
    private onDrag?: (dx: number, dy: number, phase: "start" | "move" | "end") => void,
  ) {
    const el = document.createElement("div");
    el.className = "ps-viewcube";
    el.innerHTML = `<div class="ps-viewcube-scene"><div class="ps-viewcube-cube"></div></div><div class="ps-viewcube-corners"></div>`;
    parent.appendChild(el);
    this.el = el;
    this.cube = el.querySelector(".ps-viewcube-cube")!;
    this.overlay = el.querySelector(".ps-viewcube-corners")!;
    this.build();

    // right-drag orbits; left-click picks a view
    let drag: { x: number; y: number; moved: boolean; id: number } | null = null;
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 2) return;
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
      el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      if (!dx && !dy) return;
      if (!drag.moved) {
        drag.moved = true;
        el.classList.add("dragging");
        this.onDrag?.(0, 0, "start");
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
      this.onDrag?.(dx * DRAG_GAIN, dy * DRAG_GAIN, "move");
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) {
        el.classList.remove("dragging");
        this.onDrag?.(0, 0, "end");
      }
      drag = null;
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      const t = (e.target as HTMLElement).closest("[data-dir]") as HTMLElement | null;
      if (!t) return;
      const d = t.dataset.dir!.split(",").map(Number);
      this.onPick(new THREE.Vector3(d[0], d[1], d[2]).normalize());
    });
    injectStyles();
  }

  private build() {
    const dir = (v: THREE.Vector3) => `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;

    // faces: rounded tiles on the cube's six planes; back faces are culled
    for (const name of Object.keys(FRAMES)) {
      const [u, v] = FRAMES[name];
      const n = VIEW_DIRS[name];
      const c = n.clone().multiplyScalar(HALF);
      const t = document.createElement("template");
      t.innerHTML = `<div class="ps-vc-face" data-dir="${dir(n)}" role="button" aria-label="${LABELS[name]} view" style="width:${PANEL}px;height:${PANEL}px;transform:${place(c, u, v, PANEL, PANEL)}"><span>${LABELS[name]}</span></div>`;
      const node = t.content.firstElementChild as HTMLElement;
      this.cube.appendChild(node);
      this.pieces.push({ el: node, n: n.clone() });
    }

    // corners: round targets in a flat overlay, positioned by projecting each corner in update().
    // Kept out of the 3D scene so they never slice into the face tiles and always read round.
    for (const sx of [1, -1])
      for (const sy of [1, -1])
        for (const sz of [1, -1]) {
          const s = new THREE.Vector3(sx, sy, sz);
          const node = document.createElement("div");
          node.className = "ps-vc-corner";
          node.dataset.dir = dir(s);
          node.setAttribute("role", "button");
          node.setAttribute("aria-label", "Corner view");
          this.overlay.appendChild(node);
          this.corners.push({ el: node, p: s.clone().multiplyScalar(HALF - CORNER_INSET), n: s.clone().normalize() });
        }

    // triad: X/Y/Z from the origin corner (min x, y, z), along the cube's edges
    const axes = [0, 1, 2].map((i) => new THREE.Vector3().setComponent(i, 1));
    const o = new THREE.Vector3(-HALF, -HALF, -HALF);
    const names = ["x", "y", "z"];
    for (let i = 0; i < 3; i++) {
      const a = axes[i];
      // two perpendicular strips form a "+" cross-section, so the line reads from any angle
      const others = axes.filter((_, j) => j !== i);
      for (const w of others) {
        const c = o.clone().addScaledVector(a, AXIS / 2);
        const node = document.createElement("i");
        node.className = `ps-vc-axis ps-vc-${names[i]}`;
        node.style.width = `${AXIS}px`;
        node.style.transform = place(c, a.clone(), w.clone(), AXIS, 1.5);
        this.cube.appendChild(node);
      }
      const lab = document.createElement("b");
      lab.className = `ps-vc-alabel ps-vc-${names[i]}`;
      lab.textContent = names[i].toUpperCase();
      this.cube.appendChild(lab);
      this.labels.push({ el: lab, p: o.clone().addScaledVector(a, AXIS + AXIS_LABEL) });
    }
  }

  /** Sync with the camera orientation. */
  update(camera: THREE.Camera) {
    // CSS space: x right, y down, z toward viewer. Rotate the cube by the inverse camera rotation.
    const m = this.rot.extractRotation(camera.matrixWorldInverse);
    const e = m.elements;
    // CSS = F·R·W with F = W = diag(1,-1,1) (CSS y points down): negate entries where exactly
    // one of row/column is y, so the result stays a rotation (no mirroring)
    const css = [e[0], -e[1], e[2], 0, -e[4], e[5], -e[6], 0, e[8], -e[9], e[10], 0, 0, 0, 0, 1];
    this.cube.style.transform = `translateZ(-${DEPTH}px) matrix3d(${css.map(fmt).join(",")})`;
    // inverse rotation (transpose) so the axis letters always face the viewer
    const inv = [css[0], css[4], css[8], 0, css[1], css[5], css[9], 0, css[2], css[6], css[10], 0, 0, 0, 0, 1];
    const invStr = `matrix3d(${inv.map(fmt).join(",")})`;
    for (const l of this.labels)
      l.el.style.transform = `translate3d(${fmt(l.p.x)}px,${fmt(-l.p.y)}px,${fmt(l.p.z)}px) ${invStr} translate(-50%,-50%)`;
    // simple key light from the upper left, in camera space, for a soft shaded read
    for (const p of this.pieces) {
      const n = this.tmp.copy(p.n).transformDirection(m);
      const ndl = Math.max(0, n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z);
      p.el.style.setProperty("--vc-shade", fmt(1 - ndl));
    }
    // corners: project with the same perspective as the scene; show only those on the near
    // side or the silhouette, fading out as they turn away, nearest on top
    for (const c of this.corners) {
      const nz = this.tmp.copy(c.n).transformDirection(m).z;
      const q = this.tmp.copy(c.p).applyMatrix4(m);
      const k = PERSPECTIVE / (PERSPECTIVE - (q.z - DEPTH));
      const vis = THREE.MathUtils.clamp((nz + 0.45) / 0.2, 0, 1);
      const s = c.el.style;
      s.transform = `translate(${fmt(q.x * k)}px,${fmt(-q.y * k)}px) translate(-50%,-50%) scale(${fmt(k)})`;
      s.opacity = fmt(vis);
      s.visibility = vis > 0.05 ? "" : "hidden";
      s.zIndex = String(Math.round(100 + q.z));
      s.setProperty("--vc-shade", fmt(1 - Math.max(0, nz)));
    }
  }

  dispose() {
    this.el.remove();
  }
}

const LIGHT = new THREE.Vector3(-0.35, 0.45, 1).normalize();

const fmt = (x: number) => String(+x.toFixed(5));

/**
 * CSS transform placing a w×h element (transform-origin 0 0) centered at world point `c`,
 * with local +x along world `u` and local "up" along world `v` (u × v = outward normal).
 */
function place(c: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, w: number, h: number): string {
  // world -> cube CSS is diag(1, -1, 1); element y (down) is world -v. The reflection flips the
  // cross product, so CSS x × y = +z stays the outward normal and backface culling works.
  const f = (a: THREE.Vector3) => [a.x, -a.y, a.z];
  const n = u.clone().cross(v);
  const o = c.clone().addScaledVector(u, -w / 2).addScaledVector(v, h / 2);
  const cols = [...f(u), 0, ...f(v.clone().negate()), 0, ...f(n), 0, ...f(o), 1];
  return `matrix3d(${cols.map(fmt).join(",")})`;
}

let injected = false;
function injectStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const st = document.createElement("style");
  st.textContent = `
.ps-viewcube{position:absolute;width:${BOX}px;height:${BOX}px;user-select:none;-webkit-user-select:none;touch-action:none;cursor:default;
  --vc-acc:var(--vc-accent,#2f7bf6);
  /* the themed face color, thinned so the model behind reads through */
  --vc-glass:color-mix(in srgb,var(--vc-face,rgba(255,255,255,.94)) 80%,transparent);
  --vc-glass-hover:color-mix(in srgb,color-mix(in srgb,var(--vc-acc) 24%,var(--vc-face-hover,#fff)) 88%,transparent)}
.ps-viewcube-scene{position:absolute;inset:0;perspective:${PERSPECTIVE}px;perspective-origin:50% 50%}
.ps-viewcube-cube{position:absolute;left:50%;top:50%;width:0;height:0;transform-style:preserve-3d}
.ps-vc-face{position:absolute;left:0;top:0;box-sizing:border-box;transform-origin:0 0;backface-visibility:hidden;-webkit-backface-visibility:hidden;
  display:grid;place-items:center;border-radius:10px;background:var(--vc-glass);
  box-shadow:inset 0 0 0 1px var(--vc-border,rgba(0,0,0,.12));
  font:550 10px/1 var(--font-sans,system-ui,sans-serif);letter-spacing:.01em;color:var(--vc-fg,#71717a);transition:color .1s ease-out,background-color .1s ease-out}
.ps-vc-face::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:#000;opacity:calc(var(--vc-shade,0) * .12)}
.ps-vc-face span{pointer-events:none;position:relative;z-index:1}
.ps-vc-face:hover{background:var(--vc-glass-hover);color:var(--vc-fg-hover,#18181b);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--vc-acc) 60%,transparent)}
.ps-viewcube-corners{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none}
.ps-vc-corner{position:absolute;left:0;top:0;width:${CORNER}px;height:${CORNER}px;box-sizing:border-box;border-radius:50%;pointer-events:auto;
  background:color-mix(in srgb,var(--vc-face,rgba(255,255,255,.94)) 92%,transparent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--vc-fg,#71717a) 45%,transparent),0 .5px 1.5px rgba(0,0,0,.18);transition:background-color .1s ease-out}
.ps-vc-corner::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:#000;opacity:calc(.04 + var(--vc-shade,0) * .1)}
.ps-vc-corner:hover{background:color-mix(in srgb,var(--vc-acc) 55%,var(--vc-face-hover,#fff));box-shadow:inset 0 0 0 1px var(--vc-acc),0 .5px 2px rgba(0,0,0,.25)}
.ps-vc-axis{position:absolute;left:0;top:0;height:1.5px;transform-origin:0 0;border-radius:1px;pointer-events:none;background:currentColor}
.ps-vc-alabel{position:absolute;left:0;top:0;pointer-events:none;font:650 8px/1 var(--font-sans,system-ui,sans-serif);transform-origin:0 0}
.ps-vc-x{color:#e5484d}.ps-vc-y{color:#30a46c}.ps-vc-z{color:#3e7bf6}
@media (prefers-reduced-motion: reduce){.ps-vc-face,.ps-vc-corner{transition:none}}
`;
  document.head.appendChild(st);
}
