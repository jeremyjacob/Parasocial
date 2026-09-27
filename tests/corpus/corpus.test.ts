// Geometry regression corpus (PLAN §12): regen -> compare volume, face count, named-entity survival.
// Run `UPDATE_GOLDEN=1 bun test tests/corpus` to accept intentional changes.
import { beforeAll, describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { names, nameIndex, resolveTarget, disambiguate, select, faceOf } from "@parasocial/naming";
import { load, engineFor, regen, summarize, type Golden } from "./harness";

const root = join(import.meta.dir, "../..");
const update = !!process.env.UPDATE_GOLDEN;
beforeAll(load);

describe("golden: examples + corpus parts", () => {
  const files = [...new Glob("examples/*/studios/*.ts").scanSync(root), ...new Glob("tests/corpus/studios/*.ts").scanSync(root)].sort();
  for (const f of files) {
    // every part the script exports: the default is golden/<file>.json, a named export golden/<file>#<name>.json
    const { parts } = engineFor(join(root, f));
    for (const { id, export: key } of parts) {
      test(key === "default" ? f : `${f} ${key}`, async () => {
        const { engine } = engineFor(join(root, f));
        const r = regen(engine, id);
        expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
        const g = summarize(r.record);
        const gp = join(import.meta.dir, "golden", f.replace(/\//g, "__") + (key === "default" ? "" : `#${key}`) + ".json");
        if (update || !existsSync(gp)) writeFileSync(gp, JSON.stringify(g, null, 2) + "\n");
        const want: Golden = JSON.parse(readFileSync(gp, "utf8"));
        expect(g.valid).toBe(true);
        expect(g.faces).toBe(want.faces);
        expect(g.edges).toBe(want.edges);
        expect(g.vertices).toBe(want.vertices);
        expect(Math.abs(g.volume - want.volume) / want.volume).toBeLessThan(1e-6);
        expect(Math.abs(g.area - want.area) / want.area).toBeLessThan(1e-6);
        expect(g.faceNames).toEqual(want.faceNames);
      });
    }
  }
});

describe("fillets survive upstream dimension changes", () => {
  test("filletchain across a parameter sweep", async () => {
    const { engine } = engineFor(join(root, "tests/corpus/studios/filletchain.ts"));
    const base = regen(engine, "filletchain");
    const want = names(base.record!, "face").map((n) => n.str).sort();
    const verticals = want.filter((n) => n.startsWith("filletchain/verticals · fillet"));
    expect(verticals.length).toBe(4);
    for (const ov of [{ width: 30 }, { width: 110, depth: 70 }, { height: 5 }, { radius: 6 }, { width: 80, height: 30, radius: 1 }]) {
      const r = regen(engine, "filletchain", ov);
      expect(r.ok).toBe(true);
      expect(names(r.record!, "face").map((n) => n.str).sort()).toEqual(want);
    }
  });

  test("bracket fillet + chamfer names across width/thickness", async () => {
    const { engine } = engineFor(join(root, "examples/bracket/studios/bracket.ts"));
    const want = names(regen(engine, "bracket").record, "face").map((n) => n.str).sort();
    for (const width of [30, 45, 80]) for (const thickness of [1.5, 3, 8]) {
      const r = regen(engine, "bracket", { width, thickness });
      expect(names(r.record!, "face").map((n) => n.str).sort()).toEqual(want);
    }
  });
});

describe("split faces", () => {
  test("a split face resolves to all descendants and disambiguates by point", async () => {
    const { engine } = engineFor(join(root, "tests/corpus/studios/split.ts"));
    const r = regen(engine, "split");
    const rec = r.record!;
    const top = nameIndex(rec, "face").get("split/block · cap.end")!;
    expect(top.length).toBe(2); // the slot split the top face in two
    const rightPoint: [number, number, number] = [20, 0, 10];
    const res = resolveTarget(rec, { kind: "face", name: "split/block · cap.end", point: rightPoint });
    expect(res.status).toBe("name");
    expect(res.indices.length).toBe(2);
    const one = disambiguate(rec, "face", res.indices, rightPoint);
    expect(faceOf(rec, one).center[0]).toBeGreaterThan(0);
    // move the slot: still two descendants, still the right one by point
    const r2 = regen(engine, "split", { slotX: -10 });
    const res2 = resolveTarget(r2.record!, { kind: "face", name: "split/block · cap.end", point: rightPoint });
    expect(res2.indices.length).toBe(2);
    expect(faceOf(r2.record!, disambiguate(r2.record!, "face", res2.indices, rightPoint)).center[0]).toBeGreaterThan(0);
    // the long side faces are notched, not split
    expect(nameIndex(rec, "face").get("split/block · side · outline/bottom")!.length).toBe(1);
    // the slot's own faces are named from the tool
    expect(select(rec, "face", "slotTool").length).toBe(3);
  });
});

describe("anchors: name, nearest, orphaned", () => {
  test("a note on a fillet face orphans when the fillet goes away; a nearby face falls back to nearest", async () => {
    const { engine } = engineFor(join(root, "tests/corpus/studios/filletchain.ts"));
    const r = regen(engine, "filletchain");
    const rec = r.record!;
    const fname = names(rec, "face").find((n) => n.str.startsWith("filletchain/verticals · fillet"))!.str;
    const idx = nameIndex(rec, "face").get(fname)![0];
    const p = faceOf(rec, idx).center;
    expect(resolveTarget(rec, { kind: "face", name: fname, point: p }).status).toBe("name");
    // pretend the name changed (e.g. the fillet was re-tagged): nearest entity within tolerance
    const near = resolveTarget(rec, { kind: "face", name: "gone", point: p });
    expect(near.status).toBe("nearest");
    expect(near.indices[0]).toBe(idx);
    // far from any face -> orphaned, never a guess
    expect(resolveTarget(rec, { kind: "face", name: "gone", point: [500, 500, 500] }).status).toBe("orphaned");
  });
});
