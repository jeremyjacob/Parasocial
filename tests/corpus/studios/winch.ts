import { part, param, cylinder, box, pipe, helix, measure, check } from "parasocial";

// A winch drum: helical rope groove (pipe along a helix, cut), a fin fused on and filleted at its
// root by history (no coordinates), and a design rule on the fin's clearance to the flange.
export default part("Winch", () => {
  const r = param("radius", 20, { min: 12, max: 40 });
  const pitch = param("pitch", 3, { min: 2.6, max: 6 });
  const turns = param("turns", 10, { min: 1, max: 14 });
  const groove = param("groove", 1.2, { min: 0.5, max: 1.25 });
  const finGap = param("finGap", 4, { min: 0, max: 20 });
  const len = turns * pitch + 10;
  const drum = cylinder(r, len + 10, { tag: "drum", at: [0, 0, -5] });
  const grooved = drum.subtract(pipe(helix({ radius: r, pitch, turns }), groove, { tag: "groove" }), { tag: "grooveCut" });
  const flange = cylinder(r + 8, 4, { tag: "flange", at: [0, 0, len + 5] });
  // the fin sits on the drum below the flange, finGap clear of it
  const fin = box(10, 4, 6, { tag: "fin" }).translate([r - 2, -2, len + 5 - finGap - 6], { tag: "finMove" });
  const clear = measure.minClearance(fin, flange);
  check(clear >= 2, `fin must clear the flange by 2 mm (has ${clear.toFixed(2)} mm)`);
  const body = grooved.union(flange, fin, { tag: "finUnion" });
  return body.fillet(body.edges({ createdBy: "finUnion" }).adjacentTo(body.faces("fin")), 0.8, { tag: "finRoot" });
});
