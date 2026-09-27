// View cube: a crisp CSS 3D cube synced to the camera. Click a face, edge or corner to go
// to that view. DOM-only, so it's sharp at any DPR and costs nothing to render.
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

const FACES: { name: string; label: string; transform: string }[] = [
  { name: "front", label: "Front", transform: "rotateX(90deg) translateZ(var(--h))" },
  { name: "back", label: "Back", transform: "rotateX(90deg) rotateY(180deg) translateZ(var(--h))" },
  { name: "right", label: "Right", transform: "rotateX(90deg) rotateY(90deg) translateZ(var(--h))" },
  { name: "left", label: "Left", transform: "rotateX(90deg) rotateY(-90deg) translateZ(var(--h))" },
  { name: "top", label: "Top", transform: "translateZ(var(--h))" },
  { name: "bottom", label: "Bottom", transform: "rotateX(180deg) translateZ(var(--h))" },
];

export class ViewCube {
  readonly el: HTMLDivElement;
  private cube: HTMLDivElement;
  constructor(
    parent: HTMLElement,
    private onPick: (dir: THREE.Vector3, up?: THREE.Vector3) => void,
  ) {
    const el = document.createElement("div");
    el.className = "ps-viewcube";
    el.innerHTML = `<div class="ps-viewcube-scene"><div class="ps-viewcube-cube">${FACES.map((f) => `<button type="button" class="ps-vc-face" data-face="${f.name}" style="transform:${faceMatrix(f.name)}" aria-label="${f.label} view"><span>${f.label}</span>${hotspots(f.name)}</button>`).join("")}</div></div>`;
    parent.appendChild(el);
    this.el = el;
    this.cube = el.querySelector(".ps-viewcube-cube")!;
    el.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest("[data-dir]") as HTMLElement | null;
      const f = (e.target as HTMLElement).closest("[data-face]") as HTMLElement | null;
      if (t) {
        const d = t.dataset.dir!.split(",").map(Number);
        this.onPick(new THREE.Vector3(d[0], d[1], d[2]).normalize());
      } else if (f) this.onPick(VIEW_DIRS[f.dataset.face!].clone());
    });
    injectStyles();
  }

  /** Sync with the camera orientation. */
  update(camera: THREE.Camera) {
    // CSS space: x right, y down, z toward viewer. Rotate the cube by the inverse camera rotation.
    const m = new THREE.Matrix4().extractRotation(camera.matrixWorldInverse);
    const e = m.elements;
    // CSS = F·R·W with F = W = diag(1,-1,1) (CSS y points down): negate entries where exactly
    // one of row/column is y, so the result stays a rotation (no mirroring)
    const css = [e[0], -e[1], e[2], 0, -e[4], e[5], -e[6], 0, e[8], -e[9], e[10], 0, 0, 0, 0, 1];
    this.cube.style.transform = `translateZ(-96px) matrix3d(${css.map((v) => v.toFixed(6)).join(",")})`;
  }

  dispose() {
    this.el.remove();
  }
}

const HALF = 32;
/** Face-local CSS (x right, y down, z out) -> cube CSS, built from the face's world frame. */
function faceMatrix(face: string): string {
  const [u, v] = FRAMES[face];
  const n = VIEW_DIRS[face];
  // world -> cube CSS is diag(1, -1, 1); face y (down) is world -v
  const w = (a: THREE.Vector3) => [a.x, -a.y, a.z];
  const c0 = w(u),
    c1 = w(v.clone().negate()),
    c2 = w(n),
    t = w(n.clone().multiplyScalar(HALF));
  return `translate(-50%,-50%) matrix3d(${[...c0, 0, ...c1, 0, ...c2, 0, ...t, 1].map((x) => +x.toFixed(6)).join(",")})`;
}

const FRAMES: Record<string, [THREE.Vector3, THREE.Vector3]> = {
  front: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
  back: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1)],
  right: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
  left: [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1)],
  top: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
  bottom: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0)],
};

/** Edge and corner hotspots on a face: 3x3 grid, center is the face itself. */
function hotspots(face: string): string {
  const n = VIEW_DIRS[face];
  // local axes of the face in world space: u (right on the label), v (up on the label)
  const [u, v] = FRAMES[face];
  let s = "";
  for (const j of [1, 0, -1])
    for (const i of [-1, 0, 1]) {
      if (i === 0 && j === 0) continue;
      const d = n.clone().add(u.clone().multiplyScalar(i)).add(v.clone().multiplyScalar(j));
      const pos = `left:${(i + 1) * 33.33}%;top:${(1 - j) * 33.33}%`;
      s += `<i class="ps-vc-hot" data-dir="${d.x},${d.y},${d.z}" style="${pos}"></i>`;
    }
  return s;
}

let injected = false;
function injectStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const st = document.createElement("style");
  st.textContent = `
.ps-viewcube{--s:64px;--h:32px;position:absolute;width:var(--s);height:var(--s);perspective:none;user-select:none}
.ps-viewcube-scene{width:100%;height:100%;perspective:1200px}
.ps-viewcube-cube{position:relative;width:100%;height:100%;transform-style:preserve-3d;transform-origin:50% 50%}
.ps-vc-face{all:unset;box-sizing:border-box;position:absolute;left:50%;top:50%;width:64px;height:64px;display:grid;place-items:center;
  background:var(--vc-face,rgba(255,255,255,.92));border:1px solid var(--vc-border,rgba(0,0,0,.14));
  font:500 9.5px/1 var(--font-sans,system-ui);letter-spacing:.02em;color:var(--vc-fg,#52525b);text-transform:uppercase;
  backface-visibility:hidden;cursor:pointer;transition:background-color .12s ease-out,color .12s ease-out}
.ps-vc-face:hover{background:var(--vc-face-hover,#fff);color:var(--vc-fg-hover,#18181b)}
.ps-vc-face span{pointer-events:none}
.ps-vc-hot{position:absolute;width:33.34%;height:33.34%;border-radius:2px}
.ps-vc-hot:hover{background:var(--vc-hot,rgba(59,130,246,.28))}
@media (prefers-reduced-motion: reduce){.ps-vc-face{transition:none}}
`;
  document.head.appendChild(st);
}
