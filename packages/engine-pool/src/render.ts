// Headless renders for the MCP `render` tool: WebGPU inside the Deno engine host, no browser.
// On a server without a GPU, WebGPU runs on Mesa's software Vulkan (lavapipe).
// Not the viewer's pipeline (no AO or environment lighting), but its cameras, fit, light theme,
// camera-relative key/fill rig, ground grid, origin axes, feature edges, silhouettes, orange
// highlights and hatched section caps, so an agent sees what a person would.
import { zlibSync } from "fflate";
import { LIGHT } from "@parasocial/viewer/theme";

type Vec3 = [number, number, number];
type MeshData = { positions: Float32Array; normals: Float32Array; indices: Uint32Array; faceRanges: Uint32Array; edgePositions: Float32Array; edgeRanges: Uint32Array };
export type RenderPart = { mesh: MeshData; faceEdges: number[][]; edges: { seam?: boolean; smooth?: boolean }[]; vertices?: Vec3[]; color?: { kind: string; hex?: string } };
export type EntityRef = { part: string; kind: "face" | "edge" | "vertex" | "part"; index: number };
export type RenderOptions = {
  parts?: string[];
  view?: string;
  camera?: { position: number[]; target: number[]; up: number[]; ortho?: boolean };
  section?: { origin: number[]; normal: number[] };
  highlight?: EntityRef[];
  width?: number;
  height?: number;
  style?: "shaded" | "shadedEdges" | "wireframe" | "hiddenLine";
  /** Which model axis points up on screen for named views (and the ground grid): "z" like the workspace viewer (default), or "y". */
  up?: "z" | "y";
  /** Assembly instances moved from where their part is modeled (row-major rotation + translation). */
  poses?: Record<string, { r: number[]; t: number[] }>;
};

/** Same as the viewer's view cube directions (viewcube.ts). */
const VIEW_DIRS: Record<string, Vec3> = {
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  iso: norm([1, -1, 1]),
};
/** Y-up views: front looks down -Z from +Z, top looks down from +Y. */
const VIEW_DIRS_Y: Record<string, Vec3> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  iso: norm([1, 1, 1]),
};
const PALETTE = ["#8e939a", "#93b29c", "#8d8fd6", "#d2c27f", "#5fa6a4", "#cf96a4"];
const FOV = (35 * Math.PI) / 180;
const SAMPLES = 4;
const DEPTH = "depth24plus-stencil8";
const FORMAT = "rgba8unorm-srgb";
/** Orange tint on selected faces, as in the viewer. */
const SELECTED_TINT = 0.75;
const AXIS_OPACITY = 0.375;

// ---------- math (column-major 4×4, like WGSL) ----------
function sub(a: ArrayLike<number>, b: ArrayLike<number>): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: ArrayLike<number>, b: ArrayLike<number>, s = 1): Vec3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}
function dot(a: ArrayLike<number>, b: ArrayLike<number>) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: ArrayLike<number>, b: ArrayLike<number>): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: ArrayLike<number>): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function mul(a: Float32Array, b: Float32Array) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
function invert(m: Float32Array) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det, (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det, (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det, (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det, (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ]);
}
/** sRGB hex -> linear rgb (shading happens in linear light; the target encodes back to sRGB). */
function linear(hex: string): Vec3 {
  const n = parseInt(hex.replace("#", ""), 16);
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [f(((n >> 16) & 255) / 255), f(((n >> 8) & 255) / 255), f((n & 255) / 255)];
}
function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------- shaders ----------
const COMMON = /* wgsl */ `
struct Cam {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  eye: vec4f,      // xyz; w = 1 for ortho
  forward: vec4f,  // view direction; w = grid step
  key: vec4f,      // world-space light directions (towards the light)
  fill: vec4f,
  viewport: vec4f, // px w, h; z = depth-bias distance; w = grid fade distance
  plane: vec4f,    // section: dot(p, n) > d is cut away
  flags: vec4f,    // x: section on, y: flat faces (hidden line), z: perspective px per unit depth, w: ortho world units per px
  bgTop: vec4f,
  bgBottom: vec4f,
  gridMinor: vec4f,
  gridMajor: vec4f,
  ground: vec4f,   // xyz: the up axis (ground grid normal); w = 1 when it's +Y
};
@group(0) @binding(0) var<uniform> cam: Cam;
fn cut(p: vec3f) -> bool { return cam.flags.x > 0.5 && dot(p, cam.plane.xyz) > cam.plane.w; }
fn toEye(p: vec3f) -> vec3f { return select(normalize(cam.eye.xyz - p), -cam.forward.xyz, cam.eye.w > 0.5); }
// move a point along the view ray (towards the eye for s > 0) without moving it on screen
fn nudge(p: vec3f, s: f32) -> vec3f { return p + toEye(p) * s; }
`;

const BACKGROUND = COMMON + /* wgsl */ `
struct V { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return V(vec4f(xy, 0.0, 1.0), xy);
}
fn lines(p: vec2f, fw: vec2f, s: f32) -> f32 {
  let d = abs(fract(p / s - 0.5) - 0.5) * s / fw;
  let cov = clamp(1.0 - min(d.x, d.y), 0.0, 1.0);
  return cov * smoothstep(5.0, 14.0, s / max(fw.x, fw.y));
}
@fragment fn fs(v: V) -> @location(0) vec4f {
  var c = mix(cam.bgBottom.rgb, cam.bgTop.rgb, v.ndc.y * 0.5 + 0.5);
  // ground grid through the origin, normal to the up axis (three decades, fading with cell size and distance, like the viewer's)
  let a = cam.invViewProj * vec4f(v.ndc, 0.0, 1.0);
  let b = cam.invViewProj * vec4f(v.ndc, 1.0, 1.0);
  let ro = a.xyz / a.w;
  let rd = b.xyz / b.w - ro;
  let rn = dot(rd, cam.ground.xyz);
  let t = -dot(ro, cam.ground.xyz) / select(rn, 1e-9, abs(rn) < 1e-9);
  let hit = ro + rd * t;
  let s = cam.forward.w;
  let yUp = cam.ground.w > 0.5;
  let h2 = select(hit.xy, hit.xz, yUp);
  let e2 = select(cam.eye.xy, cam.eye.xz, yUp);
  let local = h2 - round(e2 / (s * 100.0)) * s * 100.0;
  let fw = max(fwidth(local), vec2f(1e-6));
  let a1 = lines(local, fw, s) * 0.9;
  let a2 = max(lines(local, fw, s * 10.0), lines(local, fw, s * 100.0));
  let fade = 1.0 - smoothstep(cam.viewport.w * 0.25, cam.viewport.w, distance(cam.eye.xyz, hit));
  let on = t > 0.0 && t < 1.0;
  let g = select(0.0, max(a1, a2) * fade, on);
  c = mix(c, select(cam.gridMinor.rgb, cam.gridMajor.rgb, a2 >= a1), g);
  return vec4f(c, 1.0);
}`;

const FACES = COMMON + /* wgsl */ `
struct V { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) n: vec3f, @location(2) color: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec3f) -> V {
  return V(cam.viewProj * vec4f(p, 1.0), p, n, c);
}
@fragment fn fs(v: V) -> @location(0) vec4f {
  if (cut(v.world)) { discard; }
  if (cam.flags.y > 0.5) { return vec4f(v.color, 1.0); }
  let e = toEye(v.world);
  var n = normalize(v.n);
  if (dot(n, e) < 0.0) { n = -n; } // two-sided, whatever the winding
  let key = max(dot(n, cam.key.xyz), 0.0);
  let fill = max(dot(n, cam.fill.xyz), 0.0);
  let sky = mix(vec3f(0.36, 0.36, 0.38), vec3f(0.62), dot(n, cam.ground.xyz) * 0.5 + 0.5);
  let h = normalize(cam.key.xyz + e);
  let spec = pow(max(dot(n, h), 0.0), 48.0) * 0.1;
  return vec4f(v.color * (sky + key * 0.62 + fill * 0.16) + spec, 1.0);
}`;

/** Inverted hull: back faces (triangles are wound outward), grown along the normal by a few pixels. */
const SILHOUETTE = COMMON + /* wgsl */ `
struct Draw { color: vec4f, width: vec4f };
@group(1) @binding(0) var<uniform> draw: Draw;
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec3f) -> @builtin(position) vec4f {
  // world units per pixel at this point
  let wpp = select(dot(p - cam.eye.xyz, cam.forward.xyz) * cam.flags.z, cam.flags.w, cam.eye.w > 0.5);
  return cam.viewProj * vec4f(p + normalize(n) * wpp * draw.width.x, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return draw.color; }`;

/** Screen-space quads for line segments (edges, axes) and square vertex markers (a == b). */
const LINES = COMMON + /* wgsl */ `
struct Draw { color: vec4f, width: vec4f }; // width.x px, width.y depth bias (× cam.viewport.z)
@group(1) @binding(0) var<uniform> draw: Draw;
struct V { @builtin(position) pos: vec4f, @location(0) world: vec3f };
fn clipNear(a: vec4f, b: vec4f) -> vec4f {
  if (a.z >= 0.0) { return a; }
  return mix(a, b, (a.z - 1e-6 * a.w) / (a.z - b.z));
}
@vertex fn vs(@builtin(vertex_index) i: u32, @location(0) a: vec3f, @location(1) b: vec3f) -> V {
  let bias = cam.viewport.z * draw.width.y;
  let wa = nudge(a, bias);
  let wb = nudge(b, bias);
  let ca = cam.viewProj * vec4f(wa, 1.0);
  let cb = cam.viewProj * vec4f(wb, 1.0);
  if (ca.z < 0.0 && cb.z < 0.0) { return V(vec4f(2.0, 2.0, 2.0, 1.0), a); }
  let ca2 = clipNear(ca, cb);
  let cb2 = clipNear(cb, ca);
  let half = cam.viewport.xy * 0.5;
  var dir = cb2.xy / cb2.w * half - ca2.xy / ca2.w * half;
  if (length(dir) < 1e-4) { dir = vec2f(1.0, 0.0); }
  dir = normalize(dir);
  let perp = vec2f(-dir.y, dir.x);
  let corners = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let k = corners[i];
  var clip = mix(ca2, cb2, k.x);
  let off = (perp * k.y + dir * (k.x * 2.0 - 1.0)) * draw.width.x * 0.5;
  clip = vec4f(clip.xy + off / half * clip.w, clip.zw);
  return V(clip, mix(a, b, k.x));
}
@fragment fn fs(v: V) -> @location(0) vec4f {
  if (cut(v.world)) { discard; }
  return draw.color;
}`;

/** Section cap: a quad on the cutting plane, drawn where the stencil says the plane is inside the part. */
const CAP = COMMON + /* wgsl */ `
struct Draw { color: vec4f, hatch: vec4f, u: vec4f }; // hatch: rgb + spacing; u: hatch direction
@group(1) @binding(0) var<uniform> draw: Draw;
struct V { @builtin(position) pos: vec4f, @location(0) world: vec3f };
@vertex fn vs(@location(0) p: vec3f) -> V { return V(cam.viewProj * vec4f(p, 1.0), p); }
@fragment fn fs(v: V) -> @location(0) vec4f {
  let s = dot(v.world, draw.u.xyz) / draw.hatch.w;
  let px = abs(fract(s + 0.5) - 0.5) / max(fwidth(s), 1e-6);
  let line = (1.0 - smoothstep(0.35, 1.1, px)) * smoothstep(3.0, 6.0, 1.0 / max(fwidth(s), 1e-6));
  return vec4f(mix(draw.color.rgb, draw.hatch.rgb, line * 0.8), 1.0);
}`;

// ---------- device ----------
let gpu: Promise<any> | null = null;
function device(): Promise<any> {
  gpu ??= (async () => {
    const adapter = await (navigator as any).gpu?.requestAdapter();
    if (!adapter) throw new Error("render unavailable: no WebGPU adapter (on a GPU-less Linux host, install Mesa's Vulkan drivers: mesa-vulkan-drivers)");
    const dev = await adapter.requestDevice();
    return { dev, pipes: pipelines(dev) };
  })().catch((e) => {
    gpu = null;
    throw e;
  });
  return gpu;
}

function pipelines(dev: any) {
  const G = (globalThis as any).GPUShaderStage ?? { VERTEX: 1, FRAGMENT: 2 };
  const camLayout = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: G.VERTEX | G.FRAGMENT, buffer: {} }] });
  const drawLayout = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: G.VERTEX | G.FRAGMENT, buffer: {} }] });
  const layout0 = dev.createPipelineLayout({ bindGroupLayouts: [camLayout] });
  const layout1 = dev.createPipelineLayout({ bindGroupLayouts: [camLayout, drawLayout] });
  const faceBuffers = [{ arrayStride: 36, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }, { shaderLocation: 2, offset: 24, format: "float32x3" }] }];
  const stencilOff = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
  const depth = (compare: string, write: boolean, stencil = stencilOff) => ({ format: DEPTH, depthCompare: compare, depthWriteEnabled: write, stencilFront: stencil, stencilBack: stencil });
  const blend = { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
  const make = (code: string, layout: any, buffers: any[], depthStencil: any, opts: { targets?: any[]; cull?: string } = {}) => {
    const module = dev.createShaderModule({ code });
    return dev.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: "vs", buffers },
      fragment: { module, entryPoint: "fs", targets: opts.targets ?? [{ format: FORMAT }] },
      primitive: { topology: "triangle-list", cullMode: opts.cull ?? "none" },
      depthStencil,
      multisample: { count: SAMPLES },
    });
  };
  const invert = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "invert" };
  const inside = { compare: "not-equal", failOp: "keep", depthFailOp: "zero", passOp: "zero" };
  return {
    camLayout,
    drawLayout,
    background: make(BACKGROUND, layout0, [], depth("always", false)),
    faces: make(FACES, layout0, faceBuffers, depth("less", true)),
    silhouette: make(SILHOUETTE, layout1, faceBuffers, depth("less", true), { cull: "front" }),
    lines: make(LINES, layout1, [{ arrayStride: 24, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }] }], depth("less-equal", false), { targets: [{ format: FORMAT, blend }] }),
    // parity of the (clipped) surfaces along each pixel's ray: odd where the plane lies inside the part
    stencil: make(FACES, layout0, faceBuffers, depth("always", false, invert), { targets: [{ format: FORMAT, writeMask: 0 }] }),
    cap: make(CAP, layout1, [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }], depth("less-equal", true, inside)),
  };
}

// ---------- scene ----------
function bounds(parts: RenderPart[]) {
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const a = p.mesh.positions;
    for (let i = 0; i < a.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (a[i + k] < min[k]) min[k] = a[i + k];
        if (a[i + k] > max[k]) max[k] = a[i + k];
      }
  }
  if (min[0] > max[0]) return { center: [0, 0, 0] as Vec3, radius: 50, min: [-50, -50, -50] as Vec3, max: [50, 50, 50] as Vec3 };
  return { center: add(min, sub(max, min), 0.5), radius: Math.max(Math.hypot(...sub(max, min)) / 2, 1e-3), min, max };
}

function camera(o: RenderOptions, b: ReturnType<typeof bounds>, aspect: number) {
  let eye: Vec3, target: Vec3, up: Vec3, ortho: boolean, orthoHeight: number;
  if (o.camera) {
    eye = o.camera.position as Vec3;
    target = o.camera.target as Vec3;
    up = norm(o.camera.up);
    ortho = !!o.camera.ortho;
    orthoHeight = 2 * Math.hypot(...sub(eye, target)) * Math.tan(FOV / 2);
  } else {
    // Viewer.fit: keep the view direction, back off until the bounding sphere fits
    const dirs = o.up === "y" ? VIEW_DIRS_Y : VIEW_DIRS;
    const d = dirs[o.view ?? "iso"] ?? dirs.iso;
    const fitH = b.radius / Math.sin(FOV / 2);
    const fitW = b.radius / Math.sin(Math.atan(Math.tan(FOV / 2) * aspect));
    eye = add(b.center, d, Math.max(fitH, fitW) * 1.12);
    target = b.center;
    // looking straight along the up axis, the screen's up is the next axis round (+Y for top in Z-up, -Z in Y-up)
    if (o.up === "y") up = Math.abs(d[1]) > 0.999 ? [0, 0, d[1] > 0 ? -1 : 1] : [0, 1, 0];
    else up = Math.abs(d[2]) > 0.999 ? [0, d[2] > 0 ? 1 : -1, 0] : [0, 0, 1];
    ortho = false;
    orthoHeight = b.radius * 2.3 * Math.max(1, 1 / aspect);
  }
  const z = norm(sub(eye, target));
  let x = cross(up, z);
  if (Math.hypot(...x) < 1e-9) x = cross(Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0], z);
  x = norm(x);
  const y = cross(z, x);
  const view = new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  const dist = dot(sub(eye, b.center), z);
  const reach = Math.max(dist, b.radius) * 6;
  let proj: Float32Array;
  if (ortho) {
    const near = dist - reach,
      far = dist + reach;
    const h = orthoHeight,
      w = h * aspect;
    proj = new Float32Array([2 / w, 0, 0, 0, 0, 2 / h, 0, 0, 0, 0, 1 / (near - far), 0, 0, 0, near / (near - far), 1]);
  } else {
    const near = Math.max(dist - b.radius * 1.2, b.radius * 0.01),
      far = dist + reach;
    const f = 1 / Math.tan(FOV / 2);
    proj = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0]);
  }
  // the viewer's rig lives in camera space: key from the upper left, fill from the lower right
  const toWorld = (v: Vec3) => norm(add(add(add([0, 0, 0], x, v[0]), y, v[1]), z, v[2]));
  return { eye, forward: [-z[0], -z[1], -z[2]] as Vec3, ortho, orthoHeight, viewProj: mul(proj, view), key: toWorld(norm([-0.55, 0.8, 2])), fill: toWorld(norm([0.8, -0.5, 1.4])), reach };
}

/** Deterministic per-part hatch (Viewer.applyClip). */
function hatchFor(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h >>>= 0;
  const angles = [45, 135, 60, 120, 30, 150, 75, 105];
  const scales = [1, 0.75, 1.3];
  return { angle: (angles[h % angles.length] * Math.PI) / 180, scale: scales[(h >>> 8) % scales.length] };
}

/** A part's render data moved by its assembly pose (positions, normals, edges, vertices). */
export function posed(r: RenderPart, pose?: { r: number[]; t: number[] }): RenderPart {
  if (!pose) return r;
  const R = pose.r,
    T = pose.t;
  const xf = (src: Float32Array, translate: boolean) => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i],
        y = src[i + 1],
        z = src[i + 2];
      out[i] = R[0] * x + R[1] * y + R[2] * z + (translate ? T[0] : 0);
      out[i + 1] = R[3] * x + R[4] * y + R[5] * z + (translate ? T[1] : 0);
      out[i + 2] = R[6] * x + R[7] * y + R[8] * z + (translate ? T[2] : 0);
    }
    return out;
  };
  const m = r.mesh;
  return {
    ...r,
    mesh: { ...m, positions: xf(m.positions, true), normals: xf(m.normals, false), edgePositions: xf(m.edgePositions, true) },
    vertices: r.vertices?.map((v) => [...xf(new Float32Array(v), true)] as Vec3),
  };
}

// ---------- render ----------
/** Render parts to a PNG; returns it base64-encoded. */
export async function renderPNG(all: Map<string, RenderPart>, o: RenderOptions): Promise<string> {
  const { dev, pipes } = await device();
  dev.pushErrorScope("validation");
  const W = o.width ?? 1024,
    H = o.height ?? 768;
  const style = o.style ?? "shadedEdges";
  const t = LIGHT;
  const entries = [...all].filter(([id, r]) => r.mesh && (!o.parts || o.parts.includes(id))).map(([id, r]): [string, RenderPart] => [id, posed(r, o.poses?.[id])]);
  const parts = entries.map(([, r]) => r);
  const b = bounds(parts);
  const c = camera(o, b, W / H);
  const bias = b.radius * 0.003;
  const section = o.section ? { n: norm(o.section.normal), d: dot(norm(o.section.normal), o.section.origin) } : null;
  const yUp = o.up === "y";
  const gridSize = Math.max(b.max[0] - b.min[0], yUp ? b.max[2] - b.min[2] : b.max[1] - b.min[1]) * 1.6;
  const gridStep = Math.pow(10, Math.floor(Math.log10(Math.max(gridSize, 1) / 8)));

  const destroy: any[] = [];
  const U = (globalThis as any).GPUBufferUsage ?? { MAP_READ: 1, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32, UNIFORM: 64 };
  const buffer = (data: Float32Array, usage: number) => {
    const buf = dev.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 16) * 16), usage: usage | U.COPY_DST });
    dev.queue.writeBuffer(buf, 0, data);
    destroy.push(buf);
    return buf;
  };
  // every per-draw uniform is padded to the largest Draw struct (the cap's): the pipelines share one layout
  const drawGroup = (data: number[]) => {
    const f = new Float32Array(12);
    f.set(data);
    return dev.createBindGroup({ layout: pipes.drawLayout, entries: [{ binding: 0, resource: { buffer: buffer(f, U.UNIFORM) } }] });
  };
  const rgba = (v: Vec3, a = 1) => [...v, a];

  const camData = new Float32Array(16 * 2 + 4 * 12); // Cam: two matrices, twelve vec4s
  camData.set(c.viewProj, 0);
  camData.set(invert(c.viewProj), 16);
  camData.set([...c.eye, c.ortho ? 1 : 0, ...c.forward, gridStep, ...c.key, 0, ...c.fill, 0, W, H, bias, c.reach, ...(section ? [...section.n, section.d] : [0, 0, 1, 0]), section ? 1 : 0, style === "hiddenLine" ? 1 : 0, (2 * Math.tan(FOV / 2)) / H, c.orthoHeight / H], 32);
  camData.set([...rgba(linear(t.backgroundTop ?? t.background)), ...rgba(linear(t.background)), ...rgba(linear(t.grid)), ...rgba(linear(t.gridMajor)), ...(yUp ? [0, 1, 0, 1] : [0, 0, 1, 0])], 32 + 4 * 7);
  const camGroup = dev.createBindGroup({ layout: pipes.camLayout, entries: [{ binding: 0, resource: { buffer: buffer(camData, U.UNIFORM) } }] });

  // highlight semantics as in Viewer.restyle
  const selFill = linear(t.selectedFill);
  const hiddenFill = linear(t.hiddenLineFill);
  type Prepared = { id: string; faces: any; faceCount: number; edges: any; edgeCount: number; sel: any; selCount: number; marks: any; markCount: number; color: Vec3; center: Vec3; radius: number };
  const prepared: Prepared[] = [];
  let palette = 0;
  for (const [id, r] of entries) {
    const m = r.mesh;
    const base = linear(r.color?.kind === "rgb" && r.color.hex ? r.color.hex : PALETTE[palette++ % PALETTE.length]);
    const refs = (o.highlight ?? []).filter((h) => h.part === id);
    const faceCount = m.faceRanges.length / 2;
    const tinted = new Set<number>();
    const selEdges = new Set<number>();
    const marks: Vec3[] = [];
    for (const h of refs) {
      if (h.kind === "face" && h.index < faceCount) (tinted.add(h.index), (r.faceEdges[h.index] ?? []).forEach((e) => selEdges.add(e)));
      else if (h.kind === "edge") selEdges.add(h.index);
      else if (h.kind === "vertex" && r.vertices?.[h.index]) marks.push(r.vertices[h.index]);
      else if (h.kind === "part") for (let f = 0; f < faceCount; f++) tinted.add(f);
    }
    const plain = style === "hiddenLine" ? hiddenFill : base;
    const tint = mix(plain, selFill, SELECTED_TINT);
    // faces: unindexed, position + normal + colour per corner
    let tris = 0;
    for (let f = 0; f < faceCount; f++) tris += m.faceRanges[f * 2 + 1];
    const fv = new Float32Array(tris * 9);
    let k = 0;
    for (let f = 0; f < faceCount; f++) {
      const col = tinted.has(f) ? tint : plain;
      const s = m.faceRanges[f * 2],
        n = m.faceRanges[f * 2 + 1];
      for (let i = s; i + 2 < s + n; i += 3) {
        // wind every triangle outward (counter-clockwise seen from its normals' side) for the hull's culling
        const [a, b2, c2] = [m.indices[i] * 3, m.indices[i + 1] * 3, m.indices[i + 2] * 3];
        const P = (v: number): Vec3 => [m.positions[v], m.positions[v + 1], m.positions[v + 2]];
        const N = (v: number): Vec3 => [m.normals[v], m.normals[v + 1], m.normals[v + 2]];
        const outward = dot(cross(sub(P(b2), P(a)), sub(P(c2), P(a))), add(add(N(a), N(b2)), N(c2))) >= 0;
        for (const v of outward ? [a, b2, c2] : [a, c2, b2]) {
          fv.set([...P(v), ...N(v), col[0], col[1], col[2]], k);
          k += 9;
        }
      }
    }
    const segs = (ids: Iterable<number>) => {
      const out: number[] = [];
      for (const e of ids) {
        if (r.edges[e]?.seam || r.edges[e]?.smooth) continue;
        const s = m.edgeRanges[e * 2],
          n = m.edgeRanges[e * 2 + 1];
        if (n === undefined) continue;
        for (let i = s * 3; i < (s + n) * 3; i++) out.push(m.edgePositions[i]);
      }
      return new Float32Array(out);
    };
    const edges = segs(Array.from({ length: m.edgeRanges.length / 2 }, (_, i) => i));
    const sel = segs(selEdges);
    const markData = new Float32Array(marks.flatMap((p) => [...p, ...p]));
    const pb = bounds([r]);
    prepared.push({
      id,
      faces: tris ? buffer(fv, U.VERTEX) : null,
      faceCount: tris,
      edges: edges.length ? buffer(edges, U.VERTEX) : null,
      edgeCount: edges.length / 6,
      sel: sel.length ? buffer(sel, U.VERTEX) : null,
      selCount: sel.length / 6,
      marks: markData.length ? buffer(markData, U.VERTEX) : null,
      markCount: marks.length,
      color: base,
      center: pb.center,
      radius: pb.radius,
    });
  }

  const TU = (globalThis as any).GPUTextureUsage ?? { COPY_SRC: 1, RENDER_ATTACHMENT: 16 };
  const msaa = dev.createTexture({ size: [W, H], format: FORMAT, sampleCount: SAMPLES, usage: TU.RENDER_ATTACHMENT });
  const resolve = dev.createTexture({ size: [W, H], format: FORMAT, usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC });
  const depthTex = dev.createTexture({ size: [W, H], format: DEPTH, sampleCount: SAMPLES, usage: TU.RENDER_ATTACHMENT });
  destroy.push(msaa, resolve, depthTex);

  const enc = dev.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: msaa.createView(), resolveTarget: resolve.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "discard" }],
    depthStencilAttachment: { view: depthTex.createView(), depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "discard", stencilLoadOp: "clear", stencilClearValue: 0, stencilStoreOp: "discard" },
  });
  pass.setBindGroup(0, camGroup);
  pass.setPipeline(pipes.background);
  pass.draw(3);

  const shaded = style !== "wireframe";
  if (shaded) {
    pass.setPipeline(pipes.faces);
    for (const p of prepared) if (p.faces) (pass.setVertexBuffer(0, p.faces), pass.draw(p.faceCount));
  }
  if (shaded && section) {
    // one part at a time: the cap pass zeroes every stencil value it touches, ready for the next
    const n = section.n;
    const u0 = norm(cross(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], n));
    const v0 = cross(n, u0);
    for (const p of prepared) {
      if (!p.faces) continue;
      pass.setPipeline(pipes.stencil);
      pass.setStencilReference(0);
      pass.setVertexBuffer(0, p.faces);
      pass.draw(p.faceCount);
      const ctr = add(p.center, n, section.d - dot(p.center, n));
      const s = p.radius * 1.5;
      const corner = (a: number, bb: number) => add(add(ctr, u0, a * s), v0, bb * s);
      const quad = new Float32Array([...corner(-1, -1), ...corner(1, -1), ...corner(1, 1), ...corner(-1, -1), ...corner(1, 1), ...corner(-1, 1)]);
      const h = hatchFor(p.id);
      const dir = add(add([0, 0, 0], u0, Math.cos(h.angle)), v0, Math.sin(h.angle));
      pass.setPipeline(pipes.cap);
      pass.setBindGroup(1, drawGroup([...mix(p.color, [0, 0, 0], 0.12), 1, ...mix(p.color, [0, 0, 0], 0.7), (p.radius / 40) * h.scale, ...dir, 0]));
      pass.setVertexBuffer(0, buffer(quad, U.VERTEX));
      pass.draw(6);
    }
  }
  if (shaded && !section) {
    // the viewer drops the silhouette while cut (it would draw over the caps from inside)
    pass.setPipeline(pipes.silhouette);
    pass.setBindGroup(1, drawGroup([...linear(t.silhouette), 1, 1.1, 0, 0, 0]));
    for (const p of prepared) if (p.faces) (pass.setVertexBuffer(0, p.faces), pass.draw(p.faceCount));
  }
  const lines = (buf: any, count: number, color: Vec3, width: number, depthBias: number, alpha = 1) => {
    if (!buf || !count) return;
    pass.setBindGroup(1, drawGroup([...color, alpha, width, depthBias, 0, 0]));
    pass.setVertexBuffer(0, buf);
    pass.draw(6, count);
  };
  pass.setPipeline(pipes.lines);
  // origin axes (positive half, out towards the horizon), depth-tested against the parts
  const axes = buffer(new Float32Array([0, 0, 0, c.reach, 0, 0, 0, 0, 0, 0, c.reach, 0, 0, 0, 0, 0, 0, c.reach]), U.VERTEX);
  for (const [i, col] of [t.axisX, t.axisY, t.axisZ].entries()) {
    pass.setBindGroup(1, drawGroup([...linear(col), AXIS_OPACITY, 2, 0, 0, 0]));
    pass.setVertexBuffer(0, axes, i * 24, 24);
    pass.draw(6, 1);
  }
  if (style !== "shaded") for (const p of prepared) lines(p.edges, p.edgeCount, linear(style === "wireframe" && t.dark ? "#f4f4f5" : t.edge), style === "shadedEdges" ? 1.15 : 1.25, 1, style === "shadedEdges" ? 0.9 : 1);
  for (const p of prepared) lines(p.sel, p.selCount, linear(t.selectedStroke), 2.5, 1.5);
  for (const p of prepared) lines(p.marks, p.markCount, linear(t.selectedStroke), 7, 3);
  pass.end();

  const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
  const read = dev.createBuffer({ size: bytesPerRow * H, usage: U.MAP_READ | U.COPY_DST });
  destroy.push(read);
  enc.copyTextureToBuffer({ texture: resolve }, { buffer: read, bytesPerRow }, [W, H]);
  dev.queue.submit([enc.finish()]);
  const invalid = await dev.popErrorScope();
  if (invalid) {
    for (const d of destroy) d.destroy();
    throw new Error(`render failed: ${invalid.message}`);
  }
  const MAP_READ = (globalThis as any).GPUMapMode?.READ ?? 1;
  await read.mapAsync(MAP_READ);
  const px = new Uint8Array(read.getMappedRange());
  const raw = new Uint8Array((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const s = y * bytesPerRow + x * 4,
        d = y * (W * 3 + 1) + 1 + x * 3;
      raw[d] = px[s];
      raw[d + 1] = px[s + 1];
      raw[d + 2] = px[s + 2];
    }
  }
  read.unmap();
  for (const d of destroy) d.destroy();
  return base64(png(W, H, raw));
}

// ---------- PNG ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** RGB PNG from filtered scanlines (a 0 filter byte before each row). */
function png(w: number, h: number, raw: Uint8Array) {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    let c = 0xffffffff;
    for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 255] ^ (c >>> 8);
    dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw, { level: 6 })), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

function base64(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
