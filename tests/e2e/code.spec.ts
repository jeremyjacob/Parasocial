import { test, expect, openExample, wsEval } from "./fixtures";
import type { Page } from "@playwright/test";

// Code mode (§8): unsaved edits preview live, ⌘S saves a version, History restores one,
// and a change saved elsewhere while this buffer is dirty raises a conflict banner.

const PATH = "parts/bracket.ts";
const widthOf = (page: Page) => wsEval<number>(page, "ws.results.bracket.bbox.max[0] - ws.results.bracket.bbox.min[0]");
const heightOf = (page: Page) => wsEval<number>(page, "ws.results.bracket.bbox.max[2] - ws.results.bracket.bbox.min[2]");
const scriptContent = (page: Page) => page.evaluate((p) => (globalThis as any).__ws.scripts.find((s: any) => s.path === p)?.content as string, PATH);

async function openCode(page: Page) {
  await page.keyboard.press("Meta+Backslash");
  await expect(page.getByTestId("code-editor")).toBeVisible();
  await page.waitForFunction(() => (globalThis as any).__editor?.getValue().includes('param("width", 40'), null, { timeout: 30_000 });
}

/** Replace text in the open Monaco model (goes through the editor, like typing). */
async function replaceInEditor(page: Page, from: string, to: string) {
  await page.evaluate(
    ([from, to]) => {
      const ed = (globalThis as any).__editor;
      const m = ed.getModel();
      const match = m.findMatches(from, false, false, true, null, false)[0];
      if (!match) throw new Error(`not found: ${from}`);
      ed.executeEdits("e2e", [{ range: match.range, text: to }]);
    },
    [from, to] as const,
  );
}

async function save(page: Page) {
  await page.evaluate(() => (globalThis as any).__editor.focus());
  await page.keyboard.press("Meta+s");
}

test("edit → unsaved preview, ⌘S saves a version, History restores the previous one", async ({ page, user }) => {
  void user;
  await openExample(page, "bracket", ["bracket"]);
  const v0 = await wsEval<number>(page, "ws.versions.length");
  await openCode(page);
  await expect(page.getByTestId("unsaved-preview")).toHaveCount(0);

  // edit: width 40 → 60 previews live without saving
  await replaceInEditor(page, 'param("width", 40', 'param("width", 60');
  await expect(page.getByTestId("unsaved-preview")).toBeVisible();
  await expect.poll(() => wsEval<string[]>(page, "ws.dirty")).toEqual([PATH]);
  await expect.poll(() => widthOf(page)).toBeCloseTo(60, 0);
  await expect(page.getByTestId("code-tab").filter({ hasText: "bracket.ts" }).getByLabel("Unsaved")).toBeVisible();
  expect(await scriptContent(page)).toContain('param("width", 40');
  expect(await wsEval<number>(page, "ws.versions.length")).toBe(v0);

  // ⌘S saves a version
  await save(page);
  await expect.poll(() => wsEval<string[]>(page, "ws.dirty")).toEqual([]);
  await expect(page.getByTestId("unsaved-preview")).toHaveCount(0);
  await expect.poll(() => wsEval<number>(page, "ws.versions.length")).toBe(v0 + 1);
  await expect.poll(() => scriptContent(page)).toContain('param("width", 60');
  expect(await widthOf(page)).toBeCloseTo(60, 0);

  // History tab shows it on top
  await page.getByRole("tab", { name: "History" }).click();
  const rows = page.getByTestId("history-panel").getByTestId("version-row");
  await expect(rows).toHaveCount(v0 + 1);
  await expect(rows.first()).toContainText("Edit bracket.ts");
  await expect(rows.first()).toContainText(`v${v0 + 1}`);

  // revert: open the previous version read-only, then Restore (a new version at the tip)
  await rows.nth(1).click();
  await expect(page.getByTestId("version-banner")).toContainText(`v${v0}`);
  await page.getByTestId("restore-version").click();
  await expect(page.getByTestId("version-banner")).toHaveCount(0);
  await expect.poll(() => wsEval<number>(page, "ws.versions.length")).toBe(v0 + 2);
  await expect.poll(() => scriptContent(page)).toContain('param("width", 40');
  await expect.poll(() => widthOf(page)).toBeCloseTo(40, 0);
  await expect(rows).toHaveCount(v0 + 2);
  await expect(rows.first()).toContainText(`v${v0 + 2}`);
  // the (clean) editor buffer follows the restored script
  await expect.poll(() => page.evaluate(() => (globalThis as any).__editor.getValue() as string)).toContain('param("width", 40');
  expect(await wsEval<string[]>(page, "ws.dirty")).toEqual([]);
});

test.describe("conflict: saved in another tab while this buffer is dirty", () => {
  test.describe.configure({ timeout: 180_000 }); // two workspaces in one test
  let other: Page;

  test.beforeEach(async ({ page, user }) => {
    void user;
    await openExample(page, "bracket", ["bracket"]);
    await openCode(page);
    // page A: an unsaved edit (thickness 3 → 4)
    await replaceInEditor(page, 'param("thickness", 3,', 'param("thickness", 4,');
    await expect.poll(() => wsEval<string[]>(page, "ws.dirty")).toEqual([PATH]);
    await expect.poll(() => heightOf(page)).toBeCloseTo(4, 1);

    // page B: same user (shared cookies), same document, saves width 40 → 50
    other = await page.context().newPage();
    await other.goto(page.url());
    await other.waitForFunction(() => {
      const ws = (globalThis as any).__ws;
      return ws?.kernelReady && ws.results?.bracket && !ws.results.bracket.empty;
    }, null, { timeout: 45_000 });
    await openCode(other);
    await replaceInEditor(other, 'param("width", 40', 'param("width", 50');
    await expect.poll(() => wsEval<string[]>(other, "ws.dirty")).toEqual([PATH]);
    await save(other);
    await expect.poll(() => wsEval<string[]>(other, "ws.dirty")).toEqual([]);

    // page A learns about it: banner, its own edit still previewing
    await expect(page.getByTestId("conflict-banner")).toBeVisible({ timeout: 30_000 }); // via sync; slow under load
    await expect(page.getByTestId("conflict-banner")).toContainText("bracket.ts was changed by you (another tab)");
    expect(await wsEval<string[]>(page, "ws.dirty")).toEqual([PATH]);
    expect(await page.evaluate(() => (globalThis as any).__editor.getValue() as string)).toContain('param("thickness", 4,');
  });

  test.afterEach(async () => {
    await other?.close();
  });

  const editorText = (page: Page) => page.evaluate(() => (globalThis as any).__editor.getValue() as string);
  const bufferText = (page: Page) => page.evaluate((p) => (globalThis as any).__ws.buffers[p]?.content as string, PATH);

  test("Reload takes their version and drops mine", async ({ page }) => {
    await page.getByTestId("conflict-banner").getByRole("button", { name: "Reload" }).click();
    await expect(page.getByTestId("conflict-banner")).toHaveCount(0);
    await expect.poll(() => wsEval<string[]>(page, "ws.dirty")).toEqual([]);
    const buf = await bufferText(page);
    expect(buf).toContain('param("width", 50');
    expect(buf).toContain('param("thickness", 3,');
    await expect(page.getByTestId("unsaved-preview")).toHaveCount(0);
    await expect.poll(() => widthOf(page)).toBeCloseTo(50, 0);
    await expect.poll(() => heightOf(page)).toBeCloseTo(3, 1);
  });

  // regression: Reload must replace the editor text too, not just the buffer
  test("Reload also shows their version in the editor", async ({ page }) => {
    await page.getByTestId("conflict-banner").getByRole("button", { name: "Reload" }).click();
    await expect(page.getByTestId("conflict-banner")).toHaveCount(0);
    await expect.poll(() => editorText(page), { timeout: 5_000 }).toContain('param("width", 50');
    expect(await editorText(page)).toContain('param("thickness", 3,');
  });

  test("Keep mine keeps my buffer, and saving it overwrites theirs", async ({ page }) => {
    const versions = await wsEval<number>(page, "ws.versions.length");
    await page.getByTestId("conflict-banner").getByRole("button", { name: "Keep mine" }).click();
    await expect(page.getByTestId("conflict-banner")).toHaveCount(0);
    // still dirty against the new base
    expect(await wsEval<string[]>(page, "ws.dirty")).toEqual([PATH]);
    const mine = await page.evaluate(() => (globalThis as any).__editor.getValue() as string);
    expect(mine).toContain('param("thickness", 4,');
    expect(mine).toContain('param("width", 40');
    await expect(page.getByTestId("unsaved-preview")).toBeVisible();

    await save(page);
    await expect.poll(() => wsEval<string[]>(page, "ws.dirty")).toEqual([]);
    await expect(page.getByTestId("conflict-banner")).toHaveCount(0);
    await expect.poll(() => wsEval<number>(page, "ws.versions.length")).toBe(versions + 1);
    await expect.poll(() => scriptContent(page)).toContain('param("thickness", 4,');
    expect(await scriptContent(page)).toContain('param("width", 40');
    await expect.poll(() => heightOf(page)).toBeCloseTo(4, 1);
    await expect.poll(() => widthOf(page)).toBeCloseTo(40, 0);
    // the other tab (clean) reloads to what I saved
    await expect.poll(() => other.evaluate(() => (globalThis as any).__editor.getValue() as string)).toContain('param("thickness", 4,');
  });
});
