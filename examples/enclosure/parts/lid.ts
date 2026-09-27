import { part, param, sketch, plane, mm } from "parasocial";

export default part("Lid", ({ color }) => {
  const w = param("width", 80, { min: 30, max: 200, unit: mm });
  const d = param("depth", 50, { min: 30, max: 200, unit: mm });
  const t = param("thickness", 2.5, { min: 1, max: 6, unit: mm, step: 0.1 });
  const lip = param("lip", 3, { min: 1, max: 8, unit: mm });
  const wall = 2, clearance = 0.2;

  const plate = sketch(plane.XY).rect(w, d, { tag: "plate" }).extrude(t, { tag: "top" });
  const lidPlate = plate.fillet(plate.edges("top.side").parallelTo("Z"), 6, { tag: "corners" });
  const ring = sketch(plane.XY.offset(-lip))
    .rect(w - 2 * wall - 2 * clearance, d - 2 * wall - 2 * clearance, { tag: "lipOuter" })
    .rect(w - 4 * wall, d - 4 * wall, { tag: "lipInner" })
    .extrude(lip, { tag: "lip" });
  return lidPlate
    .union(ring, { tag: "joined" })
    .chamfer(lidPlate.edges("top.cap.end & corners"), 0.6, { tag: "topEdge" })
    .translate([0, 0, 40])
    .color(color.auto())
    .material("petg");
});
