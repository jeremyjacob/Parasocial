import { part, param, sketch, plane, mm } from "parasocial";

export const name = "Wall mount";

// A separate component, so a separate studio: the wall plate the enclosure sits on (part id `mount`).
export default part("Wall mount", ({ color }) => {
  const w = param("width", 110, { min: 40, max: 250, unit: mm });
  const d = param("depth", 60, { min: 30, max: 200, unit: mm });
  const t = param("thickness", 4, { min: 2, max: 10, unit: mm, step: 0.5 });
  const screw = param("screw", 4.5, { min: 2, max: 8, unit: mm, step: 0.1 });

  const plate = sketch(plane.XY.offset(-t)).rect(w, d, { tag: "edge", fillet: 4 }).extrude(t, { tag: "plate" });

  // a keyhole at each end, to hang the plate on two wall screws
  const x = w / 2 - 10;
  const below = plane.XY.offset(-t - 1);
  const head = sketch(below).circle([x, 6], screw, { tag: "head" }).extrude(t + 2, { tag: "head" });
  const slot = sketch(below).slot([x, 6], [x, -8], screw, { tag: "slot" }).extrude(t + 2, { tag: "slot" });
  const keyholes = head.union(slot, { tag: "keyhole" }).mirror("YZ", { union: true, tag: "keyholes" });
  const cut = plate.subtract(keyholes, { tag: "cut" });
  return cut
    .chamfer(cut.edges("plate.cap.end & edge"), 0.8, { tag: "topEdge" })
    .color(color.auto())
    .material("petg");
});
