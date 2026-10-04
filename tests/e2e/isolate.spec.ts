import type { Page } from "@playwright/test";
import { test, expect, openExample, wsEval } from "./fixtures";

const MULTI = `import { part, box } from "parasocial";

export const name = "Stack";

export default part("Base", ({ color }) => box(40, 30, 6).color(color.auto()));
export const lid = part("Lid", ({ color }) => box(40, 30, 2).translate([0, 0, 10]).color(color.auto()));
export const clip = part("Clip", ({ color }) => box(6, 4, 4).translate([30, 0, 0]).color(color.auto()));
`;
const PARTS = ["bracket", "bracket:lid", "bracket:clip"];

async function openStack(page: Page) {
  await openExample(page, "bracket", ["bracket"]);
  await wsEval(page, `(ws.openBuffer("studios/bracket.ts"), ws.editBuffer("studios/bracket.ts", ${JSON.stringify(MULTI)}), ws.saveBuffer("studios/bracket.ts"))`);
  await page.waitForFunction((ps) => {
    const ws = (globalThis as any).__ws;
    return ps.every((p: string) => ws.results?.[p]?.ok) && Object.values(ws.regen).every((s) => s === "idle");
  }, PARTS, { timeout: 45_000 });
  await wsEval(page, "(ws.additiveSelection = false, ws.viewer.setView('iso', false))");
}

/** A page point over one of the part's faces (the one the viewer picks there). */
async function pointOn(page: Page, part: string) {
  const s = await wsEval<{ x: number; y: number } | null>(page, `(() => {
    const v = ws.viewer;
    for (let i = 0; i < 6; i++) {
      const c = v.entityCenter({ part: ${JSON.stringify(part)}, kind: "face", index: i });
      const s = c && v.project(c);
      if (s && v.pick(s.x, s.y)?.part === ${JSON.stringify(part)}) return s;
    }
    return null;
  })()`);
  expect(s, `a visible face of ${part}`).not.toBeNull();
  const b = (await page.getByTestId("viewport").boundingBox())!;
  return { x: b.x + s!.x, y: b.y + s!.y };
}

/** What the viewer shows: each shown part's visibility. */
const visible = (page: Page) => wsEval<Record<string, boolean>>(page, `Object.fromEntries(ws.shownParts.map((p) => [p, ws.viewer.parts.get(p).group.visible]))`);

test("right-click a part in the viewport → Isolate; Esc restores what was shown, hidden parts stay hidden", async ({ page, user }) => {
  void user;
  await openStack(page);
  const studio = page.getByTestId("parts-panel").locator('[data-studio="studios/bracket.ts"]');
  await studio.getByRole("button", { name: "Expand Stack" }).click();
  const row = (name: string) => studio.locator("div.group\\/row", { hasText: name }).first();
  // hidden before isolating
  await row("Clip").getByRole("button", { name: "Hide Clip" }).click();
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket:clip"]);

  // right-click selects the part under the cursor, then the menu acts on it
  const p = await pointOn(page, "bracket:lid");
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  const item = page.getByRole("menuitem", { name: /^Isolate/ });
  await expect(item).toBeVisible();
  await expect(item).toContainText(/⇧\s*H/);
  expect(await wsEval(page, "ws.selection.map((r) => r.part)")).toEqual(["bracket:lid"]);
  await page.screenshot({ path: "test-results/isolate-menu.png" });
  await item.click();

  await expect(page.getByTestId("isolated")).toContainText("Isolated");
  await expect(page.getByTestId("isolated")).toContainText("Esc to exit");
  expect(await visible(page)).toEqual({ bracket: false, "bracket:lid": true, "bracket:clip": false });
  // the tree shows what the viewport shows; the hide state from before is untouched
  await expect(row("Base").getByRole("button", { name: "Show Base" })).toBeAttached();
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket:clip"]);
  await page.screenshot({ path: "test-results/isolate-on.png" });

  // the viewport menu offers the way out; Esc closes the menu without leaving isolation
  const q = await pointOn(page, "bracket:lid");
  await page.mouse.move(q.x, q.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Exit isolate/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: /^Exit isolate/ })).toHaveCount(0);
  expect(await wsEval(page, "ws.isolated")).toEqual(["bracket:lid"]);

  // Esc leaves isolation, keeping the selection; Clip was hidden before and stays hidden
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("isolated")).toHaveCount(0);
  expect(await visible(page)).toEqual({ bracket: true, "bracket:lid": true, "bracket:clip": false });
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket:clip"]);
  expect(await wsEval(page, "ws.selection.map((r) => r.part)")).toEqual(["bracket:lid"]);
});

test("Shift+H toggles isolate for the selection; plain H still hides; not while typing", async ({ page, user }) => {
  void user;
  await openStack(page);
  const studio = page.getByTestId("parts-panel").locator('[data-studio="studios/bracket.ts"]');
  await studio.getByRole("button", { name: "Expand Stack" }).click();
  const row = (name: string) => studio.locator("div.group\\/row", { hasText: name }).first();
  await row("Base").click();
  await row("Clip").click({ modifiers: ["ControlOrMeta"] });

  // typing in an input never isolates
  const filter = page.getByLabel("Filter studios and parts");
  await filter.click();
  await page.keyboard.press("Shift+H");
  await expect(filter).toHaveValue("H");
  expect(await wsEval(page, "ws.isolated")).toBeNull();
  await filter.fill("");
  await filter.blur();

  await page.keyboard.press("Shift+H");
  await expect(page.getByTestId("isolated")).toBeVisible();
  expect(await visible(page)).toEqual({ bracket: true, "bracket:lid": false, "bracket:clip": true });
  // H while isolated hides from the isolation; the visibility from before comes back on exit
  await row("Base").click();
  await page.keyboard.press("h");
  expect(await visible(page)).toEqual({ bracket: false, "bracket:lid": false, "bracket:clip": true });
  expect(await wsEval(page, "ws.hidden")).toEqual([]);
  await page.keyboard.press("Shift+H");
  await expect(page.getByTestId("isolated")).toHaveCount(0);
  expect(await visible(page)).toEqual({ bracket: true, "bracket:lid": true, "bracket:clip": true });

  // plain H is still hide
  await page.keyboard.press("h");
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket"]);
  expect(await wsEval(page, "ws.isolated")).toBeNull();

  // the parts tree menu isolates too, and the palette lists the command with its shortcut
  await row("Lid").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Isolate/ }).click();
  expect(await wsEval(page, "ws.isolated")).toEqual(["bracket:lid"]);
  await page.getByTestId("isolated").click();
  expect(await wsEval(page, "ws.isolated")).toBeNull();
  expect(await wsEval(page, "ws.hidden")).toEqual(["bracket"]);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Isolate");
  await expect(page.getByRole("option", { name: /Isolate selected parts/ })).toContainText(/⇧\s*H/);
});
