// Planes and references (PLAN §5 v1 surface).
import type { Vec3 } from "@parasocial/kernel";
import { num, vec2, vec3, scriptError } from "./check";

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a);
  if (l < 1e-12) throw new Error("zero-length direction");
  return scale(a, 1 / l);
};

export type AxisLike = "X" | "Y" | "Z" | Vec3;
export const axisVec = (a: AxisLike, what = "axis"): Vec3 => {
  if (a === "X") return [1, 0, 0];
  if (a === "Y") return [0, 1, 0];
  if (a === "Z") return [0, 0, 1];
  if (typeof a === "string") scriptError(`${what} must be "X", "Y", "Z" or a vector [x, y, z] (got "${a}")`);
  const v = vec3(a, what);
  if (Math.hypot(...v) < 1e-12) scriptError(`${what} must be a non-zero direction (got [${v.join(", ")}])`);
  return unit(v);
};

/** A plane with a local 2D frame: u along `xDir`, v along `normal × xDir`. */
export class Plane {
  readonly origin: Vec3;
  readonly xDir: Vec3;
  readonly yDir: Vec3;
  readonly normal: Vec3;

  constructor(origin: Vec3, normal: Vec3, xDir?: Vec3) {
    origin = vec3(origin, "plane origin");
    const n = unit(vec3(normal, "plane normal"));
    let x = xDir ? unit(vec3(xDir, "plane x direction")) : Math.abs(n[2]) < 0.9 ? unit(cross([0, 0, 1], n)) : [1, 0, 0];
    // make x exactly perpendicular to n
    x = unit(add(x as Vec3, scale(n, -dot(x as Vec3, n))));
    this.origin = [...origin] as Vec3;
    this.normal = n;
    this.xDir = x as Vec3;
    this.yDir = cross(n, x as Vec3);
    Object.freeze(this);
  }

  /** Local 2D point -> world 3D point. */
  toWorld(p: readonly [number, number]): Vec3 {
    return add(this.origin, add(scale(this.xDir, p[0]), scale(this.yDir, p[1])));
  }

  /** World point -> local 2D point (projected). */
  toLocal(p: Vec3): [number, number] {
    const d: Vec3 = [p[0] - this.origin[0], p[1] - this.origin[1], p[2] - this.origin[2]];
    return [dot(d, this.xDir), dot(d, this.yDir)];
  }

  /** Parallel plane moved `d` along the normal. */
  offset(d: number): Plane {
    num(d, "plane offset");
    return new Plane(add(this.origin, scale(this.normal, d)), this.normal, this.xDir);
  }

  /** Same orientation, new origin (local 2D or world 3D). */
  at(p: readonly [number, number] | Vec3): Plane {
    const o = p?.length === 2 ? this.toWorld(vec2(p, "plane at")) : vec3(p, "plane at");
    return new Plane(o, this.normal, this.xDir);
  }

  /** Rotate the plane `angle` degrees about its local x (`"x"`) or y (`"y"`) axis. */
  rotated(angle: number, about: "x" | "y" = "x"): Plane {
    num(angle, "plane rotation angle");
    const a = (angle * Math.PI) / 180;
    const k = about === "x" ? this.xDir : this.yDir;
    const rot = (v: Vec3): Vec3 => add(add(scale(v, Math.cos(a)), scale(cross(k, v), Math.sin(a))), scale(k, dot(k, v) * (1 - Math.cos(a))));
    return new Plane(this.origin, rot(this.normal), rot(this.xDir));
  }

  /** Flip the normal (keeps x). */
  flipped(): Plane {
    return new Plane(this.origin, scale(this.normal, -1), this.xDir);
  }

  toJSON() {
    return { origin: this.origin, normal: this.normal, xDir: this.xDir };
  }
}

export const plane = Object.freeze({
  XY: new Plane([0, 0, 0], [0, 0, 1], [1, 0, 0]),
  XZ: new Plane([0, 0, 0], [0, -1, 0], [1, 0, 0]),
  YZ: new Plane([0, 0, 0], [1, 0, 0], [0, 1, 0]),
  /** Aliases: top = XY, front = XZ, right = YZ. */
  top: new Plane([0, 0, 0], [0, 0, 1], [1, 0, 0]),
  front: new Plane([0, 0, 0], [0, -1, 0], [1, 0, 0]),
  right: new Plane([0, 0, 0], [1, 0, 0], [0, 1, 0]),
  /** A plane through `origin` with `normal` (and optional x direction). */
  at: (origin: Vec3, normal: AxisLike = "Z", xDir?: AxisLike) => new Plane(vec3(origin, "plane.at origin"), axisVec(normal, "plane.at normal"), xDir ? axisVec(xDir, "plane.at x direction") : undefined),
  /** Offset a plane along its normal. */
  offset: (p: Plane, d: number) => p.offset(d),
  /** Plane through three points (normal by the right-hand rule a->b->c). */
  threePoint: (a: Vec3, b: Vec3, c: Vec3) => {
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return new Plane(a, cross(ab, ac), ab);
  },
  /** Rotate `p` by `angle` degrees about its local x or y axis. */
  angle: (p: Plane, angle: number, about: "x" | "y" = "x") => p.rotated(angle, about),
});

export const vec = { cross, dot, add, scale, unit };
