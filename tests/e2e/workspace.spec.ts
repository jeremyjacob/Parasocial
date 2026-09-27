import { test, expect, openExample, viewportPoint, wsEval } from "./fixtures";

test.describe("workspace", () => {
  test.beforeEach(async ({ page, user }) => {
    void user;
    await openExample(page, "bracket", ["bracket"]);
  });

  test("click a face: selection label, Properties with stable name and source link", async ({ page }) => {
    const p = await viewportPoint(page, 0.62, 0.55);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
    await expect(page.getByTestId("stable-name")).toHaveText("bracket/base · cap.end");
    await expect(page.getByTestId("created-by-source")).toContainText("bracket.ts:10");
    // reveal source opens Code mode at that line
    await page.getByTestId("created-by-source").click();
    await expect(page.getByTestId("code-editor")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("params: override creates a configuration, regenerates, undo/redo, reset", async ({ page }) => {
    await page.getByRole("tab", { name: "Params" }).click();
    const width = page.getByTestId("params-panel").getByRole("spinbutton").nth(1);
    await width.click();
    await width.fill("=thickness * 20");
    await width.press("Enter");
    await expect.poll(() => wsEval<number>(page, "ws.results.bracket.bbox.max[0] - ws.results.bracket.bbox.min[0]")).toBeCloseTo(60, 0);
    await expect.poll(() => wsEval<string>(page, "ws.activeConfig?.name")).toBeTruthy();
    await page.keyboard.press("Meta+z");
    await expect.poll(() => wsEval<number>(page, "ws.results.bracket.bbox.max[0] - ws.results.bracket.bbox.min[0]")).toBeCloseTo(40, 0);
    await page.keyboard.press("Meta+Shift+z");
    await expect.poll(() => wsEval<number>(page, "ws.results.bracket.bbox.max[0] - ws.results.bracket.bbox.min[0]")).toBeCloseTo(60, 0);
    // out of bounds is rejected inline, the model keeps its last value
    const thickness = page.getByTestId("params-panel").getByRole("spinbutton").nth(0);
    await thickness.click();
    await thickness.fill("50");
    await thickness.press("Enter");
    await expect.poll(() => wsEval<number>(page, "ws.results.bracket.bbox.max[2]")).toBeCloseTo(3, 1);
    // reset all goes back to the code
    await page.getByRole("button", { name: "Reset all" }).last().click();
    await expect.poll(() => wsEval<number>(page, "ws.results.bracket.bbox.max[0] - ws.results.bracket.bbox.min[0]")).toBeCloseTo(40, 0);
  });

  test("an error keeps the last good geometry, shows a calm status pill and a marker", async ({ page }) => {
    await page.keyboard.press("Meta+Backslash");
    await page.waitForSelector(".monaco-editor");
    await page.waitForFunction(() => (globalThis as any).__editor?.getValue().includes("corners"));
    await page.evaluate(() => {
      const ed = (globalThis as any).__editor;
      ed.setValue(ed.getValue().replace(', 2, { tag: "corners" }', ', 30, { tag: "corners" }'));
    });
    await expect.poll(() => wsEval<string>(page, "ws.results.bracket.problems[0]?.message ?? ''"), { timeout: 20_000 }).toMatch(/fillet radius 30 exceeds adjacent face width/);
    expect(await wsEval<boolean>(page, "!!ws.viewer.meshOf('bracket')")).toBe(true);
    await expect(page.getByTestId("unsaved-preview")).toBeVisible();
    await expect(page.locator(".monaco-editor .squiggly-error, .monaco-editor .cdr, .monaco-editor [class*='squiggly']").first()).toBeVisible();
  });

  test("display modes, section, projection, command palette, cheatsheet", async ({ page }) => {
    for (const k of ["Alt+1", "Alt+3", "Alt+4", "Alt+2"]) await page.keyboard.press(k);
    expect(await wsEval<string>(page, "ws.display")).toBe("shaded-edges");
    await page.keyboard.press("s");
    await expect(page.getByTestId("section-bar")).toBeVisible();
    await page.keyboard.press("s");
    await expect(page.getByTestId("section-bar")).toHaveCount(0);
    await page.keyboard.press("o");
    expect(await wsEval<boolean>(page, "ws.ortho")).toBe(true);
    await page.keyboard.press("Meta+k");
    await page.keyboard.type("wireframe");
    await page.keyboard.press("Enter");
    await expect.poll(() => wsEval<string>(page, "ws.display")).toBe("wireframe");
    await page.keyboard.press("?");
    await expect(page.getByTestId("cheatsheet")).toBeVisible();
  });

  test("measure two faces, then note the measurement", async ({ page }) => {
    await page.keyboard.press("m");
    const a = await viewportPoint(page, 0.62, 0.55);
    await page.mouse.click(a.x, a.y);
    const b = await viewportPoint(page, 0.45, 0.66);
    await page.mouse.click(b.x, b.y);
    await expect(page.getByTestId("measure-card")).toContainText("mm");
    await page.getByTestId("measure-card").getByRole("button", { name: "Note" }).click();
    await expect(page.getByTestId("note-text")).toHaveValue(/mm/);
  });

  test("box select (window) and the context menu", async ({ page }) => {
    const a = await viewportPoint(page, 0.03, 0.03),
      b = await viewportPoint(page, 0.97, 0.97);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    expect(await wsEval<number>(page, "ws.selection.filter(r => r.kind === 'face').length")).toBe(12);
    const p = await viewportPoint(page, 0.62, 0.55);
    await page.mouse.click(p.x, p.y, { button: "right" });
    await expect(page.getByRole("menuitem", { name: "Select all from this operation" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Copy reference" }).or(page.getByRole("menuitem", { name: "Copy stable name" })).first().isVisible();
  });
});
