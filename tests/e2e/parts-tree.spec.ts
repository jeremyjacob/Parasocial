import { test, expect, openExample, wsEval } from "./fixtures";

const MULTI = `import { part, box } from "parasocial";

export const name = "Stack";

export default part("Base", ({ color }) => box(40, 30, 6).color(color.auto()));
export const lid = part("Lid", ({ color }) => box(40, 30, 2).translate([0, 0, 10]).color(color.auto()));
export const clip = part("Clip", ({ color }) => box(6, 4, 4).translate([30, 0, 0]).color(color.auto()));
`;

test("a studio exports several parts; the Parts tab nests them under their studio, by its name", async ({ page, user }) => {
  void user;
  await openExample(page, "bracket", ["bracket"]);
  await wsEval(page, `(ws.openBuffer("studios/bracket.ts"), ws.editBuffer("studios/bracket.ts", ${JSON.stringify(MULTI)}), ws.saveBuffer("studios/bracket.ts"))`);
  await page.waitForFunction(() => {
    const ws = (globalThis as any).__ws;
    return ["bracket", "bracket:lid", "bracket:clip"].every((p) => ws.results?.[p]?.ok) && Object.values(ws.regen).every((s) => s === "idle");
  }, null, { timeout: 45_000 });
  expect(await wsEval(page, "ws.parts")).toEqual(["bracket", "bracket:lid", "bracket:clip"]);

  const panel = page.getByTestId("parts-panel");
  const studio = panel.locator('[data-studio="studios/bracket.ts"]');
  await expect(studio).toContainText("Stack");
  await expect(studio).not.toContainText("bracket.ts");
  // studios start collapsed
  await expect(studio.getByRole("group")).toHaveCount(0);
  await studio.getByRole("button", { name: "Expand Stack" }).click();
  await expect(studio.getByRole("group").getByRole("treeitem")).toHaveText([/Base/, /Lid/, /Clip/]);
  await page.screenshot({ path: "test-results/parts-tree.png" });

  // the studio in the viewport is bold; selecting a part tints its row; there's no isolate toggle
  await wsEval(page, "ws.additiveSelection = true");
  const row = (name: string) => studio.locator("div.group\\/row", { hasText: name }).first();
  await expect(row("Stack").locator(".row-main")).toHaveClass(/font-medium/);
  await expect(studio).toHaveAttribute("aria-current", "true");
  await row("Lid").click();
  await expect(row("Lid")).toHaveClass(/bg-accent-subtle/);
  await row("Base").click();
  expect(await wsEval(page, "ws.selection.map(r => r.part)")).toEqual(["bracket:lid", "bracket"]);
  await row("Lid").click();
  expect(await wsEval(page, "ws.selection.map(r => r.part)")).toEqual(["bracket"]);
  await wsEval(page, "ws.additiveSelection = false");
  await row("Lid").click();
  expect(await wsEval(page, "ws.selection.map(r => r.part)")).toEqual(["bracket:lid"]);
  await row("Base").click({ modifiers: ["Shift"] });
  expect(await wsEval(page, "ws.selection.map(r => r.part)")).toEqual(["bracket", "bracket:lid"]);
  await expect(studio.getByRole("button", { name: /Isolate/ })).toHaveCount(0);
  await expect(studio.getByRole("button", { name: "Hide Stack" })).toHaveCount(0);
  // clicking the studio row selects the studio itself (its properties), not its parts
  await row("Stack").click();
  expect(await wsEval(page, "ws.selection.length")).toBe(0);

  // context menu: Isolate and Export… (no Hide); ⌘E exports the selection
  await row("Lid").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Export…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Isolate/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^(Hide|Open code)$/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Export…" }).click();
  await expect(page.getByTestId("export-dialog")).toContainText("Lid");
  await page.keyboard.press("Escape");
  // nothing selected: ⌘E exports the studio in the viewport
  await wsEval(page, "ws.clearSelection()");
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.getByTestId("export-dialog")).toContainText("Stack (3 parts)");
  const download = page.waitForEvent("download");
  await page.getByTestId("export-go").click();
  expect((await download).suggestedFilename()).toBe("Stack.step");
  await page.keyboard.press("Escape");

  // a part row's eye hides it; collapsing hides the children
  await row("Clip").getByRole("button", { name: "Hide Clip" }).click();
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket:clip"]);
  await studio.getByRole("button", { name: "Collapse Stack" }).click();
  await expect(studio.getByRole("group")).toHaveCount(0);
});


test("visibility toggles share undo and redo, with one entry per selection action", async ({ page, user }) => {
  void user;
  await openExample(page, "bracket", ["bracket"]);
  await wsEval(page, `(ws.openBuffer("studios/bracket.ts"), ws.editBuffer("studios/bracket.ts", ${JSON.stringify(MULTI)}), ws.saveBuffer("studios/bracket.ts"))`);
  await page.waitForFunction(() => {
    const ws = (globalThis as any).__ws;
    return ["bracket", "bracket:lid", "bracket:clip"].every((p) => ws.results?.[p]?.ok) && Object.values(ws.regen).every((s) => s === "idle");
  }, null, { timeout: 45_000 });
  await wsEval(page, "ws.additiveSelection = false");
  const studio = page.getByTestId("parts-panel").locator('[data-studio="studios/bracket.ts"]');
  await studio.getByRole("button", { name: "Expand Stack" }).click();
  const row = (name: string) => studio.locator("div.group\\/row", { hasText: name }).first();
  await row("Clip").getByRole("button", { name: "Hide Clip" }).click();
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket:clip"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row("Clip").getByRole("button", { name: "Hide Clip" })).toBeAttached();
  expect(await wsEval(page, "ws.hidden")).toEqual([]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(row("Clip").getByRole("button", { name: "Show Clip" })).toBeVisible();
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket:clip"]);

  // H toggles a mixed selection in one step; Alt+H shows all in one step.
  await row("Base").click();
  await row("Clip").click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("h");
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket"]);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket:clip"]);
  await row("Lid").getByRole("button", { name: "Hide Lid" }).click();
  await page.keyboard.press("Alt+h");
  expect(await wsEval(page, "ws.hidden")).toEqual([]);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket:clip", "bracket:lid"]);
});
