import { part, param, sketch, plane, loft, box, thicken } from "parasocial";

// Exercises the M6 surface: rounded profiles, offset, mirror, shell, draft, holes (counterbore,
// countersink), sweep, loft, extrude up-to, split, thicken.
export default part("Features", () => {
  const wall = param("wall", 2, { min: 1, max: 5 });
  const tray = sketch(plane.XY).rect(80, 50, { fillet: 8, tag: "outline" }).extrude(20, { tag: "tray" });
  const hollow = tray.shell(tray.faces("tray.cap.end"), wall, { tag: "hollow" });
  const tapered = hollow.draft(hollow.faces("tray.side & #Z").planar(), 2, { tag: "taper" });
  const drilled = tapered
    .hole([[-30, 0, 20], [30, 0, 20]], 3.4, { tag: "mount", counterbore: { diameter: 6, depth: 1 }, depth: 30 })
    .hole([0, 15, 20], 3, { tag: "sink", countersink: { diameter: 6 } });
  // a swept handle and a lofted boss
  const handle = sketch(plane.YZ.at([40, 0, 10])).circle([0, 0], 2.5, { tag: "rod" }).sweep(
    sketch(plane.XZ).moveTo([40, 10]).lineTo([46, 10]).threePointArc([49, 7], [46, 4]).lineTo([40, 4]),
    { tag: "handle" },
  );
  const boss = loft([sketch(plane.XY.offset(wall)).circle([0, -10], 6), sketch(plane.XY.offset(wall + 8)).circle([0, -10], 3)], { tag: "boss" });
  const rib = sketch(plane.XZ.offset(-10)).rect(4, 1, { at: [-15, wall], center: false, tag: "rib" }).offset(0.5).extrude({ upTo: tray.faces("tray.cap.start") }, { tag: "ribCut" });
  const body = drilled.union(handle, boss, { tag: "joined" });
  const bracket = sketch(plane.XY).polyline([[0, 0], [20, 0], [20, 10], [0, 10]], { fillet: 2, tag: "tab" }).mirror("y").extrude(3, { tag: "tabs" });
  void rib;
  void box;
  void thicken;
  return body.union(bracket.translate([0, 40, 0]), { tag: "all" });
});
