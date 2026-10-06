// Build animation: every piece (a connected solid, so each plank of a shed) pops into existence
// and is thrown in rigid, tumbling, speeding up as it comes, slams into place with a small rebound
// and shakes the camera.
// Heavy pieces (by volume) fly faster, rebound less and hit harder. Pieces land inside-out, one
// sub-assembly at a time. All on the GPU: each vertex (and each edge segment) carries its piece's
// pivot, timing, launch offset and spin; one shared uniform is the progress.
import * as THREE from "three";

/** Progress value meaning "not building": every piece is in place. */
export const BUILD_OFF = 2;

/** Share of a piece's time spent flying; the rest is the impact settling. */
export const BUILD_HIT = 0.55;

/** Shared by every part of one viewer. */
export type BuildUniforms = {
  buildT: { value: number };
};

export const makeBuildUniforms = (): BuildUniforms => ({
  buildT: { value: BUILD_OFF },
});

/** One piece's flight, in its part's coordinates. */
export type BuildPiece = {
  pivot: THREE.Vector3;
  /** Launch time, 0..1 of the timeline. */
  start: number;
  /** Flight and settle, as a share of the timeline. */
  dur: number;
  /** Where it's thrown from, relative to its place. */
  offset: THREE.Vector3;
  /** Spin it arrives with (axis × angle), undone by the impact. */
  spin: THREE.Vector3;
  /** How far it rebounds off the impact. */
  bounce: number;
};

const PARS = /* glsl */ `
uniform float buildT;
attribute vec4 buildA; // pivot (xyz), start (w)
attribute vec4 buildB; // launch offset (xyz), rebound (w)
attribute vec4 buildC; // spin: axis × angle (xyz), duration (w)
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
  t = (buildT - buildA.w) / buildC.w;
  float left = buildLeft(t);
  // pops into existence at launch: grows from its pivot over the first moments of the flight
  float g = 1.0 - pow(1.0 - clamp(t / 0.16, 0.0, 1.0), 3.0);
  vec3 q = buildA.xyz + buildRot((p - buildA.xyz) * g, buildC.xyz * left) + buildB.xyz * left;
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
        .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nobjectNormal = buildRot(objectNormal, buildC.xyz * buildLeft((buildT - buildA.w) / buildC.w));")
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
    C[i * 4] = p.spin.x;
    C[i * 4 + 1] = p.spin.y;
    C[i * 4 + 2] = p.spin.z;
    C[i * 4 + 3] = p.dur;
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

/**
 * Each piece's volume, from its triangles (divergence theorem); a piece that isn't closed (a
 * sheet, a wire) gets a sliver of its bounding box.
 */
export function pieceVolumes(positions: Float32Array, indices: Uint32Array, vertPiece: Int32Array, boxes: THREE.Box3[]) {
  const vol = new Float64Array(boxes.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [positions[a], positions[a + 1], positions[a + 2], positions[b], positions[b + 1], positions[b + 2], positions[c], positions[c + 1], positions[c + 2]];
    vol[vertPiece[indices[i]]] += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  const s = new THREE.Vector3();
  return boxes.map((b, k) => {
    if (b.isEmpty()) return 0;
    b.getSize(s);
    const boxVol = Math.max(s.x, 1e-6) * Math.max(s.y, 1e-6) * Math.max(s.z, 1e-6);
    const v = Math.abs(vol[k]);
    return v > boxVol * 1e-4 ? Math.min(v, boxVol) : boxVol * 0.05;
  });
}

/** A level of the assembly hierarchy: its own pieces and its sub-assemblies. */
export type OrderNode<T> = { pieces: { item: T; box: THREE.Box3; vol: number }[]; kids: OrderNode<T>[] };

/** Extra beats (s) in the build: after a sub-assembly is done, before the housings close it up, before the last piece. */
export const PAUSE = { group: 0.4, cover: 0.35, last: 0.3 };

const boxVol = (b: THREE.Box3, pad: number) => (b.max.x - b.min.x + 2 * pad) * (b.max.y - b.min.y + 2 * pad) * (b.max.z - b.min.z + 2 * pad);

/**
 * Build order, inside-out through the hierarchy: a sub-assembly builds in one go. Within a level,
 * when most of an item's pieces lie inside a much bigger item's bounds: a hollow one (a housing, a
 * cup) waits for what it holds, except small things reaching its walls (screws, inserts, a button
 * poking through) that are fastened on after; a solid one goes first and what's in it after. Of what's free to go, ordinary pieces before covers
 * (hollow ones enclosing something, or big hollow shells), then those reaching least far from the
 * level's centre, then bottom-up. `pause` is an extra beat (s) before that piece lands.
 */
export function buildOrder<T>(root: OrderNode<T>): { item: T; pause: number }[] {
  type Bounds = { box: THREE.Box3; vol: number; boxes: THREE.Box3[] };
  type Item = Bounds & { piece?: T; kid?: OrderNode<T> };
  const out: { item: T; pause: number }[] = [];
  let pending = 0;
  const bounds = new Map<OrderNode<T>, Bounds>();
  const measure = (nd: OrderNode<T>) => {
    const m: Bounds = { box: new THREE.Box3(), vol: 0, boxes: [] };
    for (const q of nd.pieces) m.box.union(q.box), (m.vol += q.vol), m.boxes.push(q.box);
    for (const k of nd.kids) {
      const km = measure(k);
      m.box.union(km.box), (m.vol += km.vol), m.boxes.push(...km.boxes);
    }
    bounds.set(nd, m);
    return m;
  };
  measure(root);
  const level = (nd: OrderNode<T>) => {
    const { box } = bounds.get(nd)!;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-9);
    const pad = r * 0.01;
    const items: Item[] = [
      ...nd.pieces.map((q) => ({ box: q.box, vol: q.vol, boxes: [q.box], piece: q.item })),
      ...nd.kids.filter((k) => !bounds.get(k)!.box.isEmpty()).map((k) => ({ ...bounds.get(k)!, kid: k })),
    ];
    const bv = items.map((it) => boxVol(it.box, pad));
    const padded = items.map((it) => it.box.clone().expandByScalar(pad));
    const levelVol = boxVol(box, pad);
    const hollow = items.map((it, a) => it.vol < 0.4 * bv[a]);
    // an item's biggest piece, and how much of its pieces' bounds lie inside each other item's
    const biggest = items.map((it) => Math.max(...it.boxes.map((b) => boxVol(b, pad))));
    const x = new THREE.Box3();
    const share = (a: number, b: number) => {
      let inside = 0,
        all = 0;
      for (const q of items[b].boxes) {
        all += boxVol(q, pad);
        x.copy(q).expandByScalar(pad).intersect(padded[a]);
        if (!x.isEmpty()) inside += boxVol(x, 0);
      }
      return inside / Math.max(all, 1e-30);
    };
    // a small part reaching a's walls: a fastener (or a set of them), not something a holds; a
    // sub-assembly never is
    const fastener = (a: number, b: number) => {
      if (items[b].kid?.kids.length || biggest[b] >= 0.03 * bv[a]) return false;
      const A = items[a].box;
      return items[b].boxes.some((q) =>
        (["x", "y", "z"] as const).some((k) => {
          const m = 0.08 * (A.max[k] - A.min[k]) + pad;
          return q.min[k] <= A.min[k] + m || q.max[k] >= A.max[k] - m;
        }),
      );
    };
    // before[a]: the items that land before a
    const before = items.map((): number[] => []);
    const encloses = items.map(() => false);
    items.forEach((_, a) =>
      items.forEach((_, b) => {
        if (a === b || bv[a] < 1.5 * biggest[b] || share(a, b) < 0.6) return;
        if (hollow[a] && !fastener(a, b)) before[a].push(b), (encloses[a] = true);
        else before[b].push(a);
      }),
    );
    const cover = items.map((_, a) => encloses[a] || (hollow[a] && bv[a] >= 0.2 * levelVol));
    const corner = new THREE.Vector3();
    const reach = items.map(({ box: b }) => {
      let m = 0;
      for (let i = 0; i < 8; i++) m = Math.max(m, corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).distanceTo(c));
      return Math.round((m / r) * 10);
    });
    const done = new Set<number>();
    let covering = false;
    while (done.size < items.length) {
      let best = -1;
      for (let a = 0; a < items.length; a++) {
        if (done.has(a) || before[a].some((b) => !done.has(b))) continue;
        if (best < 0) best = a;
        else {
          const A = items[a].box,
            B = items[best].box;
          const d = +cover[a] - +cover[best] || reach[a] - reach[best] || A.min.z - B.min.z || A.min.x - B.min.x || A.min.y - B.min.y;
          if (d < 0) best = a;
        }
      }
      // mixed hollow and solid nesting can tie a knot: then take the next one regardless
      if (best < 0) best = items.findIndex((_, a) => !done.has(a));
      done.add(best);
      if (cover[best] && !covering && out.length) pending = Math.max(pending, PAUSE.cover);
      covering ||= cover[best];
      const it = items[best];
      if (it.kid) {
        level(it.kid);
        pending = Math.max(pending, PAUSE.group);
      } else {
        out.push({ item: it.piece!, pause: out.length ? pending : 0 });
        pending = 0;
      }
    }
  };
  level(root);
  if (out.length > 2) out[out.length - 1].pause = Math.max(out[out.length - 1].pause, PAUSE.last);
  return out;
}

/** Cheap stable hash to 0..1. */
export const hash = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};
