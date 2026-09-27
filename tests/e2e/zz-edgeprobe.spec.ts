import { test, openExample, wsEval } from "./fixtures";
test.use({ deviceScaleFactor: 2 });
test("probe", async ({ page, user }) => {
  void user;
  await openExample(page, "hinge", ["box", "box:lid", "box:drawer"]);
  await page.locator('[data-studio="studios/box.ts"] .row-main').first().click();
  await page.waitForTimeout(800);
  const r = await wsEval<any>(page, `(() => {
    const v = ws.viewer, out = [];
    for (const id of ["box"]) {
      const p = v.parts.get(id), T = p.group.matrix, V = p.group.position.constructor, m = p.data.mesh;
      for (let e = 0; e < m.edgeRanges.length / 2; e++) {
        const st = m.edgeRanges[e*2], c = m.edgeRanges[e*2+1];
        if (!c) continue;
        const k = st + Math.floor(c/2);
        const a = new V().fromArray(m.edgePositions, (k-(k%2))*3).applyMatrix4(T);
        const b = new V().fromArray(m.edgePositions, (k-(k%2)+1)*3).applyMatrix4(T);
        const mid = a.clone().lerp(b, 0.5);
        const vis = v.isPointVisible(mid);
        const sa = v.project(a), sb = v.project(b), sm = v.project(mid);
        const len = Math.hypot(sb.x-sa.x, sb.y-sa.y); if (len < 1) continue;
        const nx = -(sb.y-sa.y)/len, ny = (sb.x-sa.x)/len;
        const hits = [0, 2, -2, 4, -4].map((d) => { const h = v.pick(sm.x+nx*d, sm.y+ny*d); return h ? h.part+":"+h.kind+h.index : "-"; });
        out.push({ e, hidden: !!p.data.hiddenEdges?.has(e), vis, a: a.toArray().map(x=>+x.toFixed(1)), b: b.toArray().map(x=>+x.toFixed(1)), hits: hits.join(" ") });
      }
    }
    return out;
  })()`);
  for (const x of r) console.log(JSON.stringify(x));
});
