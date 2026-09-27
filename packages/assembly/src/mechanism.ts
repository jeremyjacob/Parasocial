// The assembly solver. Every joint's variables are 0 in the "home" pose, where each body sits at
// its home transform (the identity for a part used where it's modeled; a copy placed elsewhere has
// its own). A body's transform T maps its part's own coordinates to the world. A joint relates two
// bodies through a frame on each (in that body's part coordinates; the frames coincide at home):
// moving the joint by q moves b relative to a by M(q) expressed in those frames, so
//
//   T_b = T_a · F_a · M(q) · F_b⁻¹
//
// Unknowns are the joint variables. A spanning tree from the fixed parts turns most joints into
// forward kinematics; joints that close a loop become 6-D residuals the solver drives to zero.
// Dragging adds a soft goal (a point on the grabbed part follows the cursor) and a small pull
// toward the previous values, so only free degrees of freedom move and the mechanism stays on
// its current branch. Damped least squares (Levenberg–Marquardt) with a numerical Jacobian;
// every step is clamped to the joints' limits.
import { DEG, compose, expRot, framePose, identity, inverse, logRot, applyPoint, norm, sub, type Frame, type Pose, type Vec3 } from "./pose";
import { rank, solveSPD } from "./linalg";

export type JointType = "fastened" | "revolute" | "slider" | "cylindrical" | "planar" | "ball";
export type Range = { min?: number; max?: number };

/** Variables per joint type, and their kind (angles in degrees, lengths in mm). */
export const JOINT_VARS: Record<JointType, readonly ("angle" | "length")[]> = {
  fastened: [],
  revolute: ["angle"],
  slider: ["length"],
  cylindrical: ["angle", "length"],
  planar: ["length", "length", "angle"],
  ball: ["angle", "angle", "angle"],
};

export type JointSpec = {
  /** Stable key: persisted values are stored under it. */
  name: string;
  type: JointType;
  a: string;
  b: string;
  /** The joint frame in home (world) coordinates: z is the axis (revolute, slider, cylindrical) or the normal (planar). */
  frame?: Frame;
  /** Or the frame on each body, in its part's own coordinates (they coincide at home). */
  frames?: { a: Frame; b: Frame };
  /** Per variable; null or missing = free. */
  limits?: (Range | null | undefined)[];
  /** Starting values (default 0, clamped into the limits). */
  value?: number[];
};

export type MechanismSpec = {
  joints: JointSpec[];
  /** Parts that never move. Each connected group without one keeps its first part still. */
  fixed?: string[];
  /** Where bodies sit with every joint at 0 (default: the identity, where the part is modeled). Bodies listed here without joints stay put. */
  home?: Record<string, Pose>;
  /** Characteristic length (mm): weighs rotation residuals against translations. Default 50. */
  scale?: number;
};

/** The relative motion of a joint in its own frame. */
export function motion(type: JointType, q: ArrayLike<number>, o = 0): Pose {
  switch (type) {
    case "fastened":
      return identity();
    case "revolute":
      return { r: expRot([0, 0, q[o] * DEG]), t: [0, 0, 0] };
    case "slider":
      return { r: identity().r, t: [0, 0, q[o]] };
    case "cylindrical":
      return { r: expRot([0, 0, q[o] * DEG]), t: [0, 0, q[o + 1]] };
    case "planar":
      return { r: expRot([0, 0, q[o + 2] * DEG]), t: [q[o], q[o + 1], 0] };
    case "ball":
      return { r: expRot([q[o] * DEG, q[o + 1] * DEG, q[o + 2] * DEG]), t: [0, 0, 0] };
  }
}

type Joint = JointSpec & { Fa: Pose; Fb: Pose; FaInv: Pose; FbInv: Pose; off: number; n: number; lo: number[]; hi: number[] };
type Link = { body: string; parent: string; joint: Joint; forward: boolean };

export class Mechanism {
  readonly bodies: string[];
  readonly fixed: Set<string>;
  readonly joints: Joint[];
  /** Joint variables, all joints concatenated. */
  x: Float64Array;
  private links: Link[] = [];
  private loops: Joint[] = [];
  private L: number;
  private home: Map<string, Pose>;

  constructor(spec: MechanismSpec) {
    this.L = spec.scale && spec.scale > 0 ? spec.scale : 50;
    this.home = new Map(Object.entries(spec.home ?? {}));
    const homeOf = (b: string) => this.home.get(b) ?? identity();
    let off = 0;
    this.joints = spec.joints.map((j) => {
      const n = JOINT_VARS[j.type].length;
      let Fa: Pose, Fb: Pose;
      if (j.frames) (Fa = framePose(j.frames.a)), (Fb = framePose(j.frames.b));
      else if (j.frame) {
        const F = framePose(j.frame);
        Fa = compose(inverse(homeOf(j.a)), F);
        Fb = compose(inverse(homeOf(j.b)), F);
      } else throw new Error(`joint "${j.name}": give frame or frames`);
      const lo = [...Array(n)].map((_, i) => j.limits?.[i]?.min ?? -Infinity);
      const hi = [...Array(n)].map((_, i) => j.limits?.[i]?.max ?? Infinity);
      const joint = { ...j, Fa, Fb, FaInv: inverse(Fa), FbInv: inverse(Fb), off, n, lo, hi };
      off += n;
      return joint;
    });
    this.x = new Float64Array(off);
    for (const j of this.joints) for (let i = 0; i < j.n; i++) this.x[j.off + i] = clamp(j.value?.[i] ?? 0, j.lo[i], j.hi[i]);

    const bodies: string[] = [];
    for (const j of this.joints) for (const p of [j.a, j.b]) if (!bodies.includes(p)) bodies.push(p);
    for (const p of this.home.keys()) if (!bodies.includes(p)) bodies.push(p);
    this.bodies = bodies;
    // connected groups; each needs something fixed
    const adj = new Map<string, { joint: Joint; other: string }[]>(bodies.map((b) => [b, []]));
    for (const j of this.joints) {
      adj.get(j.a)!.push({ joint: j, other: j.b });
      adj.get(j.b)!.push({ joint: j, other: j.a });
    }
    this.fixed = new Set((spec.fixed ?? []).filter((p) => adj.has(p)));
    const group = new Map<string, number>();
    let g = 0;
    for (const b of bodies) {
      if (group.has(b)) continue;
      const stack = [b];
      group.set(b, g);
      const members = [b];
      while (stack.length) for (const { other } of adj.get(stack.pop()!)!) if (!group.has(other)) group.set(other, g), stack.push(other), members.push(other);
      if (!members.some((m) => this.fixed.has(m))) this.fixed.add(members[0]);
      g++;
    }
    // spanning tree from the fixed parts (breadth first: short chains, fewer compounded errors)
    const seen = new Set(this.fixed);
    const used = new Set<Joint>();
    const queue = [...this.fixed];
    while (queue.length) {
      const p = queue.shift()!;
      for (const { joint, other } of adj.get(p)!) {
        if (seen.has(other) || used.has(joint)) continue;
        seen.add(other);
        used.add(joint);
        this.links.push({ body: other, parent: p, joint, forward: joint.a === p });
        queue.push(other);
      }
    }
    this.loops = this.joints.filter((j) => !used.has(j));
  }

  /** Every body's transform (its part's coordinates to the world) for variables `x`. */
  poses(x: ArrayLike<number> = this.x): Map<string, Pose> {
    const out = new Map<string, Pose>();
    for (const f of this.fixed) out.set(f, this.home.get(f) ?? identity());
    for (const { body, parent, joint: j, forward } of this.links) {
      const M = motion(j.type, x, j.off);
      // forward: T_b = T_a · F_a · M · F_b⁻¹; backward: T_a = T_b · F_b · M⁻¹ · F_a⁻¹
      out.set(body, forward ? compose(out.get(parent)!, compose(j.Fa, compose(M, j.FbInv))) : compose(out.get(parent)!, compose(j.Fb, compose(inverse(M), j.FaInv))));
    }
    return out;
  }

  /** Loop-closure residuals (6 per loop joint: rotation scaled by the characteristic length, then translation). */
  private loopResiduals(poses: Map<string, Pose>, x: ArrayLike<number>, out: number[]) {
    for (const j of this.loops) {
      const E = compose(j.FaInv, compose(inverse(poses.get(j.a)!), compose(poses.get(j.b)!, j.Fb)));
      const D = compose(inverse(motion(j.type, x, j.off)), E);
      const w = logRot(D.r);
      out.push(w[0] * this.L, w[1] * this.L, w[2] * this.L, D.t[0], D.t[1], D.t[2]);
    }
  }

  /** Largest loop-closure error (mm-ish): 0 when every joint is satisfied. */
  error(x: ArrayLike<number> = this.x): number {
    const r: number[] = [];
    this.loopResiduals(this.poses(x), x, r);
    return r.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  }

  private clampInto(x: Float64Array) {
    for (const j of this.joints) for (let i = 0; i < j.n; i++) x[j.off + i] = clamp(x[j.off + i], j.lo[i], j.hi[i]);
  }

  /**
   * Levenberg–Marquardt on residual(x). Returns the improved x (clamped to limits).
   */
  private leastSquares(x0: Float64Array, residual: (x: Float64Array) => number[], iterations = 30): Float64Array {
    const n = x0.length;
    let x = new Float64Array(x0);
    if (!n) return x;
    let r = residual(x);
    let cost = sumSq(r);
    let mu = 1e-3;
    for (let it = 0; it < iterations && cost > 1e-18; it++) {
      const m = r.length;
      const J = jacobian(residual, x, r);
      const A = new Float64Array(n * n);
      const g = new Float64Array(n);
      for (let a = 0; a < n; a++) {
        for (let b = a; b < n; b++) {
          let s = 0;
          for (let k = 0; k < m; k++) s += J[k * n + a] * J[k * n + b];
          A[a * n + b] = A[b * n + a] = s;
        }
        let s = 0;
        for (let k = 0; k < m; k++) s += J[k * n + a] * r[k];
        g[a] = -s;
      }
      let accepted = false;
      for (let tries = 0; tries < 8 && !accepted; tries++) {
        const D = new Float64Array(A);
        for (let a = 0; a < n; a++) D[a * n + a] += mu * (A[a * n + a] + 1e-6);
        const step = solveSPD(D, g, n);
        if (!step) {
          mu *= 10;
          continue;
        }
        const xn = new Float64Array(n);
        for (let a = 0; a < n; a++) xn[a] = x[a] + step[a];
        this.clampInto(xn);
        const rn = residual(xn);
        const cn = sumSq(rn);
        if (cn < cost) {
          const moved = Math.max(...xn.map((v, a) => Math.abs(v - x[a])));
          x = xn;
          r = rn;
          const rel = (cost - cn) / cost;
          cost = cn;
          mu = Math.max(mu / 3, 1e-9);
          accepted = true;
          if (moved < 1e-9 || rel < 1e-10) return x;
        } else mu *= 4;
      }
      if (!accepted) break;
    }
    return x;
  }

  /** Pull x back onto the loop constraints (minimum change): damped Gauss–Newton. */
  private project(x: Float64Array): Float64Array {
    if (!this.loops.length) return x;
    const residual = (y: Float64Array) => {
      const r: number[] = [];
      this.loopResiduals(this.poses(y), y, r);
      return r;
    };
    return this.leastSquares(x, (y) => {
      const r = residual(y);
      // a whisper of regularization picks the nearest solution when the loops leave freedom
      for (let i = 0; i < y.length; i++) r.push((y[i] - x[i]) * 1e-4);
      return r;
    }, 50);
  }

  /** Satisfy the loop joints, starting from (and staying near) the current values. Returns the remaining error. */
  settle(): number {
    this.x = this.project(new Float64Array(this.x));
    return this.error();
  }

  /**
   * Drag: move `body` so the point `local` (its part's coordinates) follows `target`
   * (world), within the joints. Returns true if anything moved.
   */
  drag(body: string, local: Vec3, target: Vec3): boolean {
    if (this.fixed.has(body) || !this.bodies.includes(body)) return false;
    const x0 = new Float64Array(this.x);
    const scaleOf = (i: number) => (this.kindOf(i) === "angle" ? this.L * DEG : 1);
    const residual = (y: Float64Array) => {
      const poses = this.poses(y);
      const r: number[] = [];
      this.loopResiduals(poses, y, r);
      for (let i = 0; i < r.length; i++) r[i] *= 30;
      const p = applyPoint(poses.get(body)!, local);
      r.push(p[0] - target[0], p[1] - target[1], p[2] - target[2]);
      // stay near where we were: free directions the goal doesn't care about don't wander
      for (let i = 0; i < y.length; i++) r.push((y[i] - x0[i]) * scaleOf(i) * 0.003);
      return r;
    };
    let x = this.leastSquares(x0, residual, 25);
    x = this.project(x);
    const moved = x.some((v, i) => Math.abs(v - x0[i]) > 1e-9);
    this.x = x;
    return moved;
  }

  private kindOf(i: number) {
    for (const j of this.joints) if (i >= j.off && i < j.off + j.n) return JOINT_VARS[j.type][i - j.off];
    return "length";
  }

  /** Remaining degrees of freedom (joint variables not pinned down by closed loops). */
  dof(): number {
    const n = this.x.length;
    if (!this.loops.length) return n;
    const residual = (y: Float64Array) => {
      const r: number[] = [];
      this.loopResiduals(this.poses(y), y, r);
      return r;
    };
    const r = residual(this.x);
    return n - rank(jacobian(residual, this.x, r), r.length, n, 1e-6);
  }

  /**
   * The joints that drive the mechanism: in declaration order, each joint whose variables add a
   * degree of freedom the earlier ones don't already set. In a closed loop, the first joint drives
   * and the rest follow; joints with no variables (fastened) never drive.
   */
  drivers(): string[] {
    const n = this.x.length;
    const loopRes = (y: Float64Array) => {
      const r: number[] = [];
      this.loopResiduals(this.poses(y), y, r);
      return r;
    };
    const r0 = loopRes(this.x);
    const rows: number[][] = [];
    const J = jacobian(loopRes, this.x, r0);
    for (let k = 0; k < r0.length; k++) rows.push([...J.subarray(k * n, (k + 1) * n)]);
    const rankOf = (rs: number[][]) => (rs.length ? rank(Float64Array.from(rs.flat()), rs.length, n, 1e-6) : 0);
    let have = rankOf(rows);
    const out: string[] = [];
    for (const j of this.joints) {
      let drives = false;
      for (let i = 0; i < j.n; i++) {
        const e = new Array(n).fill(0);
        e[j.off + i] = 1;
        rows.push(e);
        const r = rankOf(rows);
        if (r > have) (have = r), (drives = true);
        else rows.pop();
      }
      if (drives) out.push(j.name);
    }
    return out;
  }

  /** Can dragging move this part at all (not fixed, and some freedom reaches it)? */
  movable(body: string): boolean {
    if (this.fixed.has(body) || !this.bodies.includes(body)) return false;
    const n = this.x.length;
    if (!n) return false;
    const L = this.L;
    const pts: Vec3[] = [
      [0, 0, 0],
      [L, 0, 0],
      [0, L, 0],
    ];
    const bodyRes = (y: Float64Array) => {
      const T = this.poses(y).get(body)!;
      return pts.flatMap((p) => applyPoint(T, p));
    };
    const loopRes = (y: Float64Array) => {
      const r: number[] = [];
      this.loopResiduals(this.poses(y), y, r);
      return r;
    };
    const rl = loopRes(this.x);
    const rb = bodyRes(this.x);
    const Jl = jacobian(loopRes, this.x, rl);
    const Jb = jacobian(bodyRes, this.x, rb);
    const both = new Float64Array(Jl.length + Jb.length);
    both.set(Jl);
    both.set(Jb, Jl.length);
    return rank(both, rl.length + rb.length, n, 1e-6) > rank(Jl, rl.length, n, 1e-6);
  }

  /** Values per joint name (only joints with variables). */
  values(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const j of this.joints) if (j.n) out[j.name] = [...this.x.subarray(j.off, j.off + j.n)].map((v) => +v.toFixed(6));
    return out;
  }

  /** Set values by joint name (unknown names and wrong arities are ignored), then settle. */
  setValues(v: Record<string, number[] | undefined>): number {
    for (const j of this.joints) {
      const q = v[j.name];
      if (!Array.isArray(q) || q.length !== j.n) continue;
      for (let i = 0; i < j.n; i++) if (Number.isFinite(q[i])) this.x[j.off + i] = clamp(q[i], j.lo[i], j.hi[i]);
    }
    return this.settle();
  }

  /** Distance moved by `body`'s point `local` between two variable vectors (tests, diagnostics). */
  pointAt(body: string, local: Vec3, x: ArrayLike<number> = this.x): Vec3 {
    return applyPoint(this.poses(x).get(body) ?? identity(), local);
  }
}

function jacobian(f: (x: Float64Array) => number[], x: Float64Array, r0: number[]): Float64Array {
  const n = x.length,
    m = r0.length;
  const J = new Float64Array(m * n);
  const y = new Float64Array(x);
  for (let i = 0; i < n; i++) {
    const h = 1e-6 * Math.max(1, Math.abs(x[i]));
    y[i] = x[i] + h;
    const r = f(y);
    for (let k = 0; k < m; k++) J[k * n + i] = (r[k] - r0[k]) / h;
    y[i] = x[i];
  }
  return J;
}

const sumSq = (r: number[]) => r.reduce((s, v) => s + v * v, 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const distance = (a: Vec3, b: Vec3) => norm(sub(a, b));
