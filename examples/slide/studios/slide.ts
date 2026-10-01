import { part, box, cylinder } from "parasocial";
import { CRANK_R, GEAR_R, AXIS_Z, CRANK_Z, INNER, PLATE, CARRIAGE } from "../lib/dims";

export const name = "Slide";

// A lead-screw slide: a hand crank turns the lead screw through a pair of gears, and the screw
// drives a carriage along it. The parts are modeled in place; studios/mechanism.ts ties their
// joints together with gear and screw relations, so turning the crank, the screw or pushing the
// carriage moves all three. The gears are drawn as discs at their pitch circles.
const HOLE = 4.5; // clearance for the 4 mm shafts
const GEAR_T = 6; // gear thickness, outside the left end plate
const GEAR_X = -INNER - PLATE - 4 - GEAR_T; // the gears' outer face

export default part("Frame", ({ color }) => {
  const base = box(2 * (INNER + PLATE) + 20, 40, 6, { center: "xy", tag: "base" });
  const left = box(PLATE, 40, CRANK_Z + 12, { center: "xy", tag: "left" }).translate([-INNER - PLATE / 2, 0, 0]);
  const right = box(PLATE, 40, AXIS_Z + 14, { center: "xy", tag: "right" }).translate([INNER + PLATE / 2, 0, 0]);
  const screwHoles = cylinder(HOLE, 2 * (INNER + PLATE) + 2, { at: [0, 0, AXIS_Z], axis: "X", center: true, tag: "screwHoles" });
  const crankHole = cylinder(HOLE, PLATE + 2, { at: [-INNER - PLATE / 2, 0, CRANK_Z], axis: "X", center: true, tag: "crankHole" });
  return base.union(left, right, { tag: "frame" }).subtract(screwHoles, crankHole, { tag: "bored" }).color(color.auto()).material("aluminum");
});

export const crank = part("Crank", ({ color }) => {
  // the small gear, its shaft into the left plate, and a handle on the outside
  const gear = cylinder(CRANK_R - 0.2, GEAR_T, { at: [GEAR_X, 0, CRANK_Z], axis: "X", tag: "gear" });
  const shaft = cylinder(4, -GEAR_X - GEAR_T - INNER, { at: [GEAR_X + GEAR_T, 0, CRANK_Z], axis: "X", tag: "shaft" });
  const handle = cylinder(3, 14, { at: [GEAR_X - 14, 0, CRANK_Z + CRANK_R - 4], axis: "X", tag: "handle" });
  return gear
    .union(shaft, handle, { tag: "crank" })
    .color(color.auto())
    .material("steel")
    .connector("axle", { origin: [GEAR_X, 0, CRANK_Z], axis: "X" });
});

export const leadScrew = part("Lead screw", ({ color }) => {
  const rod = cylinder(4, -GEAR_X + INNER + PLATE + 2, { at: [GEAR_X, 0, AXIS_Z], axis: "X", tag: "rod" });
  const gear = cylinder(GEAR_R - 0.2, GEAR_T, { at: [GEAR_X, 0, AXIS_Z], axis: "X", tag: "gear" });
  return rod
    .union(gear, { tag: "screw" })
    .color(color.auto())
    .material("steel")
    .connector("axis", { origin: [0, 0, AXIS_Z], axis: "X" });
});

export const carriage = part("Carriage", ({ color }) => {
  const block = box(CARRIAGE, 30, 2 * (AXIS_Z - 8), { center: "xy", tag: "block" }).translate([0, 0, 8]);
  const nut = cylinder(HOLE, CARRIAGE + 2, { at: [0, 0, AXIS_Z], axis: "X", center: true, tag: "nut" });
  return block
    .subtract(nut, { tag: "carriage" })
    .color(color.auto())
    .material("pla")
    .connector("rail", { origin: [0, 0, AXIS_Z], axis: "X" });
});
