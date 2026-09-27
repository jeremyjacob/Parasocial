import { part, param, sketch, plane, box } from "parasocial";

// A slot cut across the top of a block splits its top face (and the long side faces) in two.
export default part("Split", () => {
  const slotX = param("slotX", 0);
  const slotW = param("slotWidth", 6, { min: 1, max: 20 });
  const block = sketch(plane.XY).rect(60, 20, { tag: "outline" }).extrude(10, { tag: "block" });
  const slot = box(slotW, 40, 6, { tag: "slotTool", center: "xy" }).translate([slotX, 0, 5]);
  return block.subtract(slot, { tag: "slot" });
});
