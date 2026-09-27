import { part, param, sketch, plane, mm } from "parasocial";

export const name = "Enclosure";

// Body and lid share one footprint, so they live in one studio: part ids `enclosure` and `enclosure:lid`.
const CORNER = 6;
const CLEARANCE = 0.2;

/** The footprint both halves are built from. Called inside each part, so each gets its own overridable params. */
function footprint() {
  return {
    w: param("width", 80, { min: 30, max: 200, unit: mm }),
    d: param("depth", 50, { min: 30, max: 200, unit: mm }),
    wall: param("wall", 2, { min: 1, max: 5, unit: mm, step: 0.2 }),
  };
}

export default part("Body", ({ color }) => {
  const { w, d, wall } = footprint();
  const h = param("height", 30, { min: 10, max: 120, unit: mm });

  const shell = sketch(plane.XY).rect(w, d, { tag: "outer" }).extrude(h, { tag: "block" });
  const rounded = shell.fillet(shell.edges("block.side").parallelTo("Z"), CORNER, { tag: "corners" });
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

export const lid = part("Lid", ({ color }) => {
  const { w, d, wall } = footprint();
  const t = param("thickness", 2.5, { min: 1, max: 6, unit: mm, step: 0.1 });
  const lip = param("lip", 3, { min: 1, max: 8, unit: mm });

  const plate = sketch(plane.XY).rect(w, d, { tag: "plate" }).extrude(t, { tag: "top" });
  const lidPlate = plate.fillet(plate.edges("top.side").parallelTo("Z"), CORNER, { tag: "corners" });
  const ring = sketch(plane.XY.offset(-lip))
    .rect(w - 2 * wall - 2 * CLEARANCE, d - 2 * wall - 2 * CLEARANCE, { tag: "lipOuter" })
    .rect(w - 4 * wall, d - 4 * wall, { tag: "lipInner" })
    .extrude(lip, { tag: "lip" });
  return lidPlate
    .union(ring, { tag: "joined" })
    .chamfer(lidPlate.edges("top.cap.end & corners"), 0.6, { tag: "topEdge" })
    .translate([0, 0, 40])
    // clear PETG: the body and its port show through the lid
    .color(color.auto())
    .appearance({ opacity: 0.45, roughness: 0.15 })
    .material("petg");
});
