import { part, param, box, cylinder, thicken } from "parasocial";

// thicken: a planar pad on a plate's top, an L-shaped skin around one corner (sharp edge, square
// corner), an inward skin of an open box, and a tube around a boss, all fused.
export default part("Skin", () => {
  const t = param("t", 2, { min: 0.5, max: 4 });
  const plate = box(60, 40, 6, { tag: "plate" });
  const pad = thicken(plate.faces(">Z"), t, { tag: "pad" });
  const corner = thicken(plate.faces("<X or <Y"), t, { tag: "corner" });
  const cup = box(20, 20, 12, { tag: "cup" }).translate([70, 10, 0], { tag: "cupMove" });
  const cupSkin = thicken(cup.faces("not <Z"), -t, { tag: "cupSkin" });
  const boss = cylinder(6, 15, { tag: "boss", at: [30, 20, 0] });
  const tube = thicken(boss.faces("%cylinder"), t, { tag: "tube" });
  return plate.union(pad, corner, cupSkin, tube, { tag: "all" });
});
