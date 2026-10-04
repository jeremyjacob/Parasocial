// Standard parts as solids: screws, nuts, washers, heat-set inserts, ball bearings, retaining
// rings and MGN linear guides. Simplified (no threads, balls or knurls) but dimensionally true
// where it matters for fit: diameters, heights, hole positions. Each item is built along +Z with
// connectors whose z axis is +Z, so `revolute(a.at("x"), item.at("bore"))` mates it (pass
// `{ flip: true }` to face the other way). Screws and inserts take their hole's `at` / `direction`
// (PlaceOpts) to land in it without a hand-worked rotation.
import type { Vec3 } from "@parasocial/kernel";
import { userError } from "../op";
import { Plane, axisVec, vec, type AxisLike } from "../plane";
import { plane } from "../plane";
import { num, vec3 } from "../check";
import { sketch } from "../sketch";
import { box, type Solid } from "../solid";
import { freeTag } from "./holes";
import { BEARINGS, DIN471, DIN472, HEADS, INSERTS, METRIC, MGN_CARRIAGES, MGN_RAILS, NUTS, WASHERS, type BearingSize, type CirclipStandard, type HeadStandard, type InsertSize, type MetricSize, type MgnCarriageSize, type MgnRailSize } from "./tables";

type TagOpt = { tag?: string };
/**
 * Where a screw or insert goes, with the same arguments as its `.hole(points, spec)`: `at` the
 * hole's point on the surface, `direction` into the material (default −Z, as for `.hole`), `inset`
 * how far below the surface it seats (default 0; in a counterbore, the head height plus `headDepth`,
 * e.g. `std.tables.heads.ISO4762.M3.k`). The spin about the axis is arbitrary.
 */
export type PlaceOpts = { at?: Vec3; direction?: AxisLike; inset?: number };

const STEEL = { color: "#a9afb6", metalness: 0.85, roughness: 0.35 };
const BLACK_OXIDE = { color: "#3b3e43", metalness: 0.6, roughness: 0.45 };
const BRASS = { color: "#c8a24a", metalness: 0.9, roughness: 0.3 };

const finish = (s: Solid, look: typeof STEEL, mat: string) => s.material(mat).appearance(look);
const hexR = (af: number) => af / Math.sqrt(3);

function metric(size: MetricSize, what: string) {
  const m = METRIC[size];
  if (!m) userError(`${what}: unknown size "${size}"; use one of ${Object.keys(METRIC).join(", ")}`);
  return m;
}
function lookup<T>(table: Readonly<Record<string, T>>, key: string | number, what: string): T {
  const v = table[key as string];
  if (!v) userError(`${what}: unknown size "${key}"; use one of ${Object.keys(table).join(", ")}`);
  return v;
}
/** Turn an item built down −Z from the origin so −Z runs along `direction`, from `at` (+ `inset`). */
function place(s: Solid, o: PlaceOpts, what: string): Solid {
  if (o.at === undefined && o.direction === undefined && o.inset === undefined) return s;
  const d = axisVec(o.direction ?? ([0, 0, -1] as Vec3), `${what} direction`);
  const at = vec.add(o.at === undefined ? [0, 0, 0] : vec3(o.at, `${what} at`), vec.scale(d, o.inset === undefined ? 0 : num(o.inset, `${what} inset`)));
  // −Z onto d: about −Z × d (about X when d is +Z)
  const c = -d[2];
  if (c < 1 - 1e-12) s = s.rotate((Math.acos(Math.max(-1, c)) * 180) / Math.PI, { axis: c > -1 + 1e-12 ? vec.cross([0, 0, -1], d) : "X" });
  return at.some((v) => v !== 0) ? s.translate(at) : s;
}

function positive(v: number, what: string) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) userError(`${what} must be a positive number (got ${v})`);
}

/**
 * A socket screw, `size` × `length` (mm, under the head; ISO 10642: overall). Head on top: the
 * bearing face under the head (top of the head for ISO 10642, which sits flush) is at z = 0 and the
 * shank runs down to z = −length. `standard`: "ISO4762" socket head cap (default), "ISO7380" button
 * head, "ISO10642" countersunk. Connectors: `head` (the seat, z = 0; mates with a hole's
 * `connector`), `top` (top of the head), `tip`. Give it its hole's point and direction (`at`,
 * `direction`, `inset`: see `PlaceOpts`) and it sits in the hole: seat on `at`, shank along `direction`.
 * @example std.screw("M3", 10, { at: [20, 0, 5], direction: [-1, 0, 0] }) // for body.hole([20, 0, 5], { screw: "M3", direction: [-1, 0, 0] })
 */
export function screw(size: MetricSize, length: number, opts: TagOpt & PlaceOpts & { standard?: HeadStandard } = {}): Solid {
  const std = opts.standard ?? "ISO4762";
  const m = metric(size, "screw");
  positive(length, "screw length");
  const heads = HEADS[std] ?? userError(`screw standard must be "ISO4762", "ISO7380" or "ISO10642" (got ${JSON.stringify(std)})`);
  const h = heads[size] ?? userError(`${std} has no ${size}; sizes: ${Object.keys(heads).join(", ")}`);
  const r = m.d / 2,
    R = h.dk / 2;
  const T = opts.tag ?? freeTag(`${size}x${length}-${std}`, ["-socket"]);
  const sk = sketch(plane.XZ, { tag: T }).moveTo([0, -length]).lineTo([r, -length], { tag: "tip" });
  let top: number;
  if (std === "ISO10642") {
    if (length <= h.k) userError(`ISO10642 ${size} length ${length} must exceed the head height ${h.k}`);
    sk.lineTo([r, -(R - r)], { tag: "shank" }).lineTo([R, 0], { tag: "head" }).lineTo([0, 0], { tag: "top" });
    top = 0;
  } else if (std === "ISO7380") {
    // flat rim then a spherical dome, tangent-flat on the axis
    const e = 0.2 * h.k;
    const c = (h.k * h.k - e * e - R * R) / (2 * (h.k - e));
    const rad = h.k - c;
    const a = (Math.atan2(e - c, R) + Math.PI / 2) / 2;
    sk.lineTo([r, 0], { tag: "shank" }).lineTo([R, 0], { tag: "underhead" }).lineTo([R, e], { tag: "head" }).threePointArc([rad * Math.cos(a), c + rad * Math.sin(a)], [0, h.k], { tag: "top" });
    top = h.k;
  } else {
    sk.lineTo([r, 0], { tag: "shank" }).lineTo([R, 0], { tag: "underhead" }).lineTo([R, h.k], { tag: "head" }).lineTo([0, h.k], { tag: "top" });
    top = h.k;
  }
  const body = sk.close().revolve(360, { tag: T });
  const socket = sketch(new Plane([0, 0, top], [0, 0, -1]), { tag: `${T}-socket` }).polygon([0, 0], hexR(h.s), 6).extrude(h.t, { tag: `${T}-socket` });
  const s = finish(body.subtract(socket), std === "ISO4762" ? BLACK_OXIDE : STEEL, "steel")
    .connector("head", { origin: [0, 0, 0] })
    .connector("top", { origin: [0, 0, top] })
    .connector("tip", { origin: [0, 0, -length] });
  return place(s, opts, "screw");
}

/** An ISO 4032 hex nut from z = 0 to its height m, flats parallel to X. Connectors: `bottom`, `top`. */
export function nut(size: MetricSize, opts: TagOpt = {}): Solid {
  const m = metric(size, "nut");
  const n = NUTS[size];
  const T = opts.tag ?? freeTag(`nut-${size}`);
  const s = sketch(plane.XY).polygon([0, 0], hexR(n.s), 6).circle([0, 0], m.d / 2).extrude(n.m, { tag: T });
  return finish(s, STEEL, "steel").connector("bottom", { origin: [0, 0, 0] }).connector("top", { origin: [0, 0, n.m] });
}

/** An ISO 7089 plain washer from z = 0 to its thickness. Connectors: `bottom`, `top`. */
export function washer(size: MetricSize, opts: TagOpt = {}): Solid {
  metric(size, "washer");
  const w = WASHERS[size];
  const T = opts.tag ?? freeTag(`washer-${size}`);
  const s = sketch(plane.XY).circle([0, 0], w.d2 / 2).circle([0, 0], w.d1 / 2).extrude(w.h, { tag: T });
  return finish(s, STEEL, "steel").connector("bottom", { origin: [0, 0, 0] }).connector("top", { origin: [0, 0, w.h] });
}

/**
 * A heat-set insert ("M3x5.7", Ruthex / CNC Kitchen sizes), top at z = 0, body down to −length,
 * with a plain bore of the thread size. Modeled as installed: the body is the recommended hole
 * diameter (the knurl, `std.tables.inserts[size].od`, melts into the plastic), so an insert in its
 * own `.hole(pts, { insert })` isn't interference, while one in a smaller hole or a wall still is.
 * Give it its hole's point and direction (`at`, `direction`: see `PlaceOpts`) and it sits in the
 * hole, flush. Connectors: `top`, `bottom`.
 * @example std.insert("M3x5.7", { at: [10, 0, 10] }) // for body.hole([10, 0, 10], { insert: "M3x5.7" })
 */
export function insert(size: InsertSize, opts: TagOpt & PlaceOpts = {}): Solid {
  const i = lookup(INSERTS, size, "insert");
  const T = opts.tag ?? freeTag(`insert-${size}`);
  const s = sketch(new Plane([0, 0, 0], [0, 0, -1])).circle([0, 0], i.hole / 2).circle([0, 0], i.d / 2).extrude(i.l, { tag: T });
  return place(finish(s, BRASS, "brass").connector("top", { origin: [0, 0, 0] }).connector("bottom", { origin: [0, 0, -i.l] }), opts, "insert");
}

/**
 * A deep-groove ball bearing ("608", "625", "6001", "6802", "MR105", ...) on the Z axis from z = 0
 * to its width B: outer and inner rings with recessed shields between them. Dimensions in
 * `std.tables.bearings`. Connectors: `bore` (axis, mid-width), `back` (z = 0), `face` (z = B).
 */
export function bearing(size: BearingSize, opts: TagOpt = {}): Solid {
  const b = lookup(BEARINGS, size, "bearing");
  const T = opts.tag ?? freeTag(`bearing-${size}`);
  const { ri, ro, rec } = bearingRings(b);
  const prof: [number, number][] = [
    [b.d / 2, 0],
    [ri, 0],
    [ri, rec],
    [ro, rec],
    [ro, 0],
    [b.D / 2, 0],
    [b.D / 2, b.B],
    [ro, b.B],
    [ro, b.B - rec],
    [ri, b.B - rec],
    [ri, b.B],
    [b.d / 2, b.B],
  ];
  // a path, not a polyline: faces keep their `<T>/line<n>` names
  const s = prof.slice(1).reduce((k, q) => k.lineTo(q), sketch(plane.XZ, { tag: T }).moveTo(prof[0])).close().revolve(360, { tag: T });
  return finish(s, STEEL, "steel")
    .connector("bore", { origin: [0, 0, b.B / 2] })
    .connector("back", { origin: [0, 0, 0] })
    .connector("face", { origin: [0, 0, b.B] });
}

/** @internal Ring radii and shield recess of the simplified bearing. */
export function bearingRings(b: { d: number; D: number; B: number }) {
  const t = (b.D - b.d) / 2;
  return { ri: b.d / 2 + 0.3 * t, ro: b.D / 2 - 0.3 * t, rec: Math.min(0.3, 0.06 * b.B) };
}

function circlipData(standard: CirclipStandard, d: number, what: string) {
  if (standard !== "DIN471" && standard !== "DIN472") userError(`${what}: standard must be "DIN471" (shaft) or "DIN472" (bore) (got ${JSON.stringify(standard)})`);
  return lookup(standard === "DIN471" ? DIN471 : DIN472, d, `${what} ${standard}`);
}

/**
 * A retaining ring as installed: "DIN471" for a shaft of diameter `d` (ring inside diameter = the
 * groove diameter), "DIN472" for a bore (ring outside diameter = the groove diameter). Simplified
 * to a split ring of the table's thickness and radial width (no lugs), on the Z axis centered at
 * z = 0. Connector: `groove` (center). Cut its groove with `std.circlipGroove`.
 */
export function circlip(standard: CirclipStandard, d: number, opts: TagOpt = {}): Solid {
  const c = circlipData(standard, d, "circlip");
  const T = opts.tag ?? freeTag(`${standard}-${d}`, ["-gap"]);
  const [rin, rout] = standard === "DIN471" ? [c.d2 / 2, c.d2 / 2 + c.b] : [c.d2 / 2 - c.b, c.d2 / 2];
  const ring = sketch(plane.XY.offset(-c.s / 2)).circle([0, 0], rout).circle([0, 0], rin).extrude(c.s, { tag: T });
  const gap = box(Math.max(c.b, rin * 0.5), rout + 1, c.s + 2, { center: true, tag: `${T}-gap` }).translate([0, -(rout + 1) / 2, 0]);
  return finish(ring.subtract(gap), BLACK_OXIDE, "steel").connector("groove", { origin: [0, 0, 0] });
}

/**
 * The groove for a retaining ring, as a solid to subtract: `shaft.subtract(std.circlipGroove("DIN471",
 * 8, { at: [0, 0, 20] }))`. Centered on `at` (default origin) along `axis` (default Z), the table's
 * groove width `m` wide, cut down to the groove diameter d2 (DIN 471, shafts) or out to it (DIN 472,
 * bores). Connector: `groove` (center, along the axis).
 */
export function circlipGroove(standard: CirclipStandard, d: number, opts: TagOpt & { at?: Vec3; axis?: AxisLike } = {}): Solid {
  const c = circlipData(standard, d, "circlipGroove");
  const at = opts.at ?? [0, 0, 0];
  const ax = axisVec(opts.axis ?? "Z");
  const T = opts.tag ?? freeTag(`${standard}-${d}-groove`);
  const extra = Math.max(1, d * 0.1);
  const [rin, rout] = standard === "DIN471" ? [c.d2 / 2, d / 2 + extra] : [Math.max(0.1, d / 2 - extra), c.d2 / 2];
  const s = sketch(new Plane(at, ax)).circle([0, 0], rout).circle([0, 0], rin).extrude(c.m, { symmetric: true, tag: T });
  return s.connector("groove", { origin: at, axis: ax });
}

/**
 * An MGN miniature linear rail ("MGN7" | "MGN9" | "MGN12" | "MGN15"), `length` long along X,
 * centered on the origin, bottom at z = 0, with counterbored bolt holes at the standard pitch,
 * spaced evenly from both ends (simplified profile: no ball grooves). Connectors: `carriage` (rail
 * bottom center, axis X: a slider for `std.mgnCarriage`'s `rail`), `bottom` (mounting face, +Z),
 * `bolt` (one per hole, at the counterbore floor, +Z; mates with a screw's `head`).
 */
export function mgnRail(size: MgnRailSize, length: number, opts: TagOpt & { holes?: boolean } = {}): Solid {
  const r = lookup(MGN_RAILS, size, "mgnRail");
  positive(length, "rail length");
  const T = opts.tag ?? freeTag(`${size}-rail-${length}`, ["-bolt", "-bolt-cut", "-bolt1"]);
  let s = box(length, r.wr, r.hr, { center: "xy", tag: T });
  const pts = opts.holes === false ? [] : mgnRailHoles(size, length).map((x): Vec3 => [x, 0, r.hr]);
  if (pts.length) s = s.hole(pts, r.d, { counterbore: { diameter: r.D, depth: r.h }, tag: `${T}-bolt` });
  s = finish(s, STEEL, "steel").connector("carriage", { origin: [0, 0, 0], axis: "X" }).connector("bottom", { origin: [0, 0, 0] });
  return pts.length ? s.connector("bolt", pts.map((p) => ({ origin: [p[0], 0, r.hr - r.h] as Vec3 }))) : s;
}

/**
 * `std.mgnRailHoles(size, length)`: x positions of `std.mgnRail(size, length)`'s bolt holes (rail centered on the origin): as many as
 * fit at the pitch, centered, ends at least D/2 + 1. Use it to drill the matching holes in a base.
 */
export function mgnRailHoles(size: MgnRailSize, length: number): number[] {
  const r = lookup(MGN_RAILS, size, "mgnRailHoles");
  const emin = r.D / 2 + 1;
  if (length < 2 * emin) return [];
  const n = Math.floor((length - 2 * emin) / r.pitch + 1e-9) + 1;
  return [...Array(n)].map((_, i) => (i - (n - 1) / 2) * r.pitch);
}

/**
 * An MGN carriage ("MGN12H", "MGN9C", ...; C standard, H long) sitting on its rail as modeled by
 * `std.mgnRail` (rail along X, bottom at z = 0), centered on the origin: steel body, end seals,
 * a channel over the rail and four tapped mounting holes (B × C, at the thread's nominal diameter, so
 * screws in them don't show as collisions). Connectors: `rail` (rail bottom
 * center, axis X), `top` (mounting face, +Z), `bolt` (four tapped holes on top, +Z).
 */
export function mgnCarriage(size: MgnCarriageSize, opts: TagOpt = {}): Solid {
  const c = lookup(MGN_CARRIAGES, size, "mgnCarriage");
  const r = MGN_RAILS[c.rail];
  const T = opts.tag ?? freeTag(`${size}-carriage`, ["-seals", "-channel", "-mount", "-mount-cut", "-mount1"]);
  const h = c.H - c.H1;
  const body = box(c.L1, c.W, h, { center: "xy", tag: T }).translate([0, 0, c.H1]);
  const seals = box(c.L, c.W - 1, h - 0.6, { center: "xy", tag: `${T}-seals` }).translate([0, 0, c.H1 + 0.3]);
  const channel = box(c.L + 2, r.wr + 0.2, r.hr + 0.1 - c.H1 + 1, { center: "xy", tag: `${T}-channel` }).translate([0, 0, c.H1 - 1]);
  const pts: Vec3[] = [
    [-c.C / 2, -c.B / 2, c.H],
    [c.C / 2, -c.B / 2, c.H],
    [-c.C / 2, c.B / 2, c.H],
    [c.C / 2, c.B / 2, c.H],
  ];
  const s = body
    .union(seals)
    .subtract(channel)
    // threads are shown at their nominal diameter, so mating screws don't read as collisions
    .hole(pts, METRIC[c.screw].d, { depth: c.depth, tag: `${T}-mount` });
  return finish(s, STEEL, "steel")
    .connector("rail", { origin: [0, 0, 0], axis: "X" })
    .connector("top", { origin: [0, 0, c.H] })
    .connector("bolt", pts.map((p) => ({ origin: p })));
}

