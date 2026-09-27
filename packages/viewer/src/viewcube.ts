// View cube: a crisp CSS 3D chamfered cube synced to the camera, in the style of Onshape's.
// Six face panels, twelve bevelled edge strips and eight corner triangles are each their own
// hit region: left-click one to go to that view (face = axis, edge = sum of two face normals,
// corner = sum of three). Right-drag orbits. A small XYZ triad sits on the origin corner.
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

// Geometry (px). The container is 100px; the farthest thing from the center is the triad
// origin at the virtual cube corner, √3·HALF ≈ 43px, so every orientation stays in bounds.
const SIZE = 50;
const HALF = SIZE / 2;
/** Chamfer: how far the bevel cuts into each face from the edge. */
const BEVEL = 7;
const PANEL = SIZE - 2 * BEVEL;
/** Triad axis length from the origin corner, and label offset past the tip. */
const AXIS = 24;
const AXIS_LABEL = 6;
/** Pull the cube back so perspective never magnifies it past the container. */
const DEPTH = 48;

type Piece = { el: HTMLElement; n: THREE.Vector3 };

export class ViewCube {
  readonly el: HTMLDivElement;
  private cube: HTMLDivElement;
  private pieces: Piece[] = [];
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
    el.innerHTML = `<div class="ps-viewcube-scene"><div class="ps-viewcube-cube"></div></div>`;
    parent.appendChild(el);
    this.el = el;
    this.cube = el.querySelector(".ps-viewcube-cube")!;
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
      this.onDrag?.(dx, dy, "move");
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
    const add = (html: string, n: THREE.Vector3) => {
      const t = document.createElement("template");
      t.innerHTML = html;
      const node = t.content.firstElementChild as HTMLElement;
      this.cube.appendChild(node);
      this.pieces.push({ el: node, n: n.clone().normalize() });
    };
    const dir = (v: THREE.Vector3) => `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;

    // faces
    for (const name of Object.keys(FRAMES)) {
      const [u, v] = FRAMES[name];
      const n = VIEW_DIRS[name];
      const c = n.clone().multiplyScalar(HALF);
      add(
        `<div class="ps-vc-piece ps-vc-face" data-dir="${dir(n)}" role="button" aria-label="${LABELS[name]} view" style="width:${PANEL}px;height:${PANEL}px;transform:${place(c, u, v, PANEL, PANEL)}"><span>${LABELS[name]}</span></div>`,
        n,
      );
    }

    const axes = [0, 1, 2].map((i) => new THREE.Vector3().setComponent(i, 1));
    // edges: one per pair of perpendicular face normals
    const len = PANEL + 1; // overlap panels slightly so seams don't show through
    const wid = BEVEL * Math.SQRT2 + 1;
    for (let a = 0; a < 3; a++)
      for (let b = a + 1; b < 3; b++)
        for (const sa of [1, -1])
          for (const sb of [1, -1]) {
            const n1 = axes[a].clone().multiplyScalar(sa),
              n2 = axes[b].clone().multiplyScalar(sb);
            const sum = n1.clone().add(n2);
            const n = sum.clone().normalize();
            const c = sum.clone().multiplyScalar(HALF - BEVEL / 2);
            const u = n1.clone().cross(n2).normalize();
            const v = n.clone().cross(u);
            add(
              `<div class="ps-vc-piece ps-vc-edge" data-dir="${dir(sum)}" role="button" aria-label="Edge view" style="width:${len}px;height:${wid}px;transform:${place(c, u, v, len, wid)}"></div>`,
              n,
            );
          }

    // corners: equilateral triangles cutting off each cube corner
    const side = BEVEL * Math.SQRT2;
    const tri = (side * Math.sqrt(3)) / 2;
    for (const sx of [1, -1])
      for (const sy of [1, -1])
        for (const sz of [1, -1]) {
          const s = new THREE.Vector3(sx, sy, sz);
          const n = s.clone().normalize();
          // triangle vertices: pull the corner in along one axis at a time
          const vs = [0, 1, 2].map((i) => {
            const p = s.clone().multiplyScalar(HALF - BEVEL);
            return p.setComponent(i, s.getComponent(i) * HALF);
          });
          // base from vs[1] to vs[2], apex vs[0]; orient so the apex is "up" and u × v = n
          let [apex, b0, b1] = vs;
          let u = b1.clone().sub(b0).normalize();
          let v = n.clone().cross(u);
          if (apex.clone().sub(b0).dot(v) < 0) {
            [b0, b1] = [b1, b0];
            u.negate();
            v = n.clone().cross(u);
          }
          const c = b0.clone().add(b1).multiplyScalar(0.5).addScaledVector(v, tri / 2);
          const pad = 0.6; // grow a touch to cover seams
          add(
            `<div class="ps-vc-piece ps-vc-corner" data-dir="${dir(s)}" role="button" aria-label="Corner view" style="width:${side + 2 * pad}px;height:${tri + pad}px;transform:${place(c.addScaledVector(v, -pad / 2), u, v, side + 2 * pad, tri + pad)}"></div>`,
            n,
          );
        }

    // triad: X/Y/Z from the origin corner (min x, y, z), along the cube's edges
    const o = new THREE.Vector3(-HALF, -HALF, -HALF);
    const names = ["x", "y", "z"];
    for (let i = 0; i < 3; i++) {
      const a = axes[i];
      // two perpendicular strips form a "+" cross-section, so the line reads from any angle
      const others = axes.filter((_, j) => j !== i);
      for (const w of others) {
        const u = a.clone();
        const v = w.clone(); // strip lies in the plane of a and w
        const c = o.clone().addScaledVector(a, AXIS / 2);
        const node = document.createElement("i");
        node.className = `ps-vc-axis ps-vc-${names[i]}`;
        node.style.width = `${AXIS}px`;
        node.style.transform = place(c, u, v, AXIS, 1.5);
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
    // simple key light from the upper left, in camera space, for a soft bevelled read
    for (const p of this.pieces) {
      const n = this.tmp.copy(p.n).transformDirection(m);
      const ndl = Math.max(0, n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z);
      p.el.style.setProperty("--vc-shade", fmt(1 - ndl));
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
.ps-viewcube{position:absolute;width:100px;height:100px;user-select:none;-webkit-user-select:none;touch-action:none;cursor:default;
  --vc-acc:var(--vc-accent,#2f7bf6)}
.ps-viewcube-scene{position:absolute;inset:0;perspective:900px;perspective-origin:50% 50%}
.ps-viewcube-cube{position:absolute;left:50%;top:50%;width:0;height:0;transform-style:preserve-3d}
.ps-vc-piece{position:absolute;left:0;top:0;box-sizing:border-box;transform-origin:0 0;backface-visibility:hidden;-webkit-backface-visibility:hidden;
  --vc-bg:var(--vc-face,rgba(255,255,255,.94));
  /* the themed face color is translucent; stack it so the cube reads solid and the triad
     doesn't show through */
  background:linear-gradient(var(--vc-bg),var(--vc-bg)),linear-gradient(var(--vc-bg),var(--vc-bg)),var(--vc-bg);transition:color .1s ease-out}
.ps-vc-piece::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:#000;opacity:calc(var(--vc-shade,0) * .16)}
.ps-vc-face{display:grid;place-items:center;border-radius:3px;box-shadow:inset 0 0 0 1px var(--vc-border,rgba(0,0,0,.12));
  font:500 9px/1 var(--font-sans,system-ui,sans-serif);letter-spacing:.01em;color:var(--vc-fg,#71717a)}
.ps-vc-face span{pointer-events:none;position:relative;z-index:1}
.ps-vc-edge{box-shadow:inset 0 0 0 .5px var(--vc-border,rgba(0,0,0,.12))}
.ps-vc-corner{clip-path:polygon(50% 0,100% 100%,0 100%)}
.ps-vc-edge::after,.ps-vc-corner::after{opacity:calc(.05 + var(--vc-shade,0) * .16)}
.ps-vc-piece:hover{--vc-bg:color-mix(in srgb,var(--vc-acc) 22%,var(--vc-face-hover,#fff));color:var(--vc-fg-hover,#18181b)}
.ps-vc-face:hover{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--vc-acc) 55%,transparent)}
.ps-vc-axis{position:absolute;left:0;top:0;height:1.5px;transform-origin:0 0;border-radius:1px;pointer-events:none;background:currentColor}
.ps-vc-alabel{position:absolute;left:0;top:0;pointer-events:none;font:600 8px/1 var(--font-sans,system-ui,sans-serif);transform-origin:0 0}
.ps-vc-x{color:#e5484d}.ps-vc-y{color:#30a46c}.ps-vc-z{color:#3e7bf6}
@media (prefers-reduced-motion: reduce){.ps-vc-piece{transition:none}}
`;
  document.head.appendChild(st);
}
