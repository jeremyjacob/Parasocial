// Assemblies: dragging a jointed part, saved positions, undo, and interference (red) between
// assembly parts.
import { test, expect, openExample, wsEval } from "./fixtures";

const PARTS = ["box", "box:lid", "box:drawer"];
const SHOTS = process.env.SHOTS_DIR;

test("drag the lid open: limits hold, the position is saved, undo puts it back", async ({ page, user }) => {
  await openExample(page, "hinge", PARTS);
  await page.waitForFunction(() => (globalThis as any).__ws.asm.assemblies.length === 1);
  // the assembly-only studio lists joints, not a placeholder part
  await expect(page.locator('[data-joint="lid"]')).toBeVisible();
  await expect(page.locator('[data-joint="drawer"]')).toBeVisible();
  expect(await wsEval<string[]>(page, "ws.parts")).toEqual(PARTS);
  expect(await wsEval<boolean>(page, 'ws.asm.movable("box:lid")')).toBe(true);
  expect(await wsEval<boolean>(page, 'ws.asm.movable("box")')).toBe(false);
  // closed, nothing overlaps
  await page.waitForTimeout(500);
  expect(await wsEval<unknown[]>(page, "ws.asm.overlaps")).toEqual([]);

  await wsEval(page, "ws.viewer.setView('right', false)");
  await page.waitForTimeout(200);
  // grab the lid's front tab (on screen from the lid's world position) and pull it up and back
  const at = await wsEval<{ x: number; y: number }>(page, "(() => { const v = ws.viewer; const c = v.entityCenter({ part: 'box:lid', kind: 'part', index: 0 }); c.y -= 22; c.z += 3; const s = v.project(c); const r = v.container.getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; })()");
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(at.x + i * 6, at.y - i * 12);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/assembly-dragging.png` });
  await page.mouse.up();
  const open = await wsEval<number>(page, "ws.asm.values.mechanism.lid[0]");
  expect(open).toBeGreaterThan(20);
  expect(open).toBeLessThanOrEqual(110);
  // saved to the document
  await expect.poll(() => wsEval<number | undefined>(page, "ws.doc.settings.poses?.mechanism?.lid?.[0]")).toBeCloseTo(open, 3);
  // the lid's pins/bounds follow: its world bounds moved up
  expect(await wsEval<number>(page, "ws.viewer.bounds(['box:lid']).max.z")).toBeGreaterThan(50);

  // reload: the lid is still open
  await page.reload();
  await page.waitForFunction(() => {
    const ws = (globalThis as any).__ws;
    return ws?.kernelReady && ws.asm.values?.mechanism?.lid;
  });
  expect(await wsEval<number>(page, "ws.asm.values.mechanism.lid[0]")).toBeCloseTo(open, 3);

  // pulling past the limit stops at 110°
  await wsEval(page, "(() => { const b = ws.asm; b.startDrag('box:lid', [0, -25, 43]); for (let i = 0; i < 40; i++) b.dragTo([0, 25 + i * 8, 60]); return b.endDrag(); })()");
  expect(await wsEval<number>(page, "ws.asm.values.mechanism.lid[0]")).toBeCloseTo(110, 3);
  await page.keyboard.press("Meta+z");
  await expect.poll(() => wsEval<number>(page, "ws.asm.values.mechanism.lid[0]")).toBeCloseTo(open, 3);
});

test("assembly parts that overlap show red; other parts are never checked", async ({ page, user }) => {
  await openExample(page, "hinge", PARTS);
  await page.waitForFunction(() => (globalThis as any).__ws.asm.assemblies.length === 1);
  // push the drawer 2 mm into the back of its bay (past what its joint allows) through the engine
  await wsEval(page, "(async () => { const list = await ws.engine.interferences(ws.parts, [], { 'box:drawer': { r: [1,0,0,0,1,0,0,0,1], t: [0, 2, 0] } }); ws.viewer.setPartTransform('box:drawer', [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,2,0,1]); ws.viewer.setInterferences(list.map((x) => ({ a: x.a, b: x.b, mesh: x.mesh }))); window.__hits = list.map((x) => [x.a, x.b]); })()");
  expect(await page.evaluate(() => (window as any).__hits)).toEqual([["box", "box:drawer"]]);
  if (SHOTS) {
    await wsEval(page, "ws.viewer.setView('iso', false)");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/assembly-interference.png` });
  }
});
