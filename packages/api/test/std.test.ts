import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { OpCache } from "@parasocial/naming";
import { PartContext, runPart, part, type PartBody } from "@parasocial/api/internal";
import { box, cylinder, type Solid } from "../src/solid";
import { std } from "../src/std";
import { measure } from "../src/measure";
import { bearingRings, mgnRailHoles } from "../src/std/parts";

beforeAll(async () => {
  await loadKernel();
});

/** Run `body` in a part; return what `probe` reads off the solid it builds, plus the part run. */
const run = <T>(body: () => Solid, probe: (s: Solid) => T) => {
  const cache = new OpCache();
  cache.begin();
  let out: T | undefined;
  const r = runPart(
    part("P", (() => {
      const s = body();
      out = probe(s);
      return s;
    }) as PartBody),
    new PartContext({ part: "p", file: "studios/p.ts", cache, isUserFile: () => true }),
  );
  if (!r.ok) throw new Error(r.problems.map((p) => p.message).join("\n"));
  return { value: out as T, run: r };
};
const size = (s: Solid) => s.boundingBox().size;
const close = (a: number, b: number, tol = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(tol * Math.max(1, Math.abs(b)));
const hexArea = (af: number) => (Math.sqrt(3) / 2) * af * af;
const disc = (d: number) => (Math.PI * d * d) / 4;

test("ISO 4762 M3x10: head 5.5 × 3, shank 3 × 10, hex socket 2.5 × 1.3", () => {
  const { value: s, run: r } = run(() => std.screw("M3", 10), (s) => s);
  const bb = s.boundingBox();
  close(bb.size[0], 5.5);
  close(bb.min[2], -10);
  close(bb.max[2], 3);
  close(s.volume(), disc(3) * 10 + disc(5.5) * 3 - hexArea(2.5) * 1.3);
  expect(Object.keys(r.connectors ?? {})).toEqual(["head", "top", "tip"]);
  expect(r.connectors!.tip[0].origin).toEqual([0, 0, -10]);
  expect(r.material?.name).toBe("Steel");
  expect(r.ops.some((o) => o.tag === "M3x10-ISO4762")).toBe(true);
});

test("ISO 7380 and ISO 10642 heads", () => {
  const { value: button } = run(() => std.screw("M4", 12, { standard: "ISO7380" }), (s) => s);
  const bb = button.boundingBox();
  close(bb.size[0], 7.6);
  close(bb.min[2], -12);
  // shank, a rim 0.2k high, then a spherical cap up to k = 2.2 (OCCT's bbox of the dome is loose)
  const k = 2.2,
    e = 0.2 * k,
    hc = k - e;
  const cap = (Math.PI * hc * (3 * 3.8 * 3.8 + hc * hc)) / 6;
  // the socket starts under the dome, so integrate what it removes over the hex (grid)
  const c = (k * k - e * e - 3.8 * 3.8) / (2 * (k - e)),
    rad = k - c;
  let socket = 0;
  const n = 400,
    R = 2.5 / Math.sqrt(3),
    step = (2 * R) / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = -R + (i + 0.5) * step,
        y = -R + (j + 0.5) * step;
      // inside a hex with flats parallel to X (apothem 1.25)
      if (Math.abs(y) > 1.25 || Math.abs(y) / 2 + (Math.sqrt(3) / 2) * Math.abs(x) > 1.25) continue;
      socket += (c + Math.sqrt(rad * rad - x * x - y * y) - (k - 1.3)) * step * step;
    }
  close(button.volume(), disc(4) * 12 + disc(7.6) * e + cap - socket);
  const { value: cs } = run(() => std.screw("M5", 20, { standard: "ISO10642" }), (s) => s);
  const b = cs.boundingBox();
  close(b.size[0], 11.2);
  close(b.max[2], 0);
  close(b.min[2], -20);
  // cone (90°) from 11.2 to 5 over 3.1, shank 5 × (20 − 3.1), minus the socket
  const h = (11.2 - 5) / 2;
  const cone = (Math.PI * h * (5.6 * 5.6 + 5.6 * 2.5 + 2.5 * 2.5)) / 3;
  close(cs.volume(), cone + disc(5) * (20 - h) - hexArea(3) * 1.9);
});

test("unknown sizes and standards are friendly errors", () => {
  expect(() => run(() => std.screw("M2" as any, 10, { standard: "ISO10642" }), () => 0)).toThrow(/ISO10642 has no M2; sizes: M3/);
  expect(() => run(() => std.bearing("609x" as any), () => 0)).toThrow(/unknown size "609x"/);
  expect(() => run(() => box(10, 10, 10).hole([5, 5, 10], { screw: "M7" as any }), () => 0)).toThrow(/unknown screw size "M7"/);
});

test("ISO 4032 nut, ISO 7089 washer, heat-set insert", () => {
  const n = run(() => std.nut("M3"), (s) => s).value;
  close(size(n)[2], 2.4);
  close(n.volume(), (hexArea(5.5) - disc(3)) * 2.4);
  // flats parallel to X: width across flats along Y
  close(size(n)[1], 5.5);
  close(size(n)[0], (5.5 * 2) / Math.sqrt(3));
  const w = run(() => std.washer("M8"), (s) => s).value;
  close(w.volume(), (disc(16) - disc(8.4)) * 1.6);
  const i = run(() => std.insert("M3x5.7"), (s) => s).value;
  // modeled as installed: the body fills its recommended hole (Ø4), not the Ø4.6 knurl
  close(i.volume(), (disc(4) - disc(3)) * 5.7);
  close(i.boundingBox().min[2], -5.7);
});

test("bearings: 608 is 8 × 22 × 7, 6802 is 15 × 24 × 5", () => {
  for (const [name, d, D, B] of [["608", 8, 22, 7], ["6802", 15, 24, 5], ["6001", 12, 28, 8], ["625", 5, 16, 5]] as const) {
    const { value: s, run: r } = run(() => std.bearing(name), (s) => s);
    const bb = size(s);
    close(bb[0], D);
    close(bb[2], B);
    const { ri, ro, rec } = bearingRings({ d, D, B });
    close(s.volume(), (disc(D) - disc(d)) * B - 2 * Math.PI * (ro * ro - ri * ri) * rec);
    expect(r.connectors!.bore[0]).toMatchObject({ origin: [0, 0, B / 2], z: [0, 0, 1] });
    expect(std.tables.bearings[name] as unknown).toEqual({ d, D, B });
  }
});

test("circlips and grooves", () => {
  const ring = run(() => std.circlip("DIN471", 8), (s) => s).value;
  close(size(ring)[2], 0.8);
  close(size(ring)[0], 7.6 + 2 * 1.5);
  // the groove cut into an 8 mm shaft leaves the 7.6 groove diameter, 0.9 wide
  const cut = run(() => cylinder(4, 20).subtract(std.circlipGroove("DIN471", 8, { at: [0, 0, 10] })), (s) => s.volume()).value;
  close(cut, disc(8) * 20 - (disc(8) - disc(7.6)) * 0.9);
  // a bore groove in a housing: out to d2 = 23 over 1.1
  const housing = run(() => cylinder(20, 10).subtract(cylinder(11, 10)).subtract(std.circlipGroove("DIN472", 22, { at: [0, 0, 5] })), (s) => s.volume()).value;
  close(housing, (disc(40) - disc(22)) * 10 - (disc(23) - disc(22)) * 1.1);
  const bore = run(() => std.circlip("DIN472", 22), (s) => s.boundingBox()).value;
  close(bore.size[0], 23);
});

test("MGN12 rail: 12 × 8, 25 pitch, holes centered; MGN12H carriage 27 wide, 45.4 long, 13 high", () => {
  expect(mgnRailHoles("MGN12", 200)).toEqual([-87.5, -62.5, -37.5, -12.5, 12.5, 37.5, 62.5, 87.5]);
  const { value: rail, run: rr } = run(() => std.mgnRail("MGN12", 200), (s) => s);
  const b = size(rail);
  close(b[0], 200);
  close(b[1], 12);
  close(b[2], 8);
  const hole = disc(6) * 4.5 + disc(3.5) * (8 - 4.5);
  close(rail.volume(), 200 * 12 * 8 - 8 * hole);
  expect(rr.connectors!.bolt.length).toBe(8);
  expect(rr.connectors!.bolt[0].origin).toEqual([-87.5, 0, 3.5]);
  const { value: car, run: cr } = run(() => std.mgnCarriage("MGN12H"), (s) => s.boundingBox());
  close(car.size[0], 45.4);
  close(car.size[1], 27);
  close(car.min[2], 3);
  close(car.max[2], 13);
  expect(cr.connectors!.bolt.map((f) => f.origin)).toEqual([
    [-10, -10, 13],
    [10, -10, 13],
    [-10, 10, 13],
    [10, 10, 13],
  ]);
  // a rail and its carriage don't overlap
  const both = run(
    () => std.mgnRail("MGN9", 60).intersect(std.mgnCarriage("MGN9C")),
    (s) => s.volume(),
  ).value;
  expect(both).toBeLessThan(1e-6);
});

test("hole specs: ISO 273 clearance, tap drill, counterbore, countersink, insert", () => {
  const plate = () => box(20, 20, 10, { center: "xy" });
  const vol = (spec: Parameters<Solid["hole"]>[1]) => run(() => plate().hole([0, 0, 10], spec as any), (s) => s.volume()).value;
  const full = 4000;
  close(full - vol({ screw: "M3" }), disc(3.4) * 10);
  close(full - vol({ screw: "M3", fit: "close" }), disc(3.2) * 10);
  close(full - vol({ screw: "M3", fit: "loose" }), disc(3.6) * 10);
  close(full - vol({ screw: "M4", fit: "tap", depth: 6 }), disc(3.3) * 6);
  close(full - vol({ screw: "M3", counterbore: "ISO4762" }), disc(6.5) * 3 + disc(3.4) * 7);
  close(full - vol({ screw: "M3", counterbore: "ISO7380", headDepth: 0.5 }), disc(6.5) * 2.15 + disc(3.4) * 7.85);
  close(full - vol({ insert: "M3x5.7" }), disc(4) * 6.7);
  // countersink: 90° cone from 6.72 down to 3.4, then the hole
  const h = (6.72 - 3.4) / 2;
  const cone = (Math.PI * h * (3.36 * 3.36 + 3.36 * 1.7 + 1.7 * 1.7)) / 3;
  close(full - vol({ screw: "M3", countersink: "ISO10642" }), cone + disc(3.4) * (10 - h));
});

test("hole spec connectors seat a screw; tags are unique per part", () => {
  const { run: r } = run(
    () =>
      box(30, 10, 10, { center: "xy" })
        .hole([[-8, 0, 10], [8, 0, 10]], { screw: "M3", counterbore: "ISO4762", connector: "bolt" })
        .hole([0, 0, 10], { screw: "M3", counterbore: "ISO4762" }),
    (s) => s,
  );
  expect(r.connectors!.bolt.map((f) => f.origin)).toEqual([
    [-8, 0, 7],
    [8, 0, 7],
  ]);
  expect(r.connectors!.bolt[0].z.map((v) => v + 0)).toEqual([0, 0, 1]);
  const tags = r.ops.map((o) => o.tag).filter(Boolean);
  expect(tags).toContain("M3-ISO4762-hole-cut");
  expect(tags).toContain("M3-ISO4762-hole-2-cut");
});

test("screws and inserts placed with their hole's at / direction sit coaxially in it", () => {
  const frameOf = (s: Solid, name: string) => s.meta.connectors![name][0];
  const unit = (v: readonly number[]) => v.map((x) => Math.round(x * 1e9) / 1e9 + 0);
  const dirs: [number, number, number][] = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [0, -1, 0], [1, 1, -1]];
  for (const d of dirs) {
    const n = Math.hypot(...d);
    const dir = d.map((v) => v / n);
    const at = [3, -2, 1].map((v, i) => v - 5 * dir[i]) as [number, number, number]; // on the block's surface, facing −dir
    const { value } = run(
      () => box(40, 40, 40, { center: true }),
      (blk) => {
        const holed = blk.hole(at, { insert: "M3x5.7", direction: d, connector: "seat" });
        const ins = std.insert("M3x5.7", { at, direction: d });
        const scr = std.screw("M3", 10, { at, direction: d });
        const cb = blk.hole(at, { screw: "M3", counterbore: "ISO4762", direction: d, connector: "seat" });
        const sunk = std.screw("M3", 10, { at, direction: d, inset: std.tables.heads.ISO4762.M3!.k });
        return {
          seat: frameOf(holed, "seat"), top: frameOf(ins, "top"), bottom: frameOf(ins, "bottom"), head: frameOf(scr, "head"), tip: frameOf(scr, "tip"),
          cbSeat: frameOf(cb, "seat"), sunkHead: frameOf(sunk, "head"),
          overlap: measure.overlap(holed, ins), tight: measure.overlap(blk.hole(at, { screw: "M3", fit: "tap", direction: d }), ins),
          headOverlap: measure.overlap(cb, sunk),
        };
      },
    );
    // the insert's top is the hole's seat, axes opposed to the drill direction, body along it
    expect(unit(value.top.origin)).toEqual(unit(value.seat.origin));
    expect(unit(value.top.z)).toEqual(unit(value.seat.z));
    expect(unit(value.bottom.origin)).toEqual(unit(at.map((v, i) => v + 5.7 * dir[i])));
    expect(unit(value.head.origin)).toEqual(unit(at));
    expect(unit(value.tip.origin)).toEqual(unit(at.map((v, i) => v + 10 * dir[i])));
    expect(unit(value.sunkHead.origin)).toEqual(unit(value.cbSeat.origin));
    expect(unit(value.sunkHead.z)).toEqual(unit(value.cbSeat.z));
    // seated in its own hole: no interference; in a smaller (tap) hole: interference
    expect(value.overlap).toBeLessThan(1e-3);
    expect(value.tight).toBeGreaterThan(1);
    expect(value.headOverlap).toBeLessThan(1e-3);
  }
});

test("nut traps: pocket, captive with side slot", () => {
  const block = () => box(20, 20, 10, { center: "xy" });
  const pocket = run(() => block().nutTrap([0, 0, 10], { size: "M3" }), (s) => s.volume()).value;
  close(4000 - pocket, hexArea(5.7) * 2.6);
  const { value: captive, run: r } = run(() => block().nutTrap([0, 0, 10], { size: "M3", inset: 4, slot: "X", connector: "nut" }), (s) => s.volume());
  // hex pocket plus a slot (one nut wide) from the axis to the +X face
  const slot = 10 * 5.7 * 2.6;
  const overlap = hexArea(5.7) / 2; // the half of the hex the slot covers
  close(4000 - captive, hexArea(5.7) * 2.6 + slot - overlap * 2.6, 1e-3);
  expect(r.connectors!.nut[0].origin.map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, 3.4]);
});
