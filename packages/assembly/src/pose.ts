// Rigid transforms: a 3×3 rotation (row-major) and a translation. Plain arrays, no three.js, so
// the solver runs anywhere (engine, app, tests).

export type Vec3 = [number, number, number];
export type Pose = { r: number[]; t: Vec3 };
/** A coordinate frame: origin plus orthonormal x and z axes (y = z × x). */
export type Frame = { origin: Vec3; x: Vec3; z: Vec3 };

export const DEG = Math.PI / 180;

export const identity = (): Pose => ({ r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

export function compose(a: Pose, b: Pose): Pose {
  const A = a.r,
    B = b.r;
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return { r, t: add(apply3(A, b.t), a.t) };
}

export function inverse(a: Pose): Pose {
  const R = a.r;
  const r = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const t = apply3(r, a.t);
  return { r, t: [-t[0], -t[1], -t[2]] };
}

export const applyPoint = (p: Pose, v: Vec3): Vec3 => add(apply3(p.r, v), p.t);
export const applyDir = (p: Pose, v: Vec3): Vec3 => apply3(p.r, v);

function apply3(r: number[], v: Vec3): Vec3 {
  return [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: Vec3): Vec3 {
  const l = norm(a);
  return l < 1e-15 ? [0, 0, 0] : scale(a, 1 / l);
}

/** Rotation about a unit axis by `angle` radians (Rodrigues). */
export function rotation(axis: Vec3, angle: number): number[] {
  const [x, y, z] = axis;
  const c = Math.cos(angle),
    s = Math.sin(angle),
    k = 1 - c;
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
}

/** Rotation from a rotation vector (axis × angle, radians). */
export function expRot(v: Vec3): number[] {
  const a = norm(v);
  return a < 1e-15 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : rotation(scale(v, 1 / a), a);
}

/** Rotation vector (axis × angle, radians) of a rotation matrix; the inverse of expRot. */
export function logRot(r: number[]): Vec3 {
  const cos = Math.min(1, Math.max(-1, (r[0] + r[4] + r[8] - 1) / 2));
  const angle = Math.acos(cos);
  const w: Vec3 = [r[7] - r[5], r[2] - r[6], r[3] - r[1]];
  if (angle < 1e-7) return scale(w, 0.5);
  if (Math.PI - angle > 1e-4) return scale(w, angle / (2 * Math.sin(angle)));
  // near a half turn the antisymmetric part vanishes: read the axis off the diagonal
  const d = [r[0], r[4], r[8]];
  const i = d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2;
  const axis: Vec3 = [0, 0, 0];
  axis[i] = Math.sqrt(Math.max(0, (d[i] + 1) / 2));
  const j = (i + 1) % 3,
    k = (i + 2) % 3;
  axis[j] = (r[j * 3 + i] + r[i * 3 + j]) / (4 * axis[i]);
  axis[k] = (r[k * 3 + i] + r[i * 3 + k]) / (4 * axis[i]);
  // the sign of the axis follows the (small) antisymmetric part
  const n = normalize(axis);
  return scale(dot(n, w) < 0 ? scale(n, -1) : n, angle);
}

/** A frame as a pose: frame coordinates -> world. */
export function framePose(f: Frame): Pose {
  const z = normalize(f.z);
  // make x exactly perpendicular to z
  let x = normalize(sub(f.x, scale(z, dot(f.x, z))));
  if (norm(x) < 0.5) x = normalize(Math.abs(z[2]) < 0.9 ? cross([0, 0, 1], z) : cross(z, [1, 0, 0]));
  const y = cross(z, x);
  return { r: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], t: [...f.origin] as Vec3 };
}

/** Column-major 4×4 (three.js `Matrix4.fromArray`, WebGL). */
export function toMatrix(p: Pose): number[] {
  const r = p.r;
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, p.t[0], p.t[1], p.t[2], 1];
}

export function fromMatrix(m: ArrayLike<number>): Pose {
  return { r: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]], t: [m[12], m[13], m[14]] };
}

export const isIdentity = (p: Pose, eps = 1e-9) => p.r.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < eps) && p.t.every((v) => Math.abs(v) < eps);
