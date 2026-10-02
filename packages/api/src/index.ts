// The `parasocial` module that studio scripts import. Everything here is frozen by the runtime.
/**
 * @module parasocial — cheat sheet. Look up any name with api_reference({ symbol: "Solid.fillet" }).
 *
 * Units: numbers are mm and degrees. World Z is up.
 * Parts: a studio (studios/*.ts) exports parts: `export default part("Bracket", () => solid)` (id = file
 * name) or `export const lid = part("Lid", ...)` (id `case:lid`); `export const name = "Case"` names the
 * studio. Params: `const w = param("width", 40, { label: "Width", min: 10 })` (value in code = default).
 *
 * Planes: sketch point [u, v] → world; positive extrude/offset goes along the normal.
 *   plane.XY (top)    [u, v] → [x, y]   normal +Z
 *   plane.XZ (front)  [u, v] → [x, z]   normal −Y   (plane.XZ.offset(5) is y = −5)
 *   plane.YZ (right)  [u, v] → [y, z]   normal +X
 *   plane.at(origin, normal, xDir?), p.offset(d), p.at([u, v]), p.flipped(), p.rotated(deg, "x" | "y")
 *
 * Sketch → solid: sketch(plane.XY, { tag }) .rect(w, h, { center, at, fillet, tag }) .circle([u, v], r)
 *   .slot .polygon .polyline(pts) .moveTo .lineTo .line .hLine .vLine .threePointArc .tangentArcTo
 *   .splineTo .spline .close .offset(d) .mirror("y") → .extrude(d, { tag, symmetric, mode, target })
 *   .revolve(deg, { axis }) .sweep(path3d | helix | sketch) · loft([a, b]) · thicken(faces, t)
 * Primitives: box(w, d, h, { center: true | "xy" }) (corner at the origin by default), cylinder(r, h, { at, axis, center }).
 * Booleans: a.union(b, c), a.subtract(b) (alias cut), a.intersect(b), then optional { tag }.
 * Finishing: s.fillet(edges, r), s.chamfer(edges, d), s.shell(openFaces, t), s.draft(faces, deg),
 *   s.hole(points, d, { depth, counterbore, countersink }), s.split(plane | solid).
 * Transforms: s.translate([x, y, z]), s.rotate(deg, { axis, origin }), s.mirror("YZ", { union: true }),
 *   s.linearPattern(dir, n, spacing), s.circularPattern(n, { axis, angle }).
 * Selection: s.faces(sel) / s.edges(sel) / s.vertices(sel) → EntitySet. Selectors: ">Z" "<X" ">Z[1]"
 *   (extremes) · "|Z" straight edges along Z, faces facing ±Z (and cylinders about Z) · "#Z" perpendicular
 *   to Z (side walls) · "+Z" "-Z" planar faces facing that way · "%plane" "%cylinder" "%line" "%circle" ·
 *   names "base.side" "bore" · combine with & | - not. Filters: .filter(fn | sel) .planar() .ofType(t)
 *   .parallelTo(ax) .perpendicularTo(ax) .sortBy(key, dir) .largest(n) .smallest(n) .first .last .at(i)
 *   .nearest([x, y, z]) .and .or .minus .names() .list().
 * Names: tag what a person might point at ({ tag: "base" }). Faces are `part/base · side · outline/right`,
 *   `base · cap.start` / `cap.end`, `corners · fillet · (…)`; edges are named by their two faces. Untagged
 *   ops get ids (`sketch1`, `fillet2`) that shift when you insert ops of the same type earlier.
 * Appearance: s.color("#4a7bd0"), s.opacity(0.4), s.appearance({ roughness }), s.material("pla").
 * Assemblies: see topic "assembly".
 * @example
 * import { part, param, sketch, plane } from "parasocial";
 * export default part("Plate", () => {
 *   const w = param("width", 60, { label: "Width", min: 20 });
 *   let body = sketch(plane.XY, { tag: "plate" }).rect(w, 40, { tag: "outline" }).circle([0, 0], 6, { tag: "bore" }).extrude(5, { tag: "plate" });
 *   body = body.fillet(body.edges("|Z"), 4, { tag: "corners" });
 *   return body.chamfer(body.edges("bore & >Z"), 0.5);
 * });
 */
export { part, param } from "./part";
export type { PartDef, PartTools, PartOptions, ParamOptions, ConnectorRef } from "./part";
export { assembly } from "./assembly";
export type { AssemblyDef, AssemblyTools, JointAt, JointOpts, MateOpts, Range, Instance, SubAssembly, Body, InsertOpts, Placement, Joint, RelationOpts } from "./assembly";
export type { FrameSpec } from "./connector";
export { sketch, Sketch, loft, pipe } from "./sketch";
export type { P2, ExtrudeOpts, RevolveOpts } from "./sketch";
export type { SweepOpts, PipeOpts } from "./sketch";
export { path3d, helix, Path3d } from "./path3d";
export type { HelixOpts } from "./path3d";
export { Solid, box, cylinder, thicken, MATERIALS } from "./solid";
export { std } from "./std";
export type { HoleSpec, NutTrapOpts, PlaceOpts, MetricSize, HeadStandard, InsertSize, BearingSize, CirclipStandard, MgnRailSize, MgnCarriageSize } from "./std";
export { measure, check } from "./measure";
export type { Measurable, BoundingBox, Closest } from "./measure";
export { EntitySet } from "./selection";
export type { Entity, OpRef } from "./selection";
export type { SelectOpts } from "./solid";
export { plane, Plane } from "./plane";
export type { AxisLike } from "./plane";
export { mm, cm, m, inch, ft, deg, rad, evaluate } from "./units";
export type { Unit } from "./units";
export type { Appearance, Material, PartMeta } from "./types";
export type { Vec3 } from "@parasocial/kernel";
