import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const viewerRoot = fileURLToPath(new URL("../../packages/viewer/", import.meta.url));

test("orbiting preserves edge visibility in every display mode", async ({ page }) => {
  await page.route("**/__display_mode_test", (route) => route.fulfill({
    contentType: "text/html",
    body: '<div id="viewport" style="position:relative;width:800px;height:600px"></div>',
  }));
  await page.goto("/__display_mode_test");
  await page.evaluate(async (root) => {
    const { Viewer } = await import(/* @vite-ignore */ `/@fs/${root}src/viewer.ts`);
    const THREE = await import(/* @vite-ignore */ "/node_modules/.vite/deps/three.js");
    const viewer = new Viewer(document.getElementById("viewport")!, { viewCube: false, maxDpr: 1, reducedMotion: true });
    const box = new THREE.BoxGeometry(80, 60, 40);
    const edges = new THREE.EdgesGeometry(box);
    viewer.setPart({
      id: "box", color: "#9ab8e8", faceEdges: box.groups.map(() => []),
      mesh: {
        positions: box.attributes.position.array,
        normals: box.attributes.normal.array,
        indices: new Uint32Array(box.index.array),
        faceRanges: new Uint32Array(box.groups.flatMap((g: { start: number; count: number }) => [g.start, g.count])),
        edgePositions: edges.attributes.position.array,
        edgeRanges: new Uint32Array(Array.from({ length: edges.attributes.position.count / 2 }, (_, i) => [i * 2, 2]).flat()),
      },
    });
    viewer.setCameraState({ position: [200, -260, 180], target: [0, 0, 0], up: [0, 0, 1], ortho: false }, false);
    (window as any).viewer = viewer;
  }, viewerRoot);

  // Revisit shaded after the edge modes to catch stale state across mode changes.
  for (const mode of ["shaded", "shadedEdges", "wireframe", "hiddenLine", "shaded"] as const) {
    const before = await page.evaluate((mode) => {
      const v = (window as any).viewer;
      v.setDisplayMode(mode);
      return v.cameraState().position;
    }, mode);
    const visible = () => page.evaluate(() => (window as any).viewer.parts.get("box").edgeLines.visible);
    expect(await visible(), `${mode} before orbit`).toBe(mode !== "shaded");
    await page.mouse.move(400, 300);
    await page.keyboard.down("Alt");
    await page.mouse.down();
    await page.mouse.move(450, 330, { steps: 4 });
    expect(await visible(), `${mode} during orbit`).toBe(mode !== "shaded");
    await page.mouse.up();
    await page.keyboard.up("Alt");
    expect(await page.evaluate(() => (window as any).viewer.cameraState().position)).not.toEqual(before);
    expect(await visible(), `${mode} after orbit`).toBe(mode !== "shaded");
  }
});
