import { test, expect, openExample, wsEval } from "./fixtures";

// Edges and vertices are thin targets: the pick snaps to them within a few CSS px, on hi-dpi too.
test.use({ deviceScaleFactor: 2 });

test("vertices and edges snap within a few CSS px", async ({ page, user }) => {
  void user;
  await openExample(page, "bracket", ["bracket"]);
  const r = await wsEval<{ verts: number; vertHits: number; edges: number; edgeHits: number; faceMiss: boolean }>(
    page,
    `(() => {
      const v = ws.viewer, p = v.parts.get("bracket"), T = p.group.matrix;
      const V = p.group.position.constructor;
      let verts = 0, vertHits = 0, edges = 0, edgeHits = 0;
      for (const i of p.pickableVertices) {
        const w = new V(...p.data.vertices[i]).applyMatrix4(T);
        if (!v.isPointVisible(w)) continue;
        const s = v.project(w);
        verts++;
        const hit = v.pick(s.x + 4, s.y + 3); // 5 CSS px off
        if (hit?.kind === "vertex" && hit.index === i) vertHits++;
      }
      const m = p.data.mesh;
      for (let e = 0; e < m.edgeRanges.length / 2; e++) {
        const st = m.edgeRanges[e * 2], c = m.edgeRanges[e * 2 + 1];
        if (!c || p.data.hiddenEdges?.has(e)) continue;
        const k = st + Math.floor(c / 2);
        const a = new V().fromArray(m.edgePositions, (k - (k % 2)) * 3).applyMatrix4(T);
        const b = new V().fromArray(m.edgePositions, (k - (k % 2) + 1) * 3).applyMatrix4(T);
        const mid = a.clone().lerp(b, 0.5);
        if (!v.isPointVisible(mid)) continue;
        const sa = v.project(a), sb = v.project(b), sm = v.project(mid);
        const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
        if (len < 1) continue;
        const nx = -(sb.y - sa.y) / len, ny = (sb.x - sa.x) / len;
        edges++;
        const hits = [1, -1].map((d) => v.pick(sm.x + nx * 4 * d, sm.y + ny * 4 * d)); // 4 CSS px either side
        if (hits.some((h) => h?.kind === "edge" && h.index === e)) edgeHits++;
      }
      return { verts, vertHits, edges, edgeHits, faceMiss: v.pick(4, 4) === null };
    })()`,
  );
  console.log(r);
  expect(r.verts).toBeGreaterThan(3);
  expect(r.vertHits / r.verts).toBeGreaterThan(0.85);
  expect(r.edges).toBeGreaterThan(3);
  expect(r.edgeHits / r.edges).toBeGreaterThan(0.85);
  expect(r.faceMiss).toBe(true);
});
