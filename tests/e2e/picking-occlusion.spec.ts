import { test, expect, openExample, wsEval } from "./fixtures";

type Hit = { part: string; kind: string; index: number };
type OcclusionCase = {
  ortho: boolean;
  kind: string;
  blocked: (Hit | null)[];
  boxes: Hit[][];
  tab: Hit[];
  exposed: (Hit | null)[];
};

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`selection occlusion at DPR ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor });

    test("foreground surfaces block every selection filter and box selection", async ({ page, user }) => {
      void user;
      await openExample(page, "bracket", ["bracket"]);
      const results = await wsEval<OcclusionCase[]>(page, `(() => {
        const v = ws.viewer, V = v.camera.position.constructor;
        for (const id of v.partIds()) v.removePart(id);
        // Two squares, separated by less than the old vertex depth bias. The larger front
        // square covers all rear features, while its own boundary lies outside their snap radii.
        function square(id, half, z, features = true) {
          const vertices = [[-half,-half,z], [half,-half,z], [half,half,z], [-half,half,z]];
          const edgePositions = vertices.flatMap((a, i) => [...a, ...vertices[(i+1)%4]]);
          v.setPart({ id, hiddenEdges: features ? undefined : new Set([0,1,2,3]), color: "#aaaaaa", vertices, faceEdges: [[0,1,2,3]], mesh: {
            positions: new Float32Array(vertices.flat()), normals: new Float32Array(vertices.flatMap(() => [0,0,1])),
            indices: new Uint32Array([0,1,2,0,2,3]), faceRanges: new Uint32Array([0,6]),
            edgePositions: new Float32Array(edgePositions), edgeRanges: new Uint32Array([0,2,2,2,4,2,6,2])
          }});
        }
        square("assembly:rear", 1, 0);
        square("assembly:front", 2, 0.001);
        const results = [];
        for (const ortho of [false, true]) {
          v.useOrtho = ortho;
          const cam = v.camera;
          cam.position.set(0,0,10); cam.up.set(0,1,0); cam.lookAt(0,0,0);
          cam.near = 0.1; cam.far = 1000;
          if (ortho) { cam.left = -4; cam.right = 4; cam.top = 3; cam.bottom = -3; }
          cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
          const points = [[-1,-1,0], [0,-1,0], [0,0,0]].map(p => v.project(new V(...p)));
          const W = v.container.clientWidth, H = v.container.clientHeight;
          for (const kind of ["all", "vertex", "edge", "face", "part", "none"]) {
            v.filter = Object.fromEntries(["face", "edge", "vertex", "part"].map(k => [k, kind === "all" || kind === k]));
            v.setVisible("assembly:front", true);
            const blocked = points.map(p => v.pick(p.x, p.y));
            const boxes = ["window", "crossing"].map(mode => v.pickRect(0,0,W,H,mode));
            const tab = v.facesUnder(points[2].x, points[2].y);
            v.setVisible("assembly:front", false);
            const exposed = points.map(p => v.pick(p.x, p.y));
            results.push({ ortho, kind, blocked, boxes, tab, exposed });
          }
          // The vertex itself is covered, even though its enlarged picking disc sticks out.
          square("assembly:front", 1.002, 0.001, false);
          v.setVisible("assembly:front", true);
          v.filter = { face: false, edge: false, vertex: true, part: false };
          const blocked = points.map(p => v.pick(p.x, p.y));
          const boxes = ["window", "crossing"].map(mode => v.pickRect(0,0,W,H,mode));
          v.setVisible("assembly:front", false);
          const exposed = points.map(p => v.pick(p.x, p.y));
          results.push({ ortho, kind: "vertex", blocked, boxes, tab: [], exposed });
          square("assembly:front", 2, 0.001);
        }
        return results;
      })()`);
      for (const r of results) {
        const context = JSON.stringify(r);
        expect(r.blocked.every(h => !h || h.part === "assembly:front"), context).toBe(true);
        expect(r.boxes.flat().every((h) => h.part === "assembly:front"), context).toBe(true);
        expect(r.tab.every((h) => h.part === "assembly:front"), context).toBe(true);
        if (["vertex", "edge", "none"].includes(r.kind)) expect(r.blocked, context).toEqual([null, null, null]);
        else expect(r.blocked.every(h => h?.part === "assembly:front"), context).toBe(true);
        if (r.kind !== "none") expect(r.exposed.some((h) => h?.part === "assembly:rear"), context).toBe(true);
        else expect(r.exposed, context).toEqual([null, null, null]);
      }
    });
  });
}
