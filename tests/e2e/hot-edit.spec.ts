import { test, expect, openExample, wsEval } from './fixtures';

test('hot edits keep assembly copies, selection, camera and section view intact', async ({ page, user }) => {
  void user;
  await openExample(page, 'hinge', ['box', 'box:lid', 'box:drawer']);
  await wsEval(page, "ws.setActiveStudio('studios/mechanism.ts')");
  const instances = ['mechanism/box', 'mechanism/box:drawer', 'mechanism/box:lid'];
  await expect.poll(() => wsEval(page, 'ws.viewer.partIds().sort()')).toEqual(instances);
  await wsEval(page, `(() => {
    ws.select([{ part: 'mechanism/box', kind: 'face', index: 0 }]);
    ws.setHidden('mechanism/box:drawer', true);
    ws.section = { axis: 'X', offset: 0, flip: false };
    ws.viewer.setView('iso', false);
    window.__hotEditRemovals = [];
    const remove = ws.viewer.removePart.bind(ws.viewer);
    ws.viewer.removePart = (id) => { window.__hotEditRemovals.push(id); remove(id); };
  })()`);
  const camera = await wsEval(page, 'ws.viewer.cameraState()');
  const bodyKey = await wsEval(page, 'ws.results.box.key');
  const lidKey = await wsEval(page, "ws.results['box:lid'].key");

  // A partial regeneration: only the lid changes; the body and drawer stay mounted.
  await wsEval(page, "ws.setParam('box:lid', 'thickness', '4', 4)");
  await expect.poll(() => wsEval(page, "ws.results['box:lid'].key")).not.toBe(lidKey);
  await expect.poll(() => wsEval(page, "Object.values(ws.regen).every((s) => s === 'idle')")).toBe(true);
  expect(await wsEval(page, 'ws.viewer.partIds().sort()')).toEqual(instances);
  expect(await wsEval(page, 'ws.results.box.key')).toBe(bodyKey);

  // A script write with unchanged geometry exercises the fast update path too.
  await page.evaluate(() => {
    const ws = (window as any).__ws;
    const path = 'studios/box.ts';
    const b = ws.openBuffer(path);
    ws.editBuffer(path, b.content + '\n// Hot edit regression\n');
    return ws.saveBuffer(path);
  });
  await expect.poll(() => wsEval(page, "ws.scripts.find((s) => s.path === 'studios/box.ts').content.includes('Hot edit regression')")).toBe(true);
  await expect.poll(() => wsEval(page, "Object.values(ws.regen).every((s) => s === 'idle')")).toBe(true);
  await wsEval(page, 'ws.sync()');
  expect(await wsEval(page, 'ws.viewer.partIds().sort()')).toEqual(instances);
  expect(await wsEval(page, 'window.__hotEditRemovals')).toEqual([]);
  expect(await wsEval(page, 'ws.selection')).toEqual([{ part: 'mechanism/box', kind: 'face', index: 0 }]);
  expect(await wsEval(page, 'ws.hidden')).toEqual(['mechanism/box:drawer']);
  expect(await wsEval(page, 'ws.section')).toEqual({ axis: 'X', offset: 0, flip: false });
  expect(await wsEval(page, 'ws.viewer.cameraState()')).toEqual(camera);
});
