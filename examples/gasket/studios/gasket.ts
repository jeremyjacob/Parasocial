import { part, param, sketch, plane, mm } from "parasocial";

export const name = "Gasket";

export default part("Gasket", ({ color }) => {
  const w = param("width", 70, { unit: mm });
  const d = param("depth", 40, { unit: mm });
  const t = param("thickness", 1.5, { min: 0.5, max: 4, unit: mm, step: 0.1 });
  const s = sketch(plane.XY, { tag: "outline" })
    .rect(w, d, { tag: "edge" })
    .rect(w - 12, d - 12, { tag: "window" });
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) s.circle([x * (w / 2 - 3), y * (d / 2 - 3)], 1.6);
  s.slot([-8, d / 2 - 3], [8, d / 2 - 3], 2.4, { tag: "keyway" });
  return s.extrude(t, { tag: "sheet" }).color(color.auto()).material("nylon");
});
