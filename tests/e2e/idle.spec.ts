import { test, expect, openExample, wsEval } from './fixtures';

test('idle workspace stops animation work and wakes for camera and geometry changes', async ({ page, user }) => {
  void user;
  await openExample(page, 'bracket', ['bracket']);
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const w = window as any;
    w.__idleCallbacks = 0;
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => request((time) => {
      w.__idleCallbacks++;
      callback(time);
    });
  });

  const stats = () => page.evaluate(() => ({
    callbacks: (window as any).__idleCallbacks as number,
    frames: (window as any).__ws.viewer.stats.frames as number,
  }));
  async function expectIdle() {
    // Let camera easing, mesh crossfades and the deferred thumbnail finish first.
    await page.waitForTimeout(2500);
    const before = await stats();
    await page.waitForTimeout(750);
    expect(await stats()).toEqual(before);
    const running = await page.getByRole('progressbar', { includeHidden: true }).evaluateAll((bars) =>
      bars.flatMap((bar) => bar.getAnimations({ subtree: true })).filter((a) => a.playState === 'running').length,
    );
    expect(running).toBe(0);
  }

  await expectIdle();
  const before = await stats();
  await wsEval(page, "ws.viewer.setView('front', true)");
  await expect.poll(() => wsEval(page, 'ws.viewer.cameraState().position[2] - ws.viewer.cameraState().target[2]')).toBeCloseTo(0, 5);
  expect((await stats()).frames).toBeGreaterThan(before.frames);
  await expectIdle();

  const key = await wsEval(page, 'ws.results.bracket.key');
  await wsEval(page, "ws.setParam('bracket', 'width', '44', 44)");
  await expect.poll(() => wsEval(page, 'ws.results.bracket.key')).not.toBe(key);
  await expect.poll(() => wsEval(page, "Object.values(ws.regen).every((s) => s === 'idle')")).toBe(true);
  await expectIdle();

  // A disposed viewer must never restart its frame loop, even if a late caller invalidates it.
  await wsEval(page, '(() => { ws.viewer.dispose(); ws.viewer.requestRender(); })()');
  const disposed = await stats();
  await page.waitForTimeout(250);
  expect(await stats()).toEqual(disposed);
});
