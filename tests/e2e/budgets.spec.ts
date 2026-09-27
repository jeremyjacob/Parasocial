// §9 performance budgets, measured in the page (timestamps from the browser, not Playwright
// round trips) against the bracket example. Each test logs its number so regressions are visible.
import { test, expect, openExample, viewportPoint, wsEval } from "./fixtures";
import type { Page } from "@playwright/test";

const report = (name: string, ms: number, budget: number) => console.log(`budget ${name}: ${ms.toFixed(1)} ms (budget ${budget} ms)`);

const bboxWidth = (page: Page) => wsEval<number>(page, "ws.results.bracket.bbox.max[0] - ws.results.bracket.bbox.min[0]");

/** Median of in-page timings of `fn` (a string evaluated with `ws` in scope, resolving when done). */
async function median(page: Page, runs: number, fn: (i: number) => string) {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) out.push(await page.evaluate(`(async () => { const ws = globalThis.__ws; const t0 = performance.now(); await (${fn(i)}); return performance.now() - t0; })()`));
  out.sort((a, b) => a - b);
  return out[Math.floor(out.length / 2)];
}

/** Resolves once the part's bbox width reaches `w` and the viewer has rendered it. */
const untilWidth = (w: number) => `new Promise((res) => { const tick = () => { const r = ws.results.bracket; if (r?.bbox && Math.abs(r.bbox.max[0] - r.bbox.min[0] - ${w}) < 0.01) requestAnimationFrame(() => res()); else requestAnimationFrame(tick); }; tick(); })`;

test.describe("§9 budgets", () => {
  test.beforeEach(async ({ page, user }) => {
    void user;
    await openExample(page, "bracket", ["bracket"]);
  });

  test("hover preselect within the current frame", async ({ page }) => {
    const p = await viewportPoint(page, 0.62, 0.55);
    for (let i = 0; i < 5; i++) await page.mouse.move(p.x + i * 3, p.y);
    await page.waitForTimeout(50);
    const { pick, frame } = await wsEval<{ pick: number; frame: number }>(page, "({ pick: ws.viewer.stats.lastPickMs, frame: ws.viewer.stats.lastFrameMs })");
    report("hover pick", pick, 8);
    report("hover frame", pick + frame, 16);
    expect(pick + frame).toBeLessThan(16);
  });

  test("click to select with Properties updated < 50 ms", async ({ page }) => {
    const p = await viewportPoint(page, 0.62, 0.55);
    await page.mouse.move(p.x, p.y);
    // warm the describe path once, then measure a fresh selection of a different face
    await page.mouse.click(p.x, p.y);
    await expect(page.getByTestId("stable-name")).toBeVisible();
    await page.keyboard.press("Escape");
    const q = await viewportPoint(page, 0.45, 0.66);
    await page.mouse.move(q.x, q.y);
    await page.evaluate(() => {
      const g = globalThis as any;
      g.__clickT = null;
      g.__propsT = null;
      addEventListener("pointerdown", (e) => (g.__clickT = e.timeStamp), { capture: true, once: true });
      const mo = new MutationObserver(() => {
        const el = document.querySelector("[data-testid=stable-name]");
        if (g.__clickT !== null && el?.textContent) (g.__propsT = performance.now()), mo.disconnect();
      });
      mo.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.mouse.click(q.x, q.y);
    await page.waitForFunction(() => (globalThis as any).__propsT !== null);
    const ms = await page.evaluate(() => (globalThis as any).__propsT - (globalThis as any).__clickT);
    report("click → Properties", ms, 50);
    expect(ms).toBeLessThan(50);
  });

  test("warm open < 1 s to an interactive model; kernel ready on repeat visit < 1.5 s", async ({ page }) => {
    await page.reload();
    const t = await page.evaluate(
      () =>
        new Promise<{ interactive: number; kernel: number }>((res) => {
          let interactive = 0;
          const tick = () => {
            const ws = (globalThis as any).__ws;
            if (!interactive && ws?.viewer?.meshOf("bracket") && ws.results?.bracket) interactive = performance.now();
            if (interactive && ws.kernelReady) return res({ interactive, kernel: performance.now() });
            requestAnimationFrame(tick);
          };
          tick();
        }),
    );
    report("warm open → interactive", t.interactive, 1000);
    report("repeat visit → kernel ready", t.kernel, 1500);
    expect(t.interactive).toBeLessThan(1000);
    expect(t.kernel).toBeLessThan(1500);
  });

  test("script write → regenerated result, warm engine < 1 s; cold edit < 2 s", async ({ page }) => {
    await page.waitForFunction(() => (globalThis as any).__ws?.buffers !== undefined);
    // warm write: a parameter default change reruns only downstream ops
    const warm = await page.evaluate(`(async () => {
      const ws = globalThis.__ws;
      const path = "parts/bracket.ts";
      const b = ws.openBuffer(path);
      const t0 = performance.now();
      ws.editBuffer(path, b.content.replace('param("width", 40', 'param("width", 44'));
      await ${untilWidth(44)};
      return performance.now() - t0;
    })()`);
    report("write → result (warm)", warm as number, 1000);
    expect(warm).toBeLessThan(1000);
    // cold: a structural edit (new thickness default) invalidates the base sketch and everything after it
    const cold = await page.evaluate(`(async () => {
      const ws = globalThis.__ws;
      const path = "parts/bracket.ts";
      const b = ws.openBuffer(path);
      const t0 = performance.now();
      ws.editBuffer(path, b.content.replace('param("thickness", 3', 'param("thickness", 4.25'));
      await new Promise((res) => { const tick = () => { const r = ws.results.bracket; if (r?.bbox && Math.abs(r.bbox.max[2] - 4.25) < 0.01) requestAnimationFrame(() => res()); else requestAnimationFrame(tick); }; tick(); });
      return performance.now() - t0;
    })()`);
    report("typical edit → result (cold op cache)", cold as number, 2000);
    expect(cold).toBeLessThan(2000);
    expect(await bboxWidth(page)).toBeCloseTo(44, 1);
  });
});

test("param scrub step, cached upstream < 100 ms to the new mesh on screen", async ({ page, user }) => {
  void user;
  await openExample(page, "enclosure", ["body", "lid"]);
  // the wall thickness only feeds the shell: box and fillets upstream stay cached
  const step = (v: number) => `(async () => { const prev = ws.results.body; ws.scrub("body", "wall", ${v}); await new Promise((res) => { const tick = () => (ws.results.body !== prev && ws.regen.body !== "running" ? requestAnimationFrame(() => res()) : requestAnimationFrame(tick)); tick(); }); })()`;
  for (const v of [2.2, 2.4]) await page.evaluate(`(async () => { const ws = globalThis.__ws; await ${step(v)}; })()`);
  const ms = await median(page, 5, (i) => step(2.6 + i * 0.2));
  const t = await wsEval<{ cacheHits: number; total: number }>(page, "ws.results.body.timings");
  await wsEval(page, "ws.endScrub()");
  report("scrub step", ms, 100);
  console.log(`  engine ${t.total.toFixed(1)} ms, cache hits ${t.cacheHits}`);
  expect(t.cacheHits).toBeGreaterThan(0);
  expect(ms).toBeLessThan(100);
});
