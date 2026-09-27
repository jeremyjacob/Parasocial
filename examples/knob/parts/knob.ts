import { part, param, sketch, plane, cylinder, mm } from "parasocial";

export default part("Knob", ({ color }) => {
  const d = param("diameter", 30, { min: 12, max: 80, unit: mm });
  const h = param("height", 16, { min: 6, max: 40, unit: mm });
  const grips = param("grips", 18, { min: 6, max: 40, step: 1 });
  const shaft = param("shaft", 6, { min: 3, max: 10, unit: mm, step: 0.1 });

  const puck = sketch(plane.XY).circle([0, 0], d / 2, { tag: "rim" }).extrude(h, { tag: "body" });
  const body = puck.fillet(puck.edges("body.cap.end & rim"), 1.5, { tag: "topRound" });
  const groove = cylinder(1.2, h + 2, { at: [d / 2 + 0.4, 0, -1], tag: "groove" }).circularPattern(grips, { tag: "grooves" });
  const knurled = body.subtract(groove, { tag: "knurl" });
  const dShaft = sketch(plane.XY)
    .moveTo([-shaft / 2, 0])
    .threePointArc([0, -shaft / 2], [shaft / 2, 0], { tag: "round" })
    .lineTo([shaft / 2, shaft * 0.3], { tag: "flatSide" })
    .lineTo([-shaft / 2, shaft * 0.3], { tag: "flat" })
    .close()
    .extrude(h * 0.7, { tag: "shaftHole" });
  return knurled.subtract(dShaft, { tag: "socket" }).color(color.auto());
});
