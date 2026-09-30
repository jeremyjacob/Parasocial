// Assemblies: the assembly studio's own copies (instances) of the parts, dragging one, saved
// positions, undo, and interference (red) between instances. The source parts never move.
import { test, expect, openExample, wsEval } from "./fixtures";

const PARTS = ["box", "box:lid", "box:drawer"];
const INSTANCES = PARTS.map((p) => `mechanism/${p}`);
const SHOTS = process.env.SHOTS_DIR;

test("drag the lid open: limits hold, the position is saved, undo puts it back", async ({ page, user }) => {
  await openExample(page, "hinge", PARTS);
  await page.waitForFunction(() => (globalThis as any).__ws.asm.assemblies.length === 1);
  expect(await wsEval<string[]>(page, "ws.parts")).toEqual(PARTS);
  // one studio at a time: the parts' studio shows the parts, which never move
  await page.locator('[data-studio="studios/box.ts"] .row-main').first().click();
  await expect.poll(() => wsEval<string[]>(page, "ws.viewer.partIds().sort()")).toEqual([...PARTS].sort());
  expect(await wsEval<boolean>(page, 'ws.asm.movable("box:lid")')).toBe(false);
  const home = await wsEval<number>(page, "ws.viewer.bounds(['box:lid']).max.z");
  // the assembly studio shows its own copies instead
  await page.locator('[data-studio="studios/mechanism.ts"] .row-main').first().click();
  await expect.poll(() => wsEval<string[]>(page, "ws.viewer.partIds().sort()")).toEqual([...INSTANCES].sort());
  await page.locator('[data-studio="studios/mechanism.ts"]').getByRole("button", { name: /^Expand / }).click();
  await expect(page.locator('[data-studio="studios/mechanism.ts"]').getByRole("group").getByRole("treeitem").first()).toContainText("Body");
  // its joints show in Properties (the assembly-only studio has no placeholder part)
  await expect(page.locator('[data-joint="lid"]')).toBeVisible();
  await expect(page.locator('[data-joint="drawer"]')).toBeVisible();
  // the solver is built once the parts' connectors arrive with their regeneration
  await page.waitForFunction(() => (globalThis as any).__ws.asm.movable("mechanism/box:lid"));
  expect(await wsEval<boolean>(page, 'ws.asm.movable("mechanism/box")')).toBe(false);
  // closed, nothing overlaps
  await page.waitForTimeout(500);
  expect(await wsEval<unknown[]>(page, "ws.asm.overlaps")).toEqual([]);

  await wsEval(page, "ws.viewer.setView('right', false)");
  await page.waitForTimeout(200);
  // grab the lid's front tab (on screen from the lid's world position) and pull it up and back
  const at = await wsEval<{ x: number; y: number }>(page, "(() => { const v = ws.viewer; const c = v.entityCenter({ part: 'mechanism/box:lid', kind: 'part', index: 0 }); c.y -= 22; c.z += 3; const s = v.project(c); const r = v.container.getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; })()");
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
  expect(await wsEval<number>(page, "ws.viewer.bounds(['mechanism/box:lid']).max.z")).toBeGreaterThan(50);
  // ...and the source lid is still where it's modeled
  await page.locator('[data-studio="studios/box.ts"] .row-main').first().click();
  await expect.poll(() => wsEval<number>(page, "ws.viewer.bounds(['box:lid']).max.z")).toBeCloseTo(home, 3);
  await page.locator('[data-studio="studios/mechanism.ts"] .row-main').first().click();

  // reload: the lid is still open
  await page.reload();
  await page.waitForFunction(() => {
    const ws = (globalThis as any).__ws;
    return ws?.kernelReady && ws.asm.values?.mechanism?.lid;
  });
  // the active studio is remembered
  expect(await wsEval<string>(page, "ws.studio.file")).toBe("studios/mechanism.ts");
  expect(await wsEval<number>(page, "ws.asm.values.mechanism.lid[0]")).toBeCloseTo(open, 3);

  // pulling past the limit stops at 110°
  await wsEval(page, "(() => { const b = ws.asm; b.startDrag('mechanism/box:lid', [0, -25, 43]); for (let i = 0; i < 40; i++) b.dragTo([0, 25 + i * 8, 60]); return b.endDrag(); })()");
  expect(await wsEval<number>(page, "ws.asm.values.mechanism.lid[0]")).toBeCloseTo(110, 3);
  await page.keyboard.press("Meta+z");
  await expect.poll(() => wsEval<number>(page, "ws.asm.values.mechanism.lid[0]")).toBeCloseTo(open, 3);
});

test("instances that overlap show red; the source parts are never checked", async ({ page, user }) => {
  await openExample(page, "hinge", PARTS);
  await page.waitForFunction(() => (globalThis as any).__ws.asm.assemblies.length === 1);
  await wsEval(page, "ws.setActiveStudio('studios/mechanism.ts')");
  // push the drawer's copy 2 mm into the back of its bay (past what its joint allows) through the engine
  await wsEval(page, "(async () => { const ids = ws.instances.map((i) => i.id); const list = await ws.engine.interferences(ids, [], { 'mechanism/box:drawer': { r: [1,0,0,0,1,0,0,0,1], t: [0, 2, 0] } }); ws.viewer.setPartTransform('mechanism/box:drawer', [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,2,0,1]); ws.viewer.setInterferences(list.map((x) => ({ a: x.a, b: x.b, mesh: x.mesh }))); window.__hits = list.map((x) => [x.a, x.b]); })()");
  expect(await page.evaluate(() => (window as any).__hits)).toEqual([["mechanism/box", "mechanism/box:drawer"]]);
  if (SHOTS) {
    await wsEval(page, "ws.viewer.setView('iso', false)");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/assembly-interference.png` });
  }
});

test("desk lamp: driving joints listed by name; shared arm lengths keep the loops closed", async ({ page, user }) => {
  const parts = ["lamp", "lamp:turret", "lamp:lowerArm", "lamp:lowerRod", "lamp:elbow", "lamp:upperArm", "lamp:upperRod", "lamp:wrist", "lamp:shade", "lamp:bulb"];
  await openExample(page, "lamp", parts);
  await page.waitForFunction(() => (globalThis as any).__ws.asm.drivers?.mechanism?.length === 4);
  await page.locator('[data-studio="studios/mechanism.ts"] .row-main').first().click();
  // only the four driving joints, by their names
  await expect(page.locator("[data-joint]")).toHaveCount(4);
  for (const j of ["swivel", "shoulder", "elbow", "tilt"]) await expect(page.locator(`[data-joint="${j}"]`)).toBeVisible();
  // the arm lengths show once, under Shared
  await page.getByRole("tab", { name: "Params" }).click();
  const shared = page.getByTestId("params-panel").getByText("Shared", { exact: true });
  await expect(shared).toBeVisible();
  await wsEval(page, "ws.setParam('*', 'lowerArm', '230', 230)");
  await page.waitForFunction(() => {
    const ws = (globalThis as any).__ws;
    return ws.results["lamp:lowerArm"]?.params.some((p: any) => p.name === "lowerArm" && p.value === 230) && ws.results["lamp:elbow"]?.params.some((p: any) => p.name === "lowerArm" && p.value === 230) && Object.values(ws.regen).every((s) => s === "idle");
  }, undefined, { timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(await wsEval<unknown[]>(page, "ws.asm.problems")).toEqual([]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lamp-shared.png` });
});
