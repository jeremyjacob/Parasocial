import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { OpCache } from "@parasocial/naming";
import { PartContext, runPart, part, type PartBody } from "@parasocial/api/internal";
import { box } from "../src/solid";

beforeAll(async () => { await loadKernel(); });

const run = (body: PartBody) => {
  const cache = new OpCache();
  cache.begin();
  return runPart(part("P", body), new PartContext({ part: "p", file: "studios/p.ts", cache, isUserFile: () => true }));
};

test("color and appearance reach the part run and survive later operations", () => {
  const r = run(({ color }) => box(10, 10, 10).color(color.rgb("#4A7BD0")).appearance({ opacity: 0.4, roughness: 0.1 }).translate([0, 0, 5]));
  expect(r.ok).toBe(true);
  expect(r.color).toEqual({ kind: "rgb", hex: "#4a7bd0" });
  expect(r.appearance).toEqual({ opacity: 0.4, roughness: 0.1 });
});

test("a hex with alpha sets the opacity; short forms expand", () => {
  expect(run(() => box(1, 1, 1).color("#4a7bd080"))).toMatchObject({ color: { kind: "rgb", hex: "#4a7bd0" }, appearance: { opacity: 0.502 } });
  expect(run(() => box(1, 1, 1).color("#48f8"))).toMatchObject({ color: { kind: "rgb", hex: "#4488ff" }, appearance: { opacity: 0.533 } });
  expect(run(() => box(1, 1, 1).color("#48f")).appearance).toBeUndefined();
});

test("appearance merges field by field; opacity() is shorthand", () => {
  const r = run(({ color }) => box(1, 1, 1).appearance({ metalness: 1, color: color.auto() }).opacity(0.25).appearance({ roughness: 0.3 }));
  expect(r.color).toEqual({ kind: "auto" });
  expect(r.appearance).toEqual({ metalness: 1, opacity: 0.25, roughness: 0.3 });
});

test("bad appearance values are script errors that say what to use", () => {
  const msg = (body: PartBody) => run(body).problems[0]?.message ?? "";
  expect(msg(() => box(1, 1, 1).opacity(1.5))).toContain("opacity must be a number from 0 to 1");
  expect(msg(() => box(1, 1, 1).appearance({ glow: 1 } as any))).toContain('has no "glow"');
  expect(msg(() => box(1, 1, 1).color("blue"))).toContain("must be a hex color");
});
