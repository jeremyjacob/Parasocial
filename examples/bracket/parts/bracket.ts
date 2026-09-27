import { part, param, sketch, plane, mm } from "parasocial";

export default part("Bracket", ({ color }) => {
  const t = param("thickness", 3, { min: 1, max: 10, unit: mm, step: 0.5 });
  const w = param("width", 40, { unit: mm });

  const base = sketch(plane.XY)
    .rect(w, 25, { center: true, tag: "outline" })
    .circle([0, 0], 4, { tag: "bore" })
    .extrude(t, { tag: "base" });

  return base
    .fillet(base.edges("base.side").parallelTo("Z"), 2, { tag: "corners" })
    .chamfer(base.edges("base.cap.end & bore"), 0.5)
    .color(color.auto());
});
