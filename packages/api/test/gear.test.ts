// gear(): spur, helical and herringbone involute gears in one operation, every face named, and the
// centre distance / mesh phase helpers that place a pair in mesh.
import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { OpCache, names } from "@parasocial/naming";
import { PartContext, runPart } from "../src/internal";
import { part, gear, measure, type Solid, type GearOpts } from "../src";

beforeAll(async () => {
  await loadKernel();
});

function run(fn: () => Solid) {
  const cache = new OpCache();
  cache.begin();
  let s!: Solid;
  const r = runPart(part("g", () => (s = fn())), new PartContext({ part: "g", file: "studios/g.ts", cache }));
  return { s, r, errors: r.problems.filter((p) => p.severity === "error").map((p) => p.message), warnings: r.problems.filter((p) => p.severity === "warning").map((p) => p.message) };
}
const faceNames = (s: Solid) => names(s.record, "face").map((n) => n.str);
const build = (o: GearOpts) => {
  const x = run(() => gear(o));
  expect(x.errors).toEqual([]);
  return x.s;
};

test("spur gear: one face per flank, tip and root, named by tooth", () => {
  const s = build({ teeth: 20, module: 2, width: 10, bore: 8, tag: "g" });
  const n = faceNames(s);
  expect(n.length).toBe(20 * 4 + 3);
  expect(new Set(n).size).toBe(n.length);
  for (const k of [0, 7, 19]) for (const f of [`tooth${k} · flankL`, `tooth${k} · flankR`, `tip${k}`, `root${k}`]) expect(n).toContain(`g/g · ${f}`);
  for (const f of ["face.start", "face.end", "bore"]) expect(n).toContain(`g/g · ${f}`);
  expect(s.isValid()).toBe(true);
  const bb = s.boundingBox();
  expect(bb.max[0]).toBeCloseTo(22, 3); // tip radius m(N + 2) / 2, tooth 0 on +X
  expect(bb.min[2]).toBeCloseTo(0, 6);
  expect(bb.max[2]).toBeCloseTo(10, 6);
  // tooth 0 is centred on the phase: its tip face straddles +X
  expect(s.faces("tip0").length).toBe(1);
  expect(s.faces("bore").length).toBe(1);
});

test("a helical gear has the spur's volume (the same section, turned), and a herringbone is one solid in one operation", () => {
  const spur = build({ teeth: 20, module: 2, width: 10, tag: "g" });
  const helical = build({ teeth: 20, module: 2, width: 10, helix: 20, tag: "g" });
  expect(helical.volume()).toBeCloseTo(spur.volume(), -1);
  expect(Math.abs(helical.volume() / spur.volume() - 1)).toBeLessThan(5e-4);
  const x = run(() => gear({ teeth: 20, module: 2, width: 10, helix: 30, herringbone: true, bore: 8, tag: "g" }));
  expect(x.errors).toEqual([]);
  const hb = x.s;
  expect(hb.record.type).toBe("gear");
  expect(hb.record.inputs).toEqual([]);
  expect(hb.isValid()).toBe(true);
  const n = faceNames(hb);
  expect(new Set(n).size).toBe(n.length);
  expect(n).toContain("g/g · tooth3 · flankL · front");
  expect(n).toContain("g/g · tooth3 · flankR · rear");
  expect(n).toContain("g/g · tip3 · front");
  expect(n).toContain("g/g · root3 · rear");
  expect(Math.abs((hb.volume() + Math.PI * 16 * 10) / spur.volume() - 1)).toBeLessThan(5e-4);
});

test("gear validation: undercut, apex, backlash, internal", () => {
  expect(run(() => gear({ teeth: 10, module: 2, width: 5 })).errors[0]).toMatch(/10 teeth at 20° are undercut; use at least 18 teeth, profileShift ≥ 0\.42, or allowUndercut: true/);
  const allowed = run(() => gear({ teeth: 10, module: 2, width: 5, allowUndercut: true }));
  expect(allowed.errors).toEqual([]);
  expect(allowed.warnings[0]).toMatch(/undercut/);
  expect(run(() => gear({ teeth: 10, module: 2, width: 5, profileShift: 0.45 })).errors).toEqual([]);
  expect(run(() => gear({ teeth: 20, module: 2, width: 5, helix: 20, herringbone: { apex: 6 } })).errors[0]).toMatch(/apex \(z = 6\) must lie inside the face width/);
  expect(run(() => gear({ teeth: 20, module: 2, width: 5, herringbone: true })).errors[0]).toMatch(/needs a helix angle/);
  expect(run(() => gear({ teeth: 20, module: 1, width: 5, backlash: 2 })).errors[0]).toMatch(/backlash 2 leaves no tooth/);
  expect(run(() => gear({ teeth: 20, module: 1, width: 5, internal: true })).errors[0]).toMatch(/internal \(ring\) gears aren't supported yet/);
  expect(run(() => gear({ teeth: 20, module: 1, width: 5, bore: 40 })).errors[0]).toMatch(/bore 40 reaches the root circle/);
});

test("centerDistance and meshPhase put a pair in mesh: touching, not overlapping", () => {
  const pairs: [GearOpts, Omit<GearOpts, "width">, number][] = [
    [{ teeth: 30, module: 2, width: 6, phase: 7 }, { teeth: 18, module: 2 }, 40],
    [{ teeth: 14, module: 2, width: 6, profileShift: 0.3 }, { teeth: 20, module: 2, profileShift: 0.2 }, 0],
  ];
  for (const [A, B, ang] of pairs) {
    for (const off of [0, 0.5]) {
      let ov = 0,
        d = 0;
      const x = run(() => {
        const a = gear({ ...A, tag: "a" });
        d = gear.centerDistance(a, B);
        const t = (ang * Math.PI) / 180;
        const b = gear({ ...B, width: 6, phase: gear.meshPhase(a, B, ang) + (off * 360) / B.teeth, tag: "b" }).translate([d * Math.cos(t), d * Math.sin(t), 0]);
        ov = measure.overlap(a, b);
        return a;
      });
      expect(x.errors).toEqual([]);
      if (off === 0) expect(ov).toBeLessThan(1e-3);
      else expect(ov).toBeGreaterThan(10);
    }
  }
  // standard centre distance, and with profile shift the operating one (inv αw = inv α + 2 Σx tan α / Σz)
  expect(run(() => { expect(gear.centerDistance({ teeth: 30, module: 2 }, { teeth: 18, module: 2 })).toBe(48); return gear({ teeth: 20, module: 1, width: 1 }); }).errors).toEqual([]);
  expect(run(() => { expect(gear.centerDistance({ teeth: 14, module: 2, profileShift: 0.3 }, { teeth: 20, module: 2, profileShift: 0.2 })).toBeCloseTo(34.9147, 3); return gear({ teeth: 20, module: 1, width: 1 }); }).errors).toEqual([]);
}, 60_000);

test("gear connectors: axis on Z and a pitch frame on the pitch circle at tooth 0", () => {
  const s = build({ teeth: 24, module: 1.5, width: 5, phase: 90, tag: "g" });
  const pitch = s.meta.connectors!.pitch[0];
  expect(pitch.origin[0]).toBeCloseTo(0, 9);
  expect(pitch.origin[1]).toBeCloseTo(18, 9);
  expect(s.meta.connectors!.axis[0].z).toEqual([0, 0, 1]);
  expect(s.meta.gear!.pitchRadius).toBe(18);
});
