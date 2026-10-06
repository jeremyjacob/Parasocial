// Build animation: every face of every part flies in from outside and pops into place, smallest
// parts first, each part from its centre outward. All on the GPU: each face's vertices (and the
// edge segments riding with it) carry the face centre, its order within the part and where it
// flies in from; one shared uniform is the progress, one per part its time window.
import * as THREE from "three";

/** Progress value meaning "not building": every face is in place. */
export const BUILD_OFF = 2;

/** Shared by every part of one viewer. */
export type BuildUniforms = {
  buildT: { value: number };
  /** One face's flight, as a share of the whole timeline. */
  buildDur: { value: number };
  /** Tint a face arrives with, fading as it settles. */
  buildGlow: { value: THREE.Color };
};

export const makeBuildUniforms = (): BuildUniforms => ({
  buildT: { value: BUILD_OFF },
  buildDur: { value: 0.1 },
  buildGlow: { value: new THREE.Color(0xff8a00) },
});

const PARS = /* glsl */ `
uniform float buildT, buildDur;
uniform vec2 buildWindow; // this part: start, span
attribute vec4 buildA; // face centre (xyz), order within the part, 0..1 (w)
attribute vec3 buildB; // where the face flies in from, relative to its place
varying float vBuildT;
vec3 buildMove(vec3 p, vec4 a, vec3 off, out float t) {
  t = clamp((buildT - buildWindow.x - buildWindow.y * a.w) / buildDur, 0.0, 1.0);
  float e = 1.0 - pow(1.0 - t, 3.0);
  // grows with a little overshoot (ease-out-back) while it glides in
  float u = t - 1.0;
  float s = 1.0 + 2.70158 * u * u * u + 1.70158 * u * u;
  return a.xyz + (p - a.xyz) * s + off * (1.0 - e);
}
`;

// a primitive whose vertices all land here is clipped away (beyond the far plane either way)
const HIDE = "if (bT <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);";

/**
 * Patch a material whose geometry carries buildA/buildB. `kind`: "mesh" for built-in or
 * three-chunk shaders (begin_vertex/project_vertex), "line" for LineMaterial (instanced
 * segments). `glow` tints arriving faces (mesh only).
 */
export function withBuild<T extends THREE.Material>(m: T, u: BuildUniforms, win: { value: THREE.Vector2 }, kind: "mesh" | "line", glow = false): T {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, u, { buildWindow: win });
    let v = sh.vertexShader.replace("void main() {", `${PARS}\nvoid main() {`);
    if (kind === "mesh") {
      v = v
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nfloat bT;\ntransformed = buildMove(transformed, buildA, buildB, bT);\nvBuildT = bT;")
        .replace("#include <project_vertex>", `#include <project_vertex>\n${HIDE}`);
    } else {
      v = v
        .replace("vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );", "float bT;\nvec4 start = modelViewMatrix * vec4( buildMove( instanceStart, buildA, buildB, bT ), 1.0 );\nvBuildT = bT;")
        .replace("vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );", "float bT2;\nvec4 end = modelViewMatrix * vec4( buildMove( instanceEnd, buildA, buildB, bT2 ), 1.0 );")
        .replace("#include <fog_vertex>", `${HIDE}\n#include <fog_vertex>`);
    }
    sh.vertexShader = v;
    if (glow)
      sh.fragmentShader = sh.fragmentShader
        .replace("void main() {", "uniform vec3 buildGlow;\nvarying float vBuildT;\nvoid main() {")
        .replace("#include <opaque_fragment>", "outgoingLight = mix(outgoingLight, buildGlow, (1.0 - vBuildT) * 0.75);\n#include <opaque_fragment>");
  };
  m.customProgramCacheKey = () => `${prevKey()}+build:${kind}${glow ? "+glow" : ""}`;
  return m;
}

/** Cheap stable hash to 0..1, so faces at the same distance don't all arrive at once. */
const hash = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Per-face build data for a part: centre, order (by distance from the part's centre, a little
 * jittered) and fly-in offset (outward from the centre, farther for outer faces).
 */
export function faceBuildData(positions: Float32Array, faceVerts: Uint32Array, normals: Float32Array) {
  const nFaces = faceVerts.length / 2;
  const centres = new Float32Array(nFaces * 3);
  const box = new THREE.Box3().setFromArray(positions);
  const mid = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.min.distanceTo(box.max) / 2, 1e-6);
  const dist = new Float32Array(nFaces);
  let maxD = 1e-9;
  for (let f = 0; f < nFaces; f++) {
    const lo = faceVerts[f * 2],
      cnt = faceVerts[f * 2 + 1];
    let x = 0,
      y = 0,
      z = 0;
    for (let v = lo; v < lo + cnt; v++) (x += positions[v * 3]), (y += positions[v * 3 + 1]), (z += positions[v * 3 + 2]);
    if (cnt) (x /= cnt), (y /= cnt), (z /= cnt);
    centres.set([x, y, z], f * 3);
    dist[f] = Math.hypot(x - mid.x, y - mid.y, z - mid.z);
    maxD = Math.max(maxD, dist[f]);
  }
  const order = new Float32Array(nFaces);
  const offset = new Float32Array(nFaces * 3);
  const d = new THREE.Vector3();
  for (let f = 0; f < nFaces; f++) {
    const dn = dist[f] / maxD;
    order[f] = Math.min(1, Math.max(0, dn * 0.88 + hash(f) * 0.12));
    d.set(centres[f * 3] - mid.x, centres[f * 3 + 1] - mid.y, centres[f * 3 + 2] - mid.z);
    if (d.lengthSq() < (radius * 1e-3) ** 2) {
      // a face centred on the part's centre: come in along its normal (or from above)
      const v = faceVerts[f * 2];
      d.set(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
      if (d.lengthSq() < 1e-12) d.set(0, 0, 1);
    }
    d.normalize().multiplyScalar(radius * (0.35 + 0.65 * dn));
    offset.set([d.x, d.y, d.z], f * 3);
  }
  return { centres, order, offset };
}
