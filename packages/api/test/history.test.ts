// History-based selection (createdBy / @tag) and adjacency helpers.
import { beforeAll, expect, test } from "bun:test";
import { loadKernel, isValid } from "@parasocial/kernel";
import { OpCache } from "@parasocial/naming";
import { PartContext, runPart } from "../src/internal";
import { part, sketch, plane, box, cylinder, param, type Solid, type EntitySet } from "../src";

beforeAll(async () => {
  await loadKernel();
});

const run = (name: string, fn: () => Solid, cache = new OpCache(), overrides: Record<string, number> = {}) => {
  cache.begin();
  return runPart(part(name, fn), new PartContext({ part: name, file: `studios/${name}.ts`, cache, overrides }));
};

/** A drum with a fin fused onto its side: the union's new edges are the fin root. */
function finned(capture: (s: { body: Solid; fin: Solid; joined: Solid }) => void = () => {}) {
  const r = param("r", 20);
  const body = cylinder(r, 40, { tag: "drum" });
  const fin = box(30, 4, 20, { tag: "fin" }).translate([r - 5, -2, 10], { tag: "finMove" });
  const joined = body.union(fin, { tag: "finUnion" });
  capture({ body, fin, joined });
  return joined;
}

test("createdBy: a boolean's new edges are the intersection edges, wherever the fin sits", () => {
  let roots!: EntitySet;
  const cache = new OpCache();
  const r = run("winch", () => {
    const j = finned();
    roots = j.edges({ createdBy: "finUnion" });
    return j;
  }, cache);
  expect(r.problems).toEqual([]);
  // where the fin's 4 faces meet the drum: 2 lines + 2 arcs, each arc split by the drum's seam at +X;
  // none of the fin's own edges, none of the drum's
  expect(roots.length).toBe(6);
  expect(roots.names().every((n) => n.includes("drum · side") && n.includes("winch/fin"))).toBe(true);
  for (const e of roots.list()) {
    // every root edge lies on the drum surface (radius 20 from the axis)
    expect(Math.abs(Math.hypot(e.center[0], e.center[1]) - 20)).toBeLessThan(1e-6);
  }
  // selector-string forms agree
  let at!: EntitySet, fn!: EntitySet, viaSolid!: EntitySet;
  run("winch", () => {
    const j = finned();
    at = j.edges("@finUnion");
    fn = j.edges("createdBy(finUnion)");
    viaSolid = j.edges().createdBy(j);
    return j;
  }, cache);
  expect(at.names()).toEqual(roots.names());
  expect(fn.names()).toEqual(roots.names());
  expect(viaSolid.names()).toEqual(roots.names());
  // still the root after the drum radius changes (no coordinates involved)
  let roots2!: EntitySet;
  run("winch", () => {
    const j = finned();
    roots2 = j.edges({ createdBy: "finUnion" });
    return j;
  }, cache, { r: 24 });
  expect(roots2.length).toBe(6);
  for (const e of roots2.list()) expect(Math.abs(Math.hypot(e.center[0], e.center[1]) - 24)).toBeLessThan(1e-6);
});

test("createdBy: fillet the fin root by history", () => {
  const r = run("winch", () => finned().fillet("@finUnion", 1.5, { tag: "rootFillet" }));
  expect(r.problems).toEqual([]);
  expect(isValid(r.record!.shape)).toBe(true);
  let faces!: EntitySet;
  run("winch", () => {
    const s = finned().fillet("@finUnion", 1.5, { tag: "rootFillet" });
    faces = s.faces({ createdBy: "rootFillet" });
    return s;
  });
  expect(faces.length).toBe(6); // one per root edge
  expect(new Set(faces.list().map((f) => f.surface)).has("plane")).toBe(false);
});

test("createdBy: what extrude, fillet and transforms create", () => {
  let side!: EntitySet, caps!: EntitySet, finFaces!: EntitySet, drumAfter!: EntitySet, fillets!: EntitySet, filletEdges!: EntitySet;
  const r = run("plate", () => {
    const plate = sketch(plane.XY).rect(40, 20, { tag: "outline" }).extrude(5, { tag: "plate" });
    side = plate.faces({ createdBy: "plate", where: "#Z" });
    caps = plate.faces({ createdBy: "plate", where: "|Z" });
    const { joined } = (() => {
      let c!: { body: Solid; fin: Solid; joined: Solid };
      finned((x) => (c = x));
      return c;
    })();
    // the fin's faces were made by the box; the move keeps them its own
    finFaces = joined.faces({ createdBy: "fin" });
    drumAfter = joined.faces({ createdBy: "drum" });
    const f = plate.fillet(plate.edges("|Z"), 2, { tag: "round" });
    fillets = f.faces().createdBy("round");
    filletEdges = f.edges({ createdBy: "round" });
    return f;
  });
  expect(r.problems).toEqual([]);
  expect(side.length).toBe(4);
  expect(caps.length).toBe(2);
  // fin: 6 box faces, the one inside the drum is gone
  expect(finFaces.length).toBe(5);
  expect(drumAfter.length).toBeGreaterThanOrEqual(3);
  expect(fillets.length).toBe(4);
  expect(fillets.list().every((f) => f.surface === "cylinder")).toBe(true);
  // a fillet creates its 4 faces' boundary edges: 2 straight-ish seams per face... at least the arcs on the caps
  expect(filletEdges.length).toBeGreaterThanOrEqual(8);
});

test("adjacency: edges of a face, faces of an edge, neighbours", () => {
  let top!: EntitySet, topEdges!: EntitySet, of!: EntitySet, around!: EntitySet, verts!: EntitySet, neighbours!: EntitySet;
  run("blk", () => {
    const b = box(10, 20, 30, { tag: "blk" });
    top = b.faces(">Z");
    topEdges = top.edges();
    of = b.edges().of(top);
    around = topEdges.faces();
    verts = top.vertices();
    neighbours = top.faces();
    return b;
  });
  expect(topEdges.length).toBe(4);
  expect(of.names()).toEqual(topEdges.names());
  // faces along the top's edges: the top and the 4 sides
  expect(around.length).toBe(5);
  expect(around.names()).toContain(top.names()[0]);
  expect(verts.length).toBe(4);
  // a face's neighbours across its edges leave the face itself out
  expect(neighbours.length).toBe(4);
  expect(neighbours.names()).not.toContain(top.names()[0]);
});

test("createdBy errors name the tags that exist", () => {
  const msg = run("winch", () => finned().fillet("@finUnoin", 1)).problems[0]?.message ?? "";
  expect(msg).toMatch(/no operation "finUnoin" made this solid/);
  expect(msg).toMatch(/finUnion/);
  const m2 = run("winch", () => {
    finned().edges({ createdBy: "@finUnion" });
    return box(1, 1, 1);
  }).problems[0]?.message ?? "";
  expect(m2).toMatch(/without "@"/);
});
