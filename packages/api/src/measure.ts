// In-script evaluation (FeatureScript's evDistance / evVolume / ...): measure solids, selections and
// points inside a part body, so design rules can be checked where the geometry is made:
//
//   const gap = measure.minClearance(drum, frame);
//   check(gap >= 2, `drum must clear the frame by 2 mm (has ${gap.toFixed(2)} mm)`);
//
// Results are memoized on the op records they read, which live in the per-op cache: an unchanged
// solid is not re-measured on the next regeneration. Measuring never creates an operation, so it
// can't shift op ids or cache keys, and the same geometry always gives the same numbers.
import { compound, distance as kDistance, pointDistance, massProps, linearProps, surfaceProps, boundingBox as kBBox, booleanMany, scoped, type Vec3, type Shape } from "@parasocial/kernel";
import { entityShape, vertexOf, type OpRecord } from "@parasocial/naming";
import { ctx, shortLoc } from "./context";
import { OpError, userError } from "./op";
import { Solid } from "./solid";
import { EntitySet } from "./selection";

/** Something to measure: a solid, a selection of faces / edges / vertices, or a point `[x, y, z]`. */
export type Measurable = Solid | EntitySet | Vec3;

export type BoundingBox = { min: Vec3; max: Vec3; size: Vec3; center: Vec3 };
export type Closest = { distance: number; a: Vec3; b: Vec3 };

const memo = new WeakMap<OpRecord, Map<string, unknown>>();
function cached<T>(rec: OpRecord | undefined, key: string, fn: () => T): T {
  if (!rec) return fn();
  let m = memo.get(rec);
  if (!m) memo.set(rec, (m = new Map()));
  if (m.has(key)) return m.get(key) as T;
  const v = fn();
  m.set(key, v);
  return v;
}

const isPoint = (x: unknown): x is Vec3 => Array.isArray(x) && x.length === 3 && x.every((c) => typeof c === "number" && Number.isFinite(c));

function check3(x: unknown, what: string, arg: string): Measurable {
  if (x instanceof Solid || x instanceof EntitySet || isPoint(x)) return x;
  return userError(`measure.${what}(${arg}): expected a solid, a selection like part.faces(">Z") or a point [x, y, z] (got ${describe(x)})`);
}

function describe(x: unknown): string {
  if (x === undefined) return "nothing";
  if (Array.isArray(x)) return `[${x.join(", ")}]`;
  return typeof x === "object" ? (x?.constructor?.name ?? "an object") : JSON.stringify(x);
}

/** Record + stable key of a measurable (records come from the per-op cache, so keys outlive one regeneration). */
function keyOf(x: Measurable): { rec?: OpRecord; key: string } {
  if (x instanceof Solid) return { rec: x.record, key: `s:${x.record.key}` };
  if (x instanceof EntitySet) return { rec: x.record, key: `e:${x.record.key}:${x.kind}:${x.indices.join(",")}` };
  return { key: `p:${x.join(",")}` };
}

/** Run `fn` with the shape of `x` (a compound for several entities, released afterwards). */
function withShape<T>(x: Solid | EntitySet, fn: (s: Shape) => T): T {
  if (x instanceof Solid) return fn(x.record.shape);
  if (!x.length) userError(`measure: the ${x.kind} selection is empty${x.query ? ` (selector "${x.query}")` : ""}`);
  if (x.indices.length === 1) return fn(entityShape(x.record, x.kind, x.indices[0]));
  return scoped(() => {
    const c = compound(x.indices.map((i) => entityShape(x.record, x.kind, i)));
    try {
      return fn(c);
    } finally {
      c.delete();
    }
  });
}

function closest(a: Measurable, b: Measurable): Closest {
  if (isPoint(a) && isPoint(b)) return { distance: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), a: [...a] as Vec3, b: [...b] as Vec3 };
  if (isPoint(a)) {
    const r = closest(b, a);
    return { distance: r.distance, a: r.b, b: r.a };
  }
  const ka = keyOf(a), kb = keyOf(b);
  return cached(ka.rec, `closest|${ka.key}|${kb.key}`, () =>
    withShape(a, (sa) => {
      if (isPoint(b)) return pointDistance(sa, b);
      return withShape(b, (sb) => kDistance(sa, sb));
    }),
  );
}

/** Minimum distance between two solids, selections or points (0 when they touch or overlap). */
function distance(a: Measurable, b: Measurable): number {
  return closest(check3(a, "distance", "a, b"), check3(b, "distance", "a, b")).distance;
}

/**
 * Smallest gap between two solids (or selections): 0 when they touch or one overlaps the other.
 * Use `measure.overlap` to tell touching from interfering.
 */
function minClearance(a: Solid | EntitySet, b: Solid | EntitySet): number {
  for (const [x, n] of [[a, "a"], [b, "b"]] as const) if (!(x instanceof Solid || x instanceof EntitySet)) userError(`measure.minClearance(a, b): ${n} must be a solid or a selection (got ${describe(x)})`);
  return closest(a, b).distance;
}

/** Volume of the region two solids share (0 when they only touch or are apart): interference. */
function overlap(a: Solid, b: Solid): number {
  for (const [x, n] of [[a, "a"], [b, "b"]] as const) if (!(x instanceof Solid)) userError(`measure.overlap(a, b): ${n} must be a solid (got ${describe(x)})`);
  return cached(a.record, `overlap|${b.record.key}`, () =>
    scoped(() => {
      // cheap reject: disjoint bounding boxes can't overlap
      const ba = kBBox(a.record.shape, { geometric: true }), bb = kBBox(b.record.shape, { geometric: true });
      for (let i = 0; i < 3; i++) if (ba.max[i] < bb.min[i] || bb.max[i] < ba.min[i]) return 0;
      const built = booleanMany("intersect", a.record.shape, [b.record.shape]);
      built.maker?.delete?.();
      try {
        return Math.max(0, massProps(built.shape).volume);
      } finally {
        built.shape.delete();
      }
    }),
  );
}

/** Volume of a solid (mm³). */
function volume(x: Solid): number {
  if (!(x instanceof Solid)) userError(`measure.volume(x): x must be a solid (got ${describe(x)}); for faces use measure.area`);
  return cached(x.record, "mass", () => massProps(x.record.shape)).volume;
}

/** Surface area (mm²) of a solid, or the total area of a face selection. */
function area(x: Solid | EntitySet): number {
  if (x instanceof EntitySet && x.kind !== "face") userError(`measure.area(x): x must be a solid or faces (got ${x.kind}s); for edges use measure.length`);
  if (!(x instanceof Solid || x instanceof EntitySet)) userError(`measure.area(x): x must be a solid or a face selection (got ${describe(x)})`);
  const k = keyOf(x);
  return cached(k.rec, `area|${k.key}`, () => withShape(x, (s) => surfaceProps(s).area));
}

/** Total length (mm) of an edge selection. */
function length(x: EntitySet): number {
  if (!(x instanceof EntitySet) || x.kind !== "edge") userError(`measure.length(x): x must be an edge selection like part.edges("%circle") (got ${x instanceof EntitySet ? x.kind + "s" : describe(x)})`);
  const k = keyOf(x);
  return cached(k.rec, `length|${k.key}`, () => withShape(x, (s) => linearProps(s).length));
}

/** Axis-aligned bounding box of a solid, a selection or a list of points, with its size and center. */
function boundingBox(x: Solid | EntitySet | Vec3[]): BoundingBox {
  let min: Vec3, max: Vec3;
  if (Array.isArray(x)) {
    if (!x.length || !x.every(isPoint)) userError(`measure.boundingBox(points): expected a non-empty list of [x, y, z] points`);
    min = [0, 1, 2].map((i) => Math.min(...x.map((p) => p[i]))) as Vec3;
    max = [0, 1, 2].map((i) => Math.max(...x.map((p) => p[i]))) as Vec3;
  } else {
    if (!(x instanceof Solid || x instanceof EntitySet)) userError(`measure.boundingBox(x): x must be a solid or a selection (got ${describe(x)})`);
    const k = keyOf(x);
    ({ min, max } = cached(k.rec, `bbox|${k.key}`, () => withShape(x, (s) => tightBox(s))));
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
}

/**
 * From the geometry, not the display mesh (so it never depends on whether the part was meshed yet),
 * without tolerance padding: a 10 mm cube measures 10 mm. Freeform faces give a conservative box.
 */
function tightBox(s: Shape): { min: Vec3; max: Vec3 } {
  return kBBox(s, { geometric: true });
}

/**
 * Center of mass: of the volume for a solid, of the area for faces, of the length for edges,
 * the average for vertices.
 */
function centroid(x: Solid | EntitySet): Vec3 {
  if (!(x instanceof Solid || x instanceof EntitySet)) userError(`measure.centroid(x): x must be a solid or a selection (got ${describe(x)})`);
  if (x instanceof Solid) return cached(x.record, "mass", () => massProps(x.record.shape)).centroid;
  const k = keyOf(x);
  return cached(k.rec, `centroid|${k.key}`, (): Vec3 => {
    if (x.kind === "vertex") {
      const ps = x.indices.map((i) => vertexOf(x.record, i));
      if (!ps.length) userError("measure.centroid: the vertex selection is empty");
      return [0, 1, 2].map((c) => ps.reduce((s, p) => s + p[c], 0) / ps.length) as Vec3;
    }
    return withShape(x, (s) => (x.kind === "face" ? surfaceProps(s) : linearProps(s)).centroid);
  });
}

type MeasureFn = {
  /** Distance between two solids or selections, with the closest points on each (same as `measure.closest`). */
  (a: Solid | EntitySet, b: Solid | EntitySet): Closest;
  /** Minimum distance (mm) between solids, selections or points: 0 when they touch or overlap. */
  distance: typeof distance;
  /** Minimum distance and the closest point on each. */
  closest(a: Measurable, b: Measurable): Closest;
  minClearance: typeof minClearance;
  overlap: typeof overlap;
  volume: typeof volume;
  area: typeof area;
  length: typeof length;
  boundingBox: typeof boundingBox;
  centroid: typeof centroid;
};

/**
 * Measure inside a part body (FeatureScript's ev* functions). Call it as `measure(a, b)` for the
 * distance and closest points, or use the named measurements:
 * `measure.distance(a, b)`, `measure.minClearance(a, b)`, `measure.overlap(a, b)`,
 * `measure.volume(solid)`, `measure.area(solid | faces)`, `measure.length(edges)`,
 * `measure.boundingBox(x)`, `measure.centroid(x)`. Pair with `check(...)` for design rules.
 * @example check(measure.minClearance(body, lid) >= 1, "lid must clear the body by 1 mm")
 */
export const measure: MeasureFn = (() => {
  const fn = (a: Solid | EntitySet, b: Solid | EntitySet) => closest(check3(a, "closest", "a, b"), check3(b, "closest", "a, b"));
  const members = {
    distance,
    closest: (a: Measurable, b: Measurable) => closest(check3(a, "closest", "a, b"), check3(b, "closest", "a, b")),
    minClearance,
    overlap,
    volume,
    area,
    length, // shadows Function.prototype.length (configurable, so defineProperty can replace it)
    boundingBox,
    centroid,
  };
  for (const [k, v] of Object.entries(members)) Object.defineProperty(fn, k, { value: v, enumerable: true });
  return Object.freeze(fn) as unknown as MeasureFn;
})();

/**
 * A design rule: when `condition` is false the part fails with `message` and the script line of this
 * call (the viewport keeps the last good geometry). Say what's wrong and by how much.
 * @example check(measure.minClearance(body, lid) >= 2, `lid needs 2 mm clearance to the body`)
 */
export function check(condition: unknown, message: string): void {
  if (condition) return;
  const c = ctx();
  const site = c.frames()[0];
  const loc = shortLoc(site);
  const text = `design rule failed: ${typeof message === "string" && message ? message : "check(condition, message) was false"}${loc ? ` (${loc})` : ""}`;
  throw new OpError(text, { severity: "error", kind: "rule", message: text, part: c.part, source: site && { file: site.file, line: site.line, col: site.col } });
}
