import { part, param, sketch, plane } from "parasocial";

// Fillets that must survive upstream dimension changes, plus a fillet on a fillet boundary.
export default part("FilletChain", () => {
  const w = param("width", 50, { min: 20, max: 120 });
  const d = param("depth", 30, { min: 20, max: 80 });
  const h = param("height", 12, { min: 4, max: 40 });
  const r = param("radius", 3, { min: 0.5, max: 8 });
  const base = sketch(plane.XY).rect(w, d, { tag: "plan" }).circle([w / 4, 0], 4, { tag: "hole" }).extrude(h, { tag: "slab" });
  const soft = base.fillet(base.edges("slab.side").parallelTo("Z"), r, { tag: "verticals" });
  return soft.fillet(soft.edges("slab.cap.end - hole"), 1, { tag: "topEdge" });
});
