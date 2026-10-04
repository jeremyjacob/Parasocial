// Planes and references (PLAN §5 v1 surface).
/**
 * @module plane — plane conventions. World axes are fixed (Z up, mm). A sketch point `[u, v]` lands at
 * `origin + u·xDir + v·yDir`; positive extrusions and `offset(d)` go along the normal.
 *
 *   plane          u (1st) →   v (2nd) →   normal / extrude +   offset(5) is
 *   XY  (top)      +X          +Y          +Z                   z = 5
 *   XZ  (front)    +X          +Z          −Y  (!)              y = −5
 *   YZ  (right)    +Y          +Z          +X                   x = 5
 *   XZ.flipped()   +X          −Z          +Y                   y = 5
 *   at(o, "X")     +Y          +Z          +X
 *   at(o, "Y")     −X          +Z          +Y
 *   at(o, "Z")     +X          +Y          +Z
 *
 * So `sketch(plane.XZ).rect(20, 10, { center: false }).extrude(3)` spans x 0..20, z 0..10, y −3..0;
 * use `extrude(-3)` or `plane.XZ.flipped()` to grow toward +Y. `symmetric: true` extrudes half each
 * way. `revolve()` defaults to the sketch's v axis through its origin (world Z for XZ and YZ).
 * `p.at([u, v])` or `p.at([x, y, z])` moves the origin (`plane.XZ.at([0, 20, 0])` sketches at y = 20,
 * no `offset(-20)` sign juggling); `p.rotated(deg, "x" | "y")` tilts about its own
 * axes (`plane.XY.rotated(90)` equals `plane.XZ`); `plane.threePoint(a, b, c)` has u along a→b and
 * normal by the right-hand rule. Solid.mirror("XZ") mirrors y → −y regardless of these normals.
 */
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

/** A world direction: `"X"`, `"Y"`, `"Z"` (positive axes) or a vector like `[0, -1, 0]` or `[1, 1, 0]` (normalized for you). */
export type AxisLike = "X" | "Y" | "Z" | Vec3;
/** @internal */
export const axisVec = (a: AxisLike, what = "axis"): Vec3 => {
  if (a === "X") return [1, 0, 0];
  if (a === "Y") return [0, 1, 0];
  if (a === "Z") return [0, 0, 1];
  if (typeof a === "string") scriptError(`${what} must be "X", "Y", "Z" or a vector [x, y, z] (got "${a}")`);
  const v = vec3(a, what);
  if (Math.hypot(...v) < 1e-12) scriptError(`${what} must be a non-zero direction (got [${v.join(", ")}])`);
  return unit(v);
};

/**
 * A plane with a local 2D frame for sketching: a sketch point `[u, v]` lands at
 * `origin + u·xDir + v·yDir`, with `yDir = normal × xDir`; positive extrusions go along `normal`.
 * `plane.XY` sketches [x, y] (normal +Z), `plane.XZ` [x, z] (normal **−Y**), `plane.YZ` [y, z] (normal +X).
 * @example sketch(plane.XZ).rect(20, 10, { center: false }).extrude(3) // x 0..20, z 0..10, y −3..0
 */
export class Plane {
  /** World point of the sketch origin `[0, 0]`. */
  readonly origin: Vec3;
  /** World direction of the sketch's +u (first coordinate). */
  readonly xDir: Vec3;
  /** World direction of the sketch's +v (second coordinate): `normal × xDir`. */
  readonly yDir: Vec3;
  /** Unit normal: positive extrusions and `offset(d)` move this way. */
  readonly normal: Vec3;

  /**
   * Plane through `origin` with `normal`. `xDir` (projected onto the plane) sets the sketch's +u;
   * when omitted it is `Z × normal` (horizontal), or +X when the normal is near ±Z.
   */
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

  /**
   * Parallel plane moved `d` along the normal (same sketch axes). Mind the normal's sign:
   * `plane.XY.offset(5)` is z = 5, `plane.YZ.offset(5)` is x = 5, but `plane.XZ.offset(5)` is y = −5.
   */
  offset(d: number): Plane {
    num(d, "plane offset");
    return new Plane(add(this.origin, scale(this.normal, d)), this.normal, this.xDir);
  }

  /** Same orientation, new origin: a sketch point `[u, v]` on this plane, or a world point `[x, y, z]` (`plane.XZ.at([0, y, 0])`: the XZ plane at world y). */
  at(p: readonly [number, number] | Vec3): Plane {
    const o = p?.length === 2 ? this.toWorld(vec2(p, "plane at")) : vec3(p, "plane at");
    return new Plane(o, this.normal, this.xDir);
  }

  /**
   * Rotate the plane `angle` degrees (right-hand rule) about its own x (`"x"`, default) or y axis,
   * through its origin. `plane.XY.rotated(90)` has the same frame as `plane.XZ` (normal −Y).
   */
  rotated(angle: number, about: "x" | "y" = "x"): Plane {
    num(angle, "plane rotation angle");
    const a = (angle * Math.PI) / 180;
    const k = about === "x" ? this.xDir : this.yDir;
    const rot = (v: Vec3): Vec3 => add(add(scale(v, Math.cos(a)), scale(cross(k, v), Math.sin(a))), scale(k, dot(k, v) * (1 - Math.cos(a))));
    return new Plane(this.origin, rot(this.normal), rot(this.xDir));
  }

  /** Flip the normal, keeping xDir (so yDir flips too): `plane.XZ.flipped()` has normal +Y and sketches `[x, −z]`. */
  flipped(): Plane {
    return new Plane(this.origin, scale(this.normal, -1), this.xDir);
  }

  toJSON() {
    return { origin: this.origin, normal: this.normal, xDir: this.xDir };
  }
}

/**
 * Sketch planes (conventions in the `plane` topic): `XY` [x, y] normal +Z, `XZ` [x, z] normal −Y, `YZ` [y, z] normal +X.
 * @example sketch(plane.XY.offset(10)).circle([0, 0], 5).extrude(2) // a disc from z = 10 to 12
 */
export const plane = Object.freeze({
  /** Top plane: sketch `[u, v]` → world `[u, v, 0]` (x, y); normal +Z (extrudes up). */
  XY: new Plane([0, 0, 0], [0, 0, 1], [1, 0, 0]),
  /** Front plane: sketch `[u, v]` → world `[u, 0, v]` (x, z); normal −Y, so extrusions grow toward −Y and `offset(d)` moves to y = −d. Use `.flipped()` (sketches `[x, −z]`) or `extrude(-d)` to go toward +Y. */
  XZ: new Plane([0, 0, 0], [0, -1, 0], [1, 0, 0]),
  /** Right plane: sketch `[u, v]` → world `[0, u, v]` (y, z); normal +X. */
  YZ: new Plane([0, 0, 0], [1, 0, 0], [0, 1, 0]),
  /** Alias of `plane.XY` (normal +Z). */
  top: new Plane([0, 0, 0], [0, 0, 1], [1, 0, 0]),
  /** Alias of `plane.XZ` (sketches `[x, z]`, normal −Y). */
  front: new Plane([0, 0, 0], [0, -1, 0], [1, 0, 0]),
  /** Alias of `plane.YZ` (sketches `[y, z]`, normal +X). */
  right: new Plane([0, 0, 0], [1, 0, 0], [0, 1, 0]),
  /**
   * A plane through `origin` with `normal` (default "Z") and optional sketch x direction. Without
   * `xDir`, u is horizontal (`Z × normal`) and v points up: `plane.at(o, "X")` sketches `[y, z]`,
   * `plane.at(o, "Y")` sketches `[−x, z]` (unlike `plane.XZ`), `plane.at(o, "Z")` sketches `[x, y]`.
   * @example sketch(plane.at([0, 0, 20], "Z")).rect(10, 10).extrude(5) // z 20..25
   */
  at: (origin: Vec3, normal: AxisLike = "Z", xDir?: AxisLike) => new Plane(vec3(origin, "plane.at origin"), axisVec(normal, "plane.at normal"), xDir ? axisVec(xDir, "plane.at x direction") : undefined),
  /** Offset a plane along its normal: `plane.offset(plane.XY, 5)` is z = 5 (same as `plane.XY.offset(5)`; for `plane.XZ` it's y = −5). */
  offset: (p: Plane, d: number) => p.offset(d),
  /** Plane through three points (normal by the right-hand rule a->b->c). */
  threePoint: (a: Vec3, b: Vec3, c: Vec3) => {
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return new Plane(a, cross(ab, ac), ab);
  },
  /** Rotate `p` by `angle` degrees about its local x (default) or y axis, like `p.rotated(angle, about)`. */
  angle: (p: Plane, angle: number, about: "x" | "y" = "x") => p.rotated(angle, about),
});

/** @internal */
export const vec = { cross, dot, add, scale, unit };
