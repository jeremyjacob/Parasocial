// Standard content: `import { std } from "parasocial"`.
import { screw, nut, washer, insert, bearing, circlip, circlipGroove, mgnRail, mgnCarriage, railHoles } from "./parts";
import { BEARINGS, DIN471, DIN472, HEADS, INSERTS, METRIC, MGN_CARRIAGES, MGN_RAILS, NUTS, WASHERS } from "./tables";

/**
 * Standard parts and their data. Every function returns a solid (call it inside a part body),
 * tagged after the item (`M3x10-ISO4762`, `bearing-608`, ...), with a material, a finish and
 * connectors for assemblies:
 * - `std.screw("M3", 10, { standard: "ISO4762" | "ISO7380" | "ISO10642" })` — `head`, `top`, `tip`
 * - `std.nut("M3")` (ISO 4032), `std.washer("M3")` (ISO 7089) — `bottom`, `top`
 * - `std.insert("M3x5.7")` heat-set insert — `top`, `bottom`
 * - `std.bearing("608")` deep-groove ball bearing — `bore`, `back`, `face`
 * - `std.circlip("DIN471" | "DIN472", d)`, `std.circlipGroove(standard, d, { at, axis })` — `groove`
 * - `std.mgnRail("MGN12", length)` — `carriage`, `bottom`, `bolt`; `std.mgnCarriage("MGN12H")` — `rail`, `top`, `bolt`
 * - `std.mgnRailHoles("MGN12", length)` — x positions of the rail's bolt holes, for drilling a base
 *
 * `std.tables` holds the dimensions (mm) for designing around them, e.g.
 * `std.tables.bearings["608"].D` for a bearing seat, `std.tables.nuts.M3.s` for a nut's width.
 * Holes by standard live on solids: `.hole(pts, { screw: "M3", counterbore: "ISO4762" })`,
 * `.nutTrap(pts, { size: "M3", slot: "X" })`.
 */
export const std = Object.freeze({
  screw,
  nut,
  washer,
  insert,
  bearing,
  circlip,
  circlipGroove,
  mgnRail,
  mgnCarriage,
  mgnRailHoles: railHoles,
  /** Dimension tables (mm). */
  tables: Object.freeze({
    /** ISO 273 clearance (close / normal / loose), tap drill and pitch by size. */
    metric: METRIC,
    /** ISO 4762 / ISO 7380 / ISO 10642 heads, with counterbore / countersink diameters. */
    heads: HEADS,
    /** ISO 4032 hex nuts. */
    nuts: NUTS,
    /** ISO 7089 washers. */
    washers: WASHERS,
    /** Heat-set inserts with recommended hole diameters. */
    inserts: INSERTS,
    /** Deep-groove ball bearings: bore d, outside D, width B. */
    bearings: BEARINGS,
    /** DIN 471 shaft retaining rings by shaft diameter. */
    din471: DIN471,
    /** DIN 472 bore retaining rings by bore diameter. */
    din472: DIN472,
    /** MGN rails. */
    mgnRails: MGN_RAILS,
    /** MGN carriages. */
    mgnCarriages: MGN_CARRIAGES,
  }),
});

export type { MetricSize, HeadStandard, InsertSize, BearingSize, CirclipStandard, MgnRailSize, MgnCarriageSize } from "./tables";
export type { HoleSpec, NutTrapOpts } from "./holes";
