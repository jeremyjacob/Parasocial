import { test, expect, openExample, wsEval } from './fixtures';

test('busy agents animate without continuous style work or stationary geometry redraws', async ({ page, user }) => {
  void user;
  await openExample(page, 'bracket', ['bracket']);
  await wsEval(page, `(async () => {
    const { mutators } = await import('/@fs${process.cwd()}/packages/sync/src/mutators.ts');
    const part = ws.partInfos[0];
    // Stress the activity UI without generating extra geometry.
    ws.partInfos = [part, ...Array.from({ length: 39 }, (_, i) => ({ ...part, id: 'activity:' + i, name: 'Activity part ' + i }))];
    for (const [i, status] of ['working', 'writing', 'working'].entries()) {
      const id = crypto.randomUUID();
      await ws.zero.mutate(mutators.agent.start({ id, clientName: 'Activity agent ' + i, documentID: ws.documentID })).client;
      await ws.zero.mutate(mutators.agent.setStatus({ id, status, detail: { path: part.file } })).client;
    }
  })()`);
  await page.getByRole('button', { name: 'Expand Bracket', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(2500);
  const running = () => page.getByTestId('parts-panel').evaluate((tree) =>
    tree.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
  );
  expect(await running()).toBeGreaterThanOrEqual(40);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const frames = await wsEval<number>(page, 'ws.viewer.stats.frames');
  const before = await metrics();
  await page.waitForTimeout(1000);
  const after = await metrics();
  console.log('busy agents:', {
    styleRecalculations: after.RecalcStyleCount - before.RecalcStyleCount,
    layouts: after.LayoutCount - before.LayoutCount,
    taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
  });
  expect(after.RecalcStyleCount - before.RecalcStyleCount).toBeLessThanOrEqual(4);
  expect(after.LayoutCount - before.LayoutCount).toBeLessThanOrEqual(4);
  expect(await wsEval<number>(page, 'ws.viewer.stats.frames')).toBe(frames);
  await cdp.detach();
  await page.screenshot({ path: test.info().outputPath('busy-agents.png') });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await running()).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await running()).toBeGreaterThanOrEqual(40);
  await wsEval(page, `(async () => {
    const { mutators } = await import('/@fs${process.cwd()}/packages/sync/src/mutators.ts');
    for (const agent of ws.agents) await ws.zero.mutate(mutators.agent.setStatus({ id: agent.id, status: 'idle' })).client;
  })()`);
  await expect.poll(running).toBe(0);
});

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
