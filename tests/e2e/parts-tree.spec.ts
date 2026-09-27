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
  await expect(studio.getByRole("group").getByRole("treeitem")).toHaveText([/Base/, /Lid/, /Clip/]);
  await page.screenshot({ path: "test-results/parts-tree.png" });

  // selecting a part bolds its studio's name; clicking the studio row selects the studio itself (not each part)
  const row = (name: string) => studio.locator("div.group\\/row", { hasText: name }).first();
  await row("Lid").click();
  await expect(row("Stack").locator(".row-main")).toHaveClass(/font-medium/);
  await expect(row("Stack")).not.toHaveClass(/bg-accent-subtle/);
  await row("Stack").click();
  await expect(row("Stack")).toHaveClass(/bg-accent-subtle/);
  await expect(row("Lid")).not.toHaveClass(/bg-accent-subtle/);
  expect(await wsEval(page, "ws.selection.length")).toBe(3);
  await page.screenshot({ path: "test-results/parts-tree-studio-selected.png", clip: { x: 0, y: 40, width: 260, height: 300 } });

  // isolating the studio: the icon stays on the studio row, not its parts
  await studio.getByRole("button", { name: "Isolate Stack" }).click();
  expect(await wsEval(page, "ws.isolated")).toEqual(["bracket", "bracket:lid", "bracket:clip"]);
  await expect(row("Lid").getByRole("button", { name: /Show all parts|Isolate/ })).toHaveAttribute("aria-pressed", "false");
  await studio.getByRole("button", { name: "Show all parts" }).click();
  // isolating one part greys out the rest of the tree
  await row("Clip").getByRole("button", { name: "Isolate Clip" }).click();
  await expect(row("Lid").locator(".row-main")).toHaveClass(/text-fg-tertiary/);
  await expect(row("Clip").locator(".row-main")).not.toHaveClass(/text-fg-tertiary/);
  await page.screenshot({ path: "test-results/parts-tree-isolated.png", clip: { x: 0, y: 40, width: 260, height: 300 } });
  await row("Clip").getByRole("button", { name: "Show all parts" }).click();

  // context menu: Export… (no Hide / Isolate); ⌘E exports the selection
  await row("Lid").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Export…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^(Hide|Isolate|Open code)$/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Export…" }).click();
  await expect(page.getByTestId("export-dialog")).toContainText("Lid");
  await page.keyboard.press("Escape");
  await row("Stack").click();
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.getByTestId("export-dialog")).toContainText("Stack (3 parts)");
  const download = page.waitForEvent("download");
  await page.getByTestId("export-go").click();
  expect((await download).suggestedFilename()).toBe("Stack.step");
  await page.keyboard.press("Escape");

  // the studio row's eye hides all of its parts; collapsing hides the children
  await studio.getByRole("button", { name: "Hide Stack" }).click();
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket", "bracket:lid", "bracket:clip"]);
  await studio.getByRole("button", { name: "Collapse Stack" }).click();
  await expect(studio.getByRole("group")).toHaveCount(0);
});
