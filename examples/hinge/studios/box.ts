import { part, param, box, cylinder, mm } from "parasocial";

export const name = "Box";

// A box with a hinged lid on top and a drawer below. The parts are modeled closed, in place;
// studios/mechanism.ts assembles copies of them (open it and drag the lid or the drawer).
const W = 70;
const D = 50;
const WALL = 2;

export default part("Body", ({ color }) => {
  const h = param("height", 40, { min: 30, max: 80, unit: mm });
  const bay = param("bay", 11, { min: 6, max: 20, unit: mm, label: "drawer height" });
  const floor = WALL + bay + WALL;
  const block = box(W, D, h, { center: "xy", tag: "block" });
  // storage on top, open to the lid
  const well = box(W - 2 * WALL, D - 2 * WALL, h - floor + 1, { center: "xy", tag: "well" }).translate([0, 0, floor]);
  // the drawer bay, open at the front
  const slot = box(W - 2 * WALL, D - WALL + 1, bay, { center: "xy", tag: "bay" }).translate([0, -(WALL + 1) / 2, WALL]);
  return block
    .subtract(well, slot, { tag: "hollow" })
    .color(color.auto())
    .material("pla")
    // the lid turns about the back top edge (axis pointing -X, so opening is positive)
    .connector("hinge", { origin: [0, D / 2, h], axis: [-1, 0, 0] });
});

export const lid = part("Lid", ({ color }) => {
  const h = param("height", 40, { min: 30, max: 80, unit: mm });
  const t = param("thickness", 3, { min: 2, max: 6, unit: mm, step: 0.5 });
  const plate = box(W, D, t, { center: "xy", tag: "plate" }).translate([0, 0, h]);
  const tab = box(16, 5, t, { center: "xy", tag: "tab" }).translate([0, -D / 2 - 2.5, h]);
  return plate.union(tab, { tag: "lid" }).color(color.auto()).material("pla");
});

export const drawer = part("Drawer", ({ color }) => {
  const bay = param("bay", 11, { min: 6, max: 20, unit: mm, label: "drawer height" });
  const gap = 0.4;
  // the tray fills the bay less a small gap all round; its front is flush with the body
  const tw = W - 2 * WALL - 2 * gap;
  const td = D - WALL - gap;
  const th = bay - 2 * gap;
  const cy = -(WALL + gap) / 2;
  const tray = box(tw, td, th, { center: "xy", tag: "tray" }).translate([0, cy, WALL + gap]);
  const inside = box(tw - 3, td - 3, th, { center: "xy", tag: "inside" }).translate([0, cy, WALL + gap + 1.5]);
  // the front panel covers the bay opening, touching the body's front face
  const front = box(W, 3, bay + 2, { center: "xy", tag: "front" }).translate([0, -D / 2 - 1.5, WALL - 1]);
  const knob = cylinder(4, 6, { at: [0, -D / 2 - 3, WALL + bay / 2], axis: [0, -1, 0], tag: "knob" });
  return tray
    .subtract(inside, { tag: "hollow" })
    .union(front, knob, { tag: "drawer" })
    .color(color.auto())
    .material("pla")
    // slides straight out the front
    .connector("rail", { origin: [0, -D / 2, WALL + bay / 2], axis: [0, -1, 0] });
});
