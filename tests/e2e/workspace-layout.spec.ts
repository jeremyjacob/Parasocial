import { test, expect, openExample } from "./fixtures";

test("a narrow inspector and long panel lists stay inside the workspace", async ({ page, user }) => {
  void user;
  await openExample(page, "bracket", ["bracket"]);

  // Populate the layout without regenerating dozens of copies of the same part.
  await page.evaluate(() => {
    const ws = (globalThis as any).__ws;
    const part = ws.partInfos.find((p: any) => p.id === "bracket");
    ws.partInfos = [part, ...Array.from({ length: 48 }, (_, i) => ({
      ...part,
      id: `bracket:copy${i}`,
      export: `copy${i}`,
      name: `Bracket copy ${i} with a long descriptive name`,
    }))];
    const describe = ws.engine.describe.bind(ws.engine);
    ws.engine.describe = async (...args: any[]) => ({
      ...await describe(...args),
      neighbors: Array.from({ length: 48 }, (_, i) => `bracket/feature${i}/face-with-a-long-stable-reference`),
    });
    ws.select([{ part: "bracket", kind: "face", index: 0 }], "replace");
  });
  await expect(page.getByTestId("properties-panel").getByText("Touches", { exact: true })).toBeVisible();
  await expect(page.getByTestId("parts-panel").locator('[data-part="bracket:copy47"]')).toHaveCount(1);

  const handle = page.getByTestId("resize-right");
  for (let i = 0; i < 12; i++) await handle.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "200");

  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 600 }]) {
    await page.setViewportSize(size);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/workspace-layout-${size.width}.png` });
    await expect.poll(() => page.evaluate(() => {
      const root = document.documentElement;
      return { width: root.scrollWidth, height: root.scrollHeight };
    })).toEqual(size);

    for (const panel of [page.getByRole("tree", { name: "Parts by studio" }), page.getByTestId("properties-panel")]) {
      await expect.poll(() => panel.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      await panel.evaluate(el => { el.scrollTop = el.scrollHeight; });
      expect(await panel.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    }
    await expect(page.getByTestId("parts-panel").locator('[data-part="bracket:copy47"]')).toBeInViewport();
    await expect(page.getByTestId("properties-panel").getByText("bracket/feature47/face-with-a-long-stable-reference", { exact: true })).toBeInViewport();
  }

  await page.getByRole("tab", { name: "Notes", exact: true }).click();
  await expect(page.getByTestId("notes-panel")).toBeVisible();
});
