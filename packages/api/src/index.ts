// The `parasocial` module that studio scripts import. Everything here is frozen by the runtime.
export { part, param } from "./part";
export type { PartDef, PartTools, ParamOptions, ConnectorRef } from "./part";
export { assembly } from "./assembly";
export type { AssemblyDef, AssemblyTools, JointAt, JointOpts, Range } from "./assembly";
export type { FrameSpec } from "./connector";
export { sketch, Sketch, loft } from "./sketch";
export type { P2, ExtrudeOpts, RevolveOpts } from "./sketch";
export { Solid, box, cylinder, measure, thicken, MATERIALS } from "./solid";
export { EntitySet } from "./selection";
export type { Entity } from "./selection";
export { plane, Plane } from "./plane";
export type { AxisLike } from "./plane";
export { mm, cm, m, inch, ft, deg, rad, evaluate } from "./units";
export type { Unit } from "./units";
export type { Appearance } from "./types";
export type { Vec3 } from "@parasocial/kernel";
