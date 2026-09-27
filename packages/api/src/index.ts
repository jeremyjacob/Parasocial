// The `parasocial` module that part scripts import. Everything here is frozen by the runtime.
export { part, param } from "./part";
export type { PartDef, PartTools, ParamOptions } from "./part";
export { sketch, Sketch, loft } from "./sketch";
export type { P2, ExtrudeOpts, RevolveOpts } from "./sketch";
export { Solid, box, cylinder, measure, thicken, MATERIALS } from "./solid";
export { EntitySet } from "./selection";
export type { Entity } from "./selection";
export { plane, Plane } from "./plane";
export type { AxisLike } from "./plane";
export { mm, cm, m, inch, ft, deg, rad, evaluate } from "./units";
export type { Unit } from "./units";
export type { Vec3 } from "@parasocial/kernel";
