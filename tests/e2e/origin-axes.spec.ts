import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const viewerRoot = fileURLToPath(new URL("../../packages/viewer/", import.meta.url));

test("grid renders behind axes and parts while axes respect part depth", async ({ page }) => {
  await page.route("**/__origin_axes_test", (route) => route.fulfill({
    contentType: "text/html",
    body: '<div id="viewport" style="width:800px;height:600px"></div>',
  }));
  await page.goto("/__origin_axes_test");
  const results = await page.evaluate(async (root) => {
    const { Viewer } = await import(/* @vite-ignore */ `/@fs/${root}src/viewer.ts`);
    const threeUrl = "/node_modules/.vite/deps/three.js";
    const THREE = await import(/* @vite-ignore */ threeUrl);
    const viewer = new Viewer(document.getElementById("viewport")!, { viewCube: false, maxDpr: 1, preserveDrawingBuffer: true });
    const box = new THREE.BoxGeometry(80, 60, 4).translate(0, 0, 2);
    viewer.setPart({
      id: "plate", color: "#9ab8e8", faceEdges: box.groups.map(() => []),
      mesh: {
        positions: box.attributes.position.array,
        normals: box.attributes.normal.array,
        indices: new Uint32Array(box.index.array),
        faceRanges: new Uint32Array(box.groups.flatMap((g: { start: number; count: number }) => [g.start, g.count])),
        edgePositions: new Float32Array(), edgeRanges: new Uint32Array(),
      },
    });
    viewer.setHelpers({ grid: true });
    const drawOrder: string[] = [];
    viewer.groundGrid.mesh.onBeforeRender = () => drawOrder.push("grid");
    for (const axis of viewer.triad.children) axis.onBeforeRender = () => drawOrder.push("axis");
    viewer.parts.get("plate").faceMesh.onBeforeRender = () => drawOrder.push("part");
    const gl = viewer.renderer.getContext();
    const sample = (point: number[]) => {
      const p = new THREE.Vector3(...point).project(viewer.camera);
      const pixels = new Uint8Array(5 * 5 * 4);
      gl.readPixels(Math.round((p.x + 1) * 400) - 2, Math.round((p.y + 1) * 300) - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    // The first three samples are behind the plate; z=10 is in front of it.
    const points = [[10, 0, 0], [0, 10, 0], [0, 0, 2], [0, 0, 10], [0, 0, 30]];
    const results = [];
    try {
      for (const ortho of [true, false]) for (const ao of [false, true]) {
        viewer.ao = ao;
        viewer.setCameraState({ position: [120, -160, 110], target: [0, 0, 0], up: [0, 0, 1], ortho, orthoHeight: 120 }, false);
        viewer.setHelpers({ origin: false });
        viewer.renderNow();
        const withoutAxes = points.map(sample);
        viewer.setHelpers({ origin: true });
        drawOrder.length = 0;
        viewer.renderNow();
        const differences = points.map((p, i) => sample(p).reduce((sum, value, j) => sum + Math.abs(value - withoutAxes[i][j]), 0));
        results.push({ ortho, ao, differences, drawOrder: [...drawOrder] });
      }
      return results;
    } finally {
      box.dispose();
      viewer.dispose();
    }
  }, viewerRoot);
  for (const result of results) {
    expect(result.drawOrder[0], JSON.stringify(result)).toBe("grid");
    expect(result.differences.slice(0, 3), JSON.stringify(result)).toEqual([0, 0, 0]);
    expect(result.differences[3], JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.differences[4], JSON.stringify(result)).toBeGreaterThan(0);
  }
});
