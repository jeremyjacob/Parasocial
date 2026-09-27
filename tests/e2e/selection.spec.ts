import { test, expect, openExample, viewportPoint, wsEval } from "./fixtures";

test("selection replaces by default and the preference persists", async ({ page, user }, testInfo) => {
  void user;
  await openExample(page, "bracket", ["bracket"]);
  const a = await viewportPoint(page, 0.62, 0.55);
  const b = await viewportPoint(page, 0.45, 0.66);
  const empty = await viewportPoint(page, 0.03, 0.03);
  const viewport = page.getByTestId("viewport");
  const bounds = (await viewport.boundingBox())!;
  const click = (p: { x: number; y: number }) => viewport.click({ position: { x: p.x - bounds.x, y: p.y - bounds.y } });
  const selection = () => wsEval<unknown[]>(page, "ws.selection");

  expect(await wsEval(page, "ws.additiveSelection")).toBe(false);
  await click(a);
  const initial = await selection();
  expect(initial).toHaveLength(1);
  await click(b);
  expect(await selection()).toHaveLength(1);
  expect(await selection()).not.toEqual(initial);
  await click(empty);

  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("button", { name: "Selection behavior" })).toContainText("Replace");
  await page.getByRole("button", { name: "Selection behavior" }).click();
  await page.getByRole("option", { name: "Additive", exact: false }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Preferences" })).toHaveCount(0);

  await click(a);
  const first = await selection();
  expect(first).toHaveLength(1);
  await click(b);
  expect(await selection()).toHaveLength(2);
  await click(a);
  expect(await selection()).toHaveLength(1);
  expect(await selection()).not.toEqual(first);
  await click(empty);
  expect(await selection()).toEqual([]);

  await click(a);
  await page.mouse.dblclick(b.x, b.y);
  expect(await selection()).toEqual([{ part: "bracket", kind: "part", index: 0 }]);
  const end = await viewportPoint(page, 0.97, 0.97);
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
  expect(await selection()).toContainEqual({ part: "bracket", kind: "part", index: 0 });
  expect((await selection()).length).toBeGreaterThan(1);
  await page.keyboard.press("Escape");
  expect(await selection()).toEqual([]);

  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("button", { name: "Selection behavior" })).toContainText("Additive");
  await page.screenshot({ path: testInfo.outputPath("preferences.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Selection behavior" }).click();
  await page.getByRole("option", { name: "Replace", exact: false }).click();
  expect(await wsEval(page, "ws.additiveSelection")).toBe(false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Preferences" })).toHaveCount(0);
  await click(a);
  await click(b);
  expect(await selection()).toHaveLength(1);
  for (const key of ["Shift", "Meta", "Control"]) {
    await page.keyboard.down(key);
    await click(a);
    expect(await selection()).toHaveLength(2);
    await click(a);
    expect(await selection()).toHaveLength(1);
    await page.keyboard.up(key);
  }

  await page.reload();
  await page.waitForFunction(() => (globalThis as any).__ws?.kernelReady);
  expect(await wsEval(page, "ws.additiveSelection")).toBe(false);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("button", { name: "Selection behavior" })).toContainText("Replace");
  await page.getByRole("button", { name: "Selection behavior" }).click();
  await page.getByRole("option", { name: "Additive", exact: false }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Preferences" })).toHaveCount(0);
  await click(a);
  await click(b);
  expect(await selection()).toHaveLength(2);
});
