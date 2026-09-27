import { part, param, sketch, plane, mm } from "parasocial";

export default part("Body", ({ color }) => {
  const w = param("width", 80, { min: 30, max: 200, unit: mm });
  const d = param("depth", 50, { min: 30, max: 200, unit: mm });
  const h = param("height", 30, { min: 10, max: 120, unit: mm });
  const wall = param("wall", 2, { min: 1, max: 5, unit: mm, step: 0.2 });

  const shell = sketch(plane.XY).rect(w, d, { tag: "outer" }).extrude(h, { tag: "block" });
  const rounded = shell.fillet(shell.edges("block.side").parallelTo("Z"), 6, { tag: "corners" });
  const cavity = sketch(plane.XY.offset(wall))
    .rect(w - 2 * wall, d - 2 * wall, { tag: "inner" })
    .extrude(h, { tag: "cavity" });
  const hollow = rounded.subtract(cavity, { tag: "hollow" });

  // cable port on the front wall
  const port = sketch(plane.XZ.offset(d / 2 + 1))
    .slot([-8, h / 2], [8, h / 2], 6, { tag: "port" })
    .extrude(wall + 2, { tag: "portCut" });
  return hollow
    .subtract(port, { tag: "portHole" })
    .fillet(hollow.edges("cap.start & corners"), 1.5, { tag: "footRound" })
    .color(color.auto())
    .material("petg");
});
