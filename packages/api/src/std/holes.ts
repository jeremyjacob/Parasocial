// Standard holes: clearance / tapped / insert holes, counterbores and countersinks for standard
// heads, and hex nut traps, resolved from the tables in ./tables.
import type { Vec3 } from "@parasocial/kernel";
import { userError } from "../op";
import { ctx } from "../context";
import { Plane, axisVec, vec, type AxisLike } from "../plane";
import { sketch } from "../sketch";
import type { Solid } from "../solid";
import { HEADS, INSERTS, METRIC, NUTS, type InsertSize, type MetricSize } from "./tables";

/**
 * A hole by standard, for `solid.hole(points, spec)`:
 * - `{ screw: "M3" }` clearance hole (ISO 273 `fit`: "close" | "normal" (default) | "loose"), or
 *   `fit: "tap"` for the tap drill;
 * - `counterbore: "ISO4762" | "ISO7380"` sinks the screw head flush (plus `headDepth`);
 * - `countersink: "ISO10642"` a 90° countersink for a flush countersunk head (plus `headDepth`);
 * - `{ insert: "M3x5.7" }` a heat-set insert hole (recommended diameter, insert length + 1 deep).
 *
 * `std.screw` / `std.insert` given the same point and direction (`{ at, direction }`) sit in the hole.
 *
 * `depth` omitted = through all (inserts: blind). `connector` names a connector with one frame per
 * hole at the screw's seat (under-head face for counterbores, the surface otherwise), its axis
 * pointing out of the part, so `std.screw(...).at("head")` mates straight in.
 */
export type HoleSpec = {
  screw?: MetricSize;
  fit?: "close" | "normal" | "loose" | "tap";
  counterbore?: "ISO4762" | "ISO7380";
  countersink?: "ISO10642";
  insert?: InsertSize;
  /** Hole depth from the surface (default: through all; inserts: insert length + 1). */
  depth?: number;
  /** Extra depth to sink the head below flush (counterbore/countersink), default 0. */
  headDepth?: number;
  /** Drill direction (default −Z, into the part). */
  direction?: AxisLike;
  /** Add a connector with a frame at each hole's seat. */
  connector?: string;
  tag?: string;
};

/** @internal Plain hole parameters a spec resolves to (what `hole(points, d, opts)` takes). */
export type ResolvedHole = {
  diameter: number;
  depth?: number;
  counterbore?: { diameter: number; depth: number };
  countersink?: { diameter: number; angle?: number; recess?: number };
  /** Distance below the surface where the screw head seats. */
  seat: number;
  label: string;
};

const SIZES = Object.keys(METRIC).join(", ");

/** @internal */
export function resolveHole(spec: HoleSpec): ResolvedHole {
  if (!spec || typeof spec !== "object") userError(`hole spec must be an object like { screw: "M3", counterbore: "ISO4762" }`);
  for (const k of Object.keys(spec)) if (!["screw", "fit", "counterbore", "countersink", "insert", "depth", "headDepth", "direction", "connector", "tag"].includes(k)) userError(`hole spec has no "${k}"; use screw, fit, counterbore, countersink, insert, depth, headDepth, direction, connector or tag`);
  const sink = spec.headDepth ?? 0;
  if (spec.insert !== undefined) {
    const ins = INSERTS[spec.insert];
    if (!ins) userError(`unknown insert "${spec.insert}"; use one of ${Object.keys(INSERTS).join(", ")}`);
    if (spec.counterbore || spec.countersink || spec.screw) userError(`hole spec: insert holes take no screw, counterbore or countersink`);
    return { diameter: ins.hole, depth: spec.depth ?? ins.l + 1, seat: 0, label: `insert-${spec.insert}` };
  }
  const size = spec.screw;
  if (!size) userError(`hole spec needs a screw size ({ screw: "M3" }) or an insert ({ insert: "M3x5.7" })`);
  const m = METRIC[size];
  if (!m) userError(`unknown screw size "${size}"; use one of ${SIZES}`);
  const fit = spec.fit ?? "normal";
  if (!["close", "normal", "loose", "tap"].includes(fit)) userError(`hole fit must be "close", "normal", "loose" or "tap" (got ${JSON.stringify(fit)})`);
  const diameter = m[fit];
  if (spec.counterbore && spec.countersink) userError(`hole spec: use counterbore or countersink, not both`);
  if (spec.counterbore) {
    const h = HEADS[spec.counterbore]?.[size];
    if (!h?.cbore) userError(spec.counterbore in HEADS ? `${spec.counterbore} has no ${size}; sizes: ${Object.keys(HEADS[spec.counterbore]).join(", ")}` : `counterbore must be "ISO4762" or "ISO7380" (got ${JSON.stringify(spec.counterbore)})`);
    const depth = h.k + sink;
    return { diameter, depth: spec.depth, counterbore: { diameter: h.cbore, depth }, seat: depth, label: `${size}-${spec.counterbore}` };
  }
  if (spec.countersink) {
    const h = HEADS[spec.countersink]?.[size];
    if (!h?.csink) userError(spec.countersink === "ISO10642" ? `ISO10642 has no ${size}; sizes: ${Object.keys(HEADS.ISO10642).join(", ")}` : `countersink must be "ISO10642" (got ${JSON.stringify(spec.countersink)})`);
    return { diameter, depth: spec.depth, countersink: { diameter: h.csink, angle: 90, recess: sink }, seat: sink, label: `${size}-${spec.countersink}` };
  }
  return { diameter, depth: spec.depth, seat: 0, label: `${size}-${fit}` };
}

/**
 * Hex nut pockets (ISO 4032), for `solid.nutTrap(points, opts)`. The pocket starts `inset` below
 * each point along `direction` (default −Z) and is `depth` deep (default nut height + clearance).
 * `slot` (a direction across the hole axis) adds a side-entry slot, one nut wide, out of the part.
 */
export type NutTrapOpts = {
  size: MetricSize;
  /** Pocket depth (default: nut height m + clearance). */
  depth?: number;
  /** Distance from the point to the top of the pocket along `direction` (default 0, at the surface). */
  inset?: number;
  /** Extra width across flats, for printing (default 0.2). */
  clearance?: number;
  /** Hex rotation about the axis in degrees (default 0: flats parallel to `slot`, or to X). */
  rotation?: number;
  /** Side-entry slot direction (perpendicular to the axis), e.g. "X" or [0, -1, 0]. */
  slot?: AxisLike;
  /** Slot length from the hole axis (default: out through the part). */
  slotLength?: number;
  direction?: AxisLike;
  /** Add a connector with a frame at each nut's seat (pocket floor, axis toward the opening). */
  connector?: string;
  tag?: string;
};

/** @internal Cutting tools for nut traps (hex pockets plus optional slots). */
export function nutTrapTools(target: Solid, pts: Vec3[], o: NutTrapOpts): { tools: Solid[]; seats: { origin: Vec3; axis: Vec3 }[]; label: string } {
  if (!o || typeof o !== "object") userError(`nutTrap(points, { size: "M3" }) needs options with a size`);
  const nut = NUTS[o.size];
  if (!nut) userError(`unknown nut size "${o.size}"; use one of ${SIZES}`);
  const c = o.clearance ?? 0.2;
  const af = nut.s + c;
  const depth = o.depth ?? nut.m + c;
  if (!(depth > 0)) userError(`nut trap depth must be positive (got ${depth})`);
  const dir = axisVec(o.direction ?? ([0, 0, -1] as Vec3));
  let x: Vec3;
  if (o.slot !== undefined) {
    const s = axisVec(o.slot);
    x = vec.add(s, vec.scale(dir, -vec.dot(s, dir)));
    if (Math.hypot(...x) < 1e-6) userError(`nut trap slot must run across the hole axis, not along it`);
  } else x = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const bb = target.boundingBox();
  const reach = o.slotLength ?? Math.hypot(...bb.size) * 2 + 1;
  const R = af / Math.sqrt(3);
  const tools: Solid[] = [];
  const seats: { origin: Vec3; axis: Vec3 }[] = [];
  for (const p of pts) {
    const top = vec.add(p, vec.scale(dir, o.inset ?? 0));
    const pl = new Plane(top, dir, x);
    tools.push(sketch(pl).polygon([0, 0], R, 6, { rotation: o.rotation ?? 0 }).extrude(depth));
    if (o.slot !== undefined) tools.push(sketch(pl).rect(reach, af, { center: false, at: [0, -af / 2] }).extrude(depth));
    seats.push({ origin: vec.add(top, vec.scale(dir, depth)), axis: vec.scale(dir, -1) });
  }
  return { tools, seats, label: `${o.size}-nut-trap` };
}

/** @internal A tag that is free in this part: `base`, else `base-2`, `base-3`, … (dots become `_`). */
export function freeTag(base: string, also: string[] = []): string {
  const c = ctx();
  const clean = base.replace(/\./g, "_").replace(/[^A-Za-z0-9_-]/g, "-").replace(/^([^A-Za-z_])/, "_$1");
  const taken = (t: string) => c.tags.has(t) || also.some((s) => c.tags.has(t + s));
  let t = clean;
  for (let n = 2; taken(t); n++) t = `${clean}-${n}`;
  return t;
}
