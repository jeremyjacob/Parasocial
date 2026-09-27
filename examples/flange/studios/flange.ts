import { part, param, sketch, plane, mm } from "parasocial";
import { boltCircle } from "../lib/holes";

export const name = "Flange";

export default part("Flange", ({ color }) => {
  const od = param("outerDiameter", 90, { min: 40, max: 200, unit: mm });
  const bore = param("bore", 30, { min: 5, max: 80, unit: mm });
  const t = param("thickness", 8, { min: 3, max: 30, unit: mm, step: 0.5 });
  const hub = param("hubHeight", 14, { min: 0, max: 60, unit: mm });
  const bolts = param("bolts", 6, { options: [4, 6, 8] });
  const boltD = param("boltDiameter", 5.5, { min: 2, max: 14, unit: mm, step: 0.1 });

  // half cross-section in XZ, revolved around Z
  const r = od / 2, rb = bore / 2, rh = rb + 8;
  const body = sketch(plane.XZ, { tag: "section" })
    .moveTo([rb, 0])
    .lineTo([r, 0], { tag: "bottom" })
    .lineTo([r, t], { tag: "rim" })
    .lineTo([rh, t], { tag: "shoulder" })
    .lineTo([rh, t + hub], { tag: "hub" })
    .lineTo([rb, t + hub], { tag: "top" })
    .close({ tag: "bore" })
    .revolve(360, { axis: "Z", tag: "body" });

  const drilled = body.subtract(boltCircle(bolts, (r + rh) / 2, boltD, t), { tag: "drill" });
  return drilled
    .fillet(drilled.edges("shoulder & hub"), 3, { tag: "hubFillet" })
    .chamfer(drilled.edges("rim & body.side.bottom"), 1, { tag: "edgeBreak" })
    .color(color.auto())
    .material("steel");
});
