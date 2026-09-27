import { test, expect, openExample, viewportPoint, wsEval } from "./fixtures";
import type { Page } from "@playwright/test";

// Notes (§6): the note tool, the pencil, threads, and anchors that survive regeneration.

const TOP = [0.62, 0.55] as const; // bracket/base · cap.end
const RIGHT = [0.7, 0.72] as const; // bracket/base · side · outline/right

const pins = (page: Page) => page.evaluate(() => (globalThis as any).__nc.pins.map((p: any) => ({ ...p, point: [...p.point] })));

async function clickAt(page: Page, [fx, fy]: readonly [number, number]) {
  const p = await viewportPoint(page, fx, fy);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
}

async function postNote(page: Page, at: readonly [number, number], text: string) {
  await page.keyboard.press("c");
  await expect.poll(() => wsEval<string>(page, "ws.tool")).toBe("note");
  await clickAt(page, at);
  await expect(page.getByTestId("note-composer")).toBeVisible();
  await page.getByTestId("note-text").fill(text);
  await page.keyboard.press("Enter");
  await expect.poll(() => wsEval<number>(page, "ws.notes.length")).toBe(1);
  await expect(page.getByTestId("note-composer")).toHaveCount(0);
}

test.describe("notes", () => {
  test.beforeEach(async ({ page, user }) => {
    void user;
    await openExample(page, "bracket", ["bracket"]);
  });

  test("note tool: click a face, post, pin, thread reply, resolve", async ({ page }) => {
    await postNote(page, TOP, "Wall too thin here, make @thickness 4");
    const note = await wsEval<any>(page, "JSON.parse(JSON.stringify(ws.notes[0]))");
    expect(note.status).toBe("Open");
    expect(note.anchor.targets[0]).toMatchObject({ kind: "face", part: "bracket", name: "bracket/base · cap.end" });
    expect(note.anchor.snapshot).toBeTruthy();

    // a pin on the geometry, resolved by its stable name
    await expect(page.getByTestId("pin")).toHaveCount(1);
    await expect(page.getByTestId("pin")).toHaveText("1");
    await expect.poll(async () => (await pins(page))[0]?.resolution).toBe("name");

    // listed in the Notes tab (the composer switched to it)
    const card = page.getByTestId("notes-panel").getByTestId("note-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("#1");
    await expect(card).toContainText("Face · Bracket");
    await expect(card).toContainText("Wall too thin here");
    await expect(card).toContainText("Open");

    // reply in the thread (⌘↩)
    const reply = card.getByRole("textbox", { name: "Reply" });
    await reply.fill("Agreed, 4 mm should do it");
    await reply.press("Meta+Enter");
    await expect(card).toContainText("Agreed, 4 mm should do it");
    await expect(reply).toHaveValue("");
    await expect.poll(() => wsEval<number>(page, "ws.notes[0].messages?.length ?? 0")).toBe(2);

    // resolve from the actions menu: the default filter hides resolved notes
    await card.getByRole("button", { name: "Note actions" }).click();
    await page.getByRole("menuitem", { name: "Resolve" }).click();
    await expect.poll(() => wsEval<string>(page, "ws.notes[0].status")).toBe("Resolved");
    await expect(page.getByTestId("notes-panel").getByTestId("note-card")).toHaveCount(0);
    await expect(page.getByTestId("notes-panel")).toContainText("No notes match these filters.");
  });

  test("pencil: strokes, the composer waits for a pause, then post", async ({ page }) => {
    await page.keyboard.press("p");
    await expect.poll(() => wsEval<string>(page, "ws.tool")).toBe("pencil");
    await expect(page.getByTestId("pencil-options")).toBeVisible();

    // Record, in the page, what the composer does around each stroke. Picking under the pen can be
    // slow on a loaded machine (hundreds of ms per pointermove), so timing is measured where it
    // happens rather than from the test runner.
    await page.evaluate(() => {
      const nc = (globalThis as any).__nc;
      const rec: any = ((globalThis as any).__pen = { downs: [] as number[], ups: [] as any[], shownAt: 0 });
      addEventListener("pointerdown", () => rec.downs.push(performance.now()));
      addEventListener("pointerup", () => rec.ups.push({ t: performance.now(), strokes: nc.draft?.strokeIDs.length ?? 0, shown: nc.composerShown, composer: !!document.querySelector('[data-testid="note-composer"]') }));
      new MutationObserver(() => {
        if (!rec.shownAt && document.querySelector('[data-testid="note-composer"]')) rec.shownAt = performance.now();
      }).observe(document.body, { childList: true, subtree: true });
    });

    // Every point on the top face: under load pointermoves coalesce to their end point. The second
    // stroke is drawn left of the first, clear of where the composer will pop up (right of it), in
    // case the page is too slow for it to start within the pause.
    const [a, b, c, d] = await Promise.all([viewportPoint(page, 0.55, 0.55), viewportPoint(page, 0.7, 0.62), viewportPoint(page, 0.38, 0.5), viewportPoint(page, 0.45, 0.6)]);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 2 });
    await page.mouse.up();
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(d.x, d.y, { steps: 2 });
    await page.mouse.up();
    await expect.poll(() => wsEval<number>(page, "globalThis.__nc.draft?.strokeIDs.length ?? 0"), { timeout: 45_000 }).toBe(2);
    await expect(page.getByTestId("note-composer")).toBeVisible({ timeout: 30_000 });

    const pen = await wsEval<{ downs: number[]; ups: any[]; shownAt: number }>(page, "globalThis.__pen");
    expect(pen.ups.map((u) => u.strokes)).toEqual([1, 2]);
    // the first stroke never pops the composer up
    expect(pen.ups[0]).toMatchObject({ shown: false, composer: false });
    // a stroke started within the pause keeps it hidden (only checkable when the page was fast enough)
    if (pen.downs[1] - pen.ups[0].t < 800) expect(pen.ups[1]).toMatchObject({ shown: false, composer: false });
    // it appears ~900ms after the stroke that preceded it, never sooner
    expect(pen.shownAt).toBeGreaterThan(pen.ups[0].t);
    const lastUp = Math.max(...pen.ups.map((u) => u.t).filter((t) => t < pen.shownAt));
    expect(pen.shownAt - lastUp).toBeGreaterThanOrEqual(850);

    expect(await wsEval<number>(page, "globalThis.__nc.draft.targets.length")).toBeGreaterThan(0);
    await page.getByTestId("note-text").fill("Round this corner off");
    await page.getByTestId("note-post").click();
    await expect.poll(() => wsEval<number>(page, "ws.notes.length")).toBe(1);
    const n = await wsEval<any>(page, "JSON.parse(JSON.stringify(ws.notes[0]))");
    expect(n.anchor.targets[0].part).toBe("bracket");
    // the strokes now belong to the note
    await expect.poll(() => page.evaluate((id) => (globalThis as any).__nc.strokes.filter((s: any) => s.noteID === id).length, n.id)).toBe(2);
    await expect(page.getByTestId("pin")).toHaveCount(1);
    await expect(page.getByTestId("notes-panel").getByTestId("note-card")).toContainText("Round this corner off");
  });

  test("pencil: mouse-down draws immediately, clicks persist, and undo/redo works after the composer appears", async ({ page }) => {
    await page.keyboard.press("p");
    const p = await viewportPoint(page, ...TOP);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await expect.poll(() => wsEval<number>(page, "ws.viewer.markup.children.length")).toBe(1);
    expect(await wsEval<string>(page, "ws.viewer.markup.children[0].userData.id")).toBe("live");
    await page.mouse.up();
    await expect.poll(() => wsEval<number>(page, "globalThis.__nc.strokes.length")).toBe(1);
    expect(await wsEval<number>(page, "globalThis.__nc.strokes[0].points.length")).toBe(1);
    await expect(page.getByTestId("note-composer")).toBeVisible();
    await expect(page.getByTestId("note-text")).not.toBeFocused();

    await page.keyboard.press("Meta+z");
    await expect.poll(() => wsEval<number>(page, "globalThis.__nc.strokes.length")).toBe(0);
    await expect.poll(() => wsEval<number>(page, "ws.viewer.markup.children.length")).toBe(0);
    expect(await wsEval<number>(page, "globalThis.__nc.draftStrokeIDs.length")).toBe(0);
    await page.keyboard.press("Meta+Shift+z");
    await expect.poll(() => wsEval<number>(page, "globalThis.__nc.draftStrokeIDs.length")).toBe(1);
    await expect.poll(() => wsEval<number>(page, "ws.viewer.markup.children.length")).toBe(1);

    // Posting after undo must not attach a deleted stroke.
    await page.keyboard.press("Meta+z");
    await expect.poll(() => wsEval<number>(page, "globalThis.__nc.draftStrokeIDs.length")).toBe(0);
    await page.getByTestId("note-text").fill("Keep this face flat");
    await page.getByTestId("note-post").click();
    await expect.poll(() => wsEval<number>(page, "ws.notes.length")).toBe(1);
    expect(await wsEval<number>(page, "globalThis.__nc.strokes.length")).toBe(0);
  });

  test("pencil: preserves the starting point off the model and erasing is undoable", async ({ page }) => {
    await page.keyboard.press("p");
    const a = await viewportPoint(page, 0.15, 0.2);
    const b = await viewportPoint(page, ...TOP);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await expect.poll(() => wsEval<number>(page, "ws.viewer.markup.children.length")).toBe(1);
    await page.mouse.move(b.x, b.y, { steps: 3 });
    await page.mouse.up();
    await expect.poll(() => wsEval<number>(page, "globalThis.__nc.strokes.length")).toBe(1);
    const start = await page.evaluate(() => {
      const v = (globalThis as any).__viewer;
      const s = (globalThis as any).__nc.strokes[0];
      const p = v.camera.position.clone().fromArray(s.points[0]);
      const rect = document.querySelector('[data-testid="viewport"]')!.getBoundingClientRect();
      const screen = v.project(v.toWorld(s.part, p));
      return { x: screen.x + rect.left, y: screen.y + rect.top };
    });
    expect(start.x).toBeCloseTo(a.x, 0);
    expect(start.y).toBeCloseTo(a.y, 0);
    await page.evaluate(() => { (globalThis as any).__nc.eraser = true; });
    await page.mouse.click(a.x, a.y);
    await expect.poll(() => wsEval<number>(page, "globalThis.__nc.strokes.length")).toBe(0);
    await page.keyboard.press("Meta+z");
    await expect.poll(() => wsEval<number>(page, "globalThis.__nc.draftStrokeIDs.length")).toBe(1);
    await page.keyboard.press("Meta+Shift+z");
    await expect.poll(() => wsEval<number>(page, "globalThis.__nc.draftStrokeIDs.length")).toBe(0);
  });

  test("notes use cached geometry when the engine is unavailable", async ({ page }) => {
    await expect.poll(() => page.evaluate(async () => (await (await caches.open('parasocial-derived-v1')).keys()).length)).toBeGreaterThan(0);
    // Reload with a real startup failure: only the saved mesh and names can render the model.
    await page.route("http://localhost:5174/**", (route) => route.abort());
    await page.reload();
    await expect.poll(() => wsEval<string | null>(page, "ws?.engineError"), { timeout: 40_000 }).toContain("didn't load");
    await expect.poll(() => wsEval<number>(page, "ws.results.bracket?.names?.face.length ?? 0")).toBeGreaterThan(0);
    expect(await wsEval<boolean>(page, "ws.kernelReady")).toBe(false);

    await postNote(page, TOP, "Keep the mounting face flat");
    const note = await wsEval<any>(page, "JSON.parse(JSON.stringify(ws.notes[0]))");
    expect(note.anchor.targets[0]).toMatchObject({ kind: "face", part: "bracket", name: "bracket/base · cap.end" });
    expect(note.anchor.snapshot).toBeTruthy();
    await expect(page.getByTestId("pin")).toHaveCount(1);
    await expect.poll(async () => (await pins(page))[0]?.orphaned).toBe(false);
    expect(await wsEval<boolean>(page, "ws.notes[0].orphaned")).toBe(false);

    // No cached result is also not evidence that the note's geometry has disappeared.
    await page.evaluate(async () => {
      const ws = (globalThis as any).__ws;
      ws.results = {};
      await (globalThis as any).__nc.resolveAll();
    });
    expect((await pins(page))[0]).toMatchObject({ orphaned: false, resolution: "unknown" });
  });

  test("a failed save keeps the note text and can be retried", async ({ page }) => {
    await page.keyboard.press("c");
    await clickAt(page, TOP);
    const input = page.getByTestId("note-text");
    await input.fill("Do not lose this feedback");
    await page.route("**/api/blobs?**", (route) => route.fulfill({ status: 503, body: "unavailable" }));
    await page.getByTestId("note-post").click();
    await expect(page.getByText("Couldn't save the note. Try again.", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("Do not lose this feedback");
    expect(await wsEval<number>(page, "ws.notes.length")).toBe(0);

    await page.unroute("**/api/blobs?**");
    let uploads = 0;
    let releaseUpload!: () => void;
    const pendingUpload = new Promise<void>((resolve) => { releaseUpload = resolve; });
    await page.route("**/api/blobs?**", async (route) => {
      uploads++;
      await pendingUpload;
      await route.continue();
    });
    await page.getByTestId("note-post").click();
    await expect.poll(() => uploads).toBe(1);
    await input.press("Enter");
    await input.press("Enter");
    releaseUpload();
    await expect.poll(() => wsEval<number>(page, "ws.notes.length")).toBe(1);
    await expect(page.getByTestId("note-composer")).toHaveCount(0);
    await expect(page.getByTestId("notes-panel").getByTestId("note-card")).toContainText("Do not lose this feedback");
    expect(uploads).toBe(1);
  });

  test("a note re-anchors after a param change", async ({ page }) => {
    await postNote(page, RIGHT, "Check the clearance on this end");
    const name = await wsEval<string>(page, "ws.notes[0].anchor.targets[0].name");
    expect(name).toBe("bracket/base · side · outline/right");
    await expect.poll(async () => (await pins(page))[0]?.resolution).toBe("name");
    const before = (await pins(page))[0].point as number[];
    expect(before[0]).toBeCloseTo(20, 0);

    // width 40 → 70: the right end face moves from x=20 to x=35
    await page.getByRole("tab", { name: "Params" }).click();
    const width = page.getByTestId("params-panel").getByRole("spinbutton").nth(1);
    await width.click();
    await width.fill("70");
    await width.press("Enter");
    await expect.poll(() => wsEval<number>(page, "ws.results.bracket.bbox.max[0] - ws.results.bracket.bbox.min[0]")).toBeCloseTo(70, 0);

    // the pin follows its face by stable name, not by the old point
    await expect.poll(async () => (await pins(page))[0]?.point[0], { timeout: 20_000 }).toBeCloseTo(35, 0);
    const after = (await pins(page))[0];
    expect(after.resolution).toBe("name");
    expect(after.orphaned).toBe(false);
    expect(await wsEval<boolean>(page, "ws.notes[0].orphaned")).toBe(false);
    await expect(page.getByTestId("pin")).toHaveCount(1);
    await page.getByRole("tab", { name: "Notes" }).click();
    await expect(page.getByTestId("note-card")).not.toContainText("Can't find its geometry");
  });
});
