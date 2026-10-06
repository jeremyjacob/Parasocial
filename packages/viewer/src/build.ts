// Build animation: every piece (a connected solid, so each plank of a shed) is thrown in rigid,
// tumbling, speeding up as it comes, slams into place with a small rebound and shakes the camera.
// Pieces land bottom-up, one after another. All on the GPU: each vertex (and each edge segment)
// carries its piece's pivot, start time, launch offset and spin; one shared uniform is the progress.
import * as THREE from "three";

/** Progress value meaning "not building": every piece is in place. */
export const BUILD_OFF = 2;

/** Share of a piece's time spent flying; the rest is the impact settling. */
export const BUILD_HIT = 0.55;

/** Shared by every part of one viewer. */
export type BuildUniforms = {
  buildT: { value: number };
  /** One piece's flight and settle, as a share of the whole timeline. */
  buildDur: { value: number };
};

export const makeBuildUniforms = (): BuildUniforms => ({
  buildT: { value: BUILD_OFF },
  buildDur: { value: 0.1 },
});

/** One piece's flight, in its part's coordinates. */
export type BuildPiece = {
  pivot: THREE.Vector3;
  /** Launch time, 0..1 of the timeline. */
  start: number;
  /** Where it's thrown from, relative to its place. */
  offset: THREE.Vector3;
  /** Spin it arrives with (axis × angle), undone by the impact. */
  spin: THREE.Vector3;
  /** How far it rebounds off the impact. */
  bounce: number;
};

const PARS = /* glsl */ `
uniform float buildT, buildDur;
attribute vec4 buildA; // pivot (xyz), start (w)
attribute vec4 buildB; // launch offset (xyz), rebound (w)
attribute vec3 buildC; // spin: axis × angle
vec3 buildRot(vec3 v, vec3 r) {
  float a = length(r);
  if (a < 1e-6) return v;
  vec3 k = r / a;
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
// flight left: 1 at launch, 0 on impact; already moving when it appears and accelerating in
float buildLeft(float t) {
  float f = clamp(t / ${BUILD_HIT.toFixed(3)}, 0.0, 1.0);
  return 1.0 - f * (0.25 + 0.75 * f);
}
vec3 buildMove(vec3 p, out float t) {
  t = (buildT - buildA.w) / buildDur;
  float left = buildLeft(t);
  vec3 q = buildA.xyz + buildRot(p - buildA.xyz, buildC * left) + buildB.xyz * left;
  // after the impact: kick back the way it came, dip past its place, settle
  float s = clamp((t - ${BUILD_HIT.toFixed(3)}) / ${(1 - BUILD_HIT).toFixed(3)}, 0.0, 1.0);
  float l = length(buildB.xyz);
  if (s > 0.0 && l > 0.0) q += buildB.xyz / l * buildB.w * sin(9.42478 * s) * exp(-4.5 * s);
  return q;
}
`;

// a primitive whose vertices all wait to launch is clipped away (beyond the far plane either way)
const HIDE = "if (bT <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);";

/**
 * Patch a material whose geometry carries buildA/B/C. `kind`: "mesh" for built-in or three-chunk
 * shaders (begin_vertex/project_vertex), "line" for LineMaterial (instanced segments).
 */
export function withBuild<T extends THREE.Material>(m: T, u: BuildUniforms, kind: "mesh" | "line"): T {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, u);
    let v = sh.vertexShader.replace("void main() {", `${PARS}\nvoid main() {`);
    if (kind === "mesh") {
      v = v
        // the spin turns the normals too, so a tumbling piece catches the light
        .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nobjectNormal = buildRot(objectNormal, buildC * buildLeft((buildT - buildA.w) / buildDur));")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nfloat bT;\ntransformed = buildMove(transformed, bT);")
        .replace("#include <project_vertex>", `#include <project_vertex>\n${HIDE}`);
    } else {
      v = v
        .replace("vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );", "float bT;\nvec4 start = modelViewMatrix * vec4( buildMove( instanceStart, bT ), 1.0 );")
        .replace("vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );", "float bT2;\nvec4 end = modelViewMatrix * vec4( buildMove( instanceEnd, bT2 ), 1.0 );")
        .replace("#include <fog_vertex>", `${HIDE}\n#include <fog_vertex>`);
    }
    sh.vertexShader = v;
  };
  m.customProgramCacheKey = () => `${prevKey()}+build:${kind}`;
  return m;
}

/** Write each piece's flight into the per-vertex (or per-segment) attributes. */
export function writeBuild(attrs: { a: THREE.BufferAttribute; b: THREE.BufferAttribute; c: THREE.BufferAttribute }, pieceOf: Int32Array, pieces: BuildPiece[]) {
  const A = attrs.a.array as Float32Array,
    B = attrs.b.array as Float32Array,
    C = attrs.c.array as Float32Array;
  for (let i = 0; i < pieceOf.length; i++) {
    const p = pieces[pieceOf[i]];
    if (!p) continue;
    A[i * 4] = p.pivot.x;
    A[i * 4 + 1] = p.pivot.y;
    A[i * 4 + 2] = p.pivot.z;
    A[i * 4 + 3] = p.start;
    B[i * 4] = p.offset.x;
    B[i * 4 + 1] = p.offset.y;
    B[i * 4 + 2] = p.offset.z;
    B[i * 4 + 3] = p.bounce;
    C[i * 3] = p.spin.x;
    C[i * 3 + 1] = p.spin.y;
    C[i * 3 + 2] = p.spin.z;
  }
  attrs.a.needsUpdate = attrs.b.needsUpdate = attrs.c.needsUpdate = true;
}

/**
 * Split a part into pieces: faces sharing an edge belong together; edges on no face (wires) form
 * pieces of their own. Returns the piece of each face and of each edge.
 */
export function findPieces(nFaces: number, nEdges: number, faceEdges: number[][]) {
  const up = new Int32Array(nFaces + nEdges).map((_, i) => i);
  const root = (i: number): number => {
    while (up[i] !== i) i = up[i] = up[up[i]];
    return i;
  };
  faceEdges.forEach((es, f) => {
    for (const e of es) if (e < nEdges) up[root(f)] = root(nFaces + e);
  });
  const ids = new Map<number, number>();
  const id = (i: number) => {
    const r = root(i);
    let k = ids.get(r);
    if (k === undefined) ids.set(r, (k = ids.size));
    return k;
  };
  const faces = Int32Array.from({ length: nFaces }, (_, f) => id(f));
  const edges = Int32Array.from({ length: nEdges }, (_, e) => id(nFaces + e));
  return { faces, edges, count: ids.size };
}

/** Cheap stable hash to 0..1. */
export const hash = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};
