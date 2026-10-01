import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { Glob } from "bun";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Engine } from "../src";
import { resolveAssembly } from "../src/mechanism";

beforeAll(async () => {
  await loadKernel();
}, 60_000);

test("the linear stage example: std parts mate by connector and nothing overlaps along the travel", async () => {
  const { Mechanism } = await import("@parasocial/assembly");
  const root = join(import.meta.dir, "../../../examples/stage");
  const scripts: Record<string, string> = {};
  for (const f of new Glob("studios/*.ts").scanSync(root)) scripts[f] = readFileSync(join(root, f), "utf8");
  const e = new Engine();
  e.setDocument({ scripts });
  const results = Object.fromEntries(e.parts().map((p) => [p, e.regenerate(p)]));
  for (const p of e.parts()) expect([p, results[p].ok, results[p].problems]).toEqual([p, true, []]);
  const [a] = e.assemblies();
  expect(a.problems).toEqual([]);
  const ids = a.instances.map((i) => i.id);
  const { spec, problems } = resolveAssembly(a, (p) => results[p].connectors ?? {});
  expect(problems).toEqual([]);
  const mech = new Mechanism({ ...spec, scale: 200 });
  expect(mech.error()).toBeLessThan(1e-9);
  expect(mech.dof()).toBe(1);

  const pose = () => {
    const poses: Record<string, { r: number[]; t: [number, number, number] }> = {};
    for (const [p, T] of mech.poses()) poses[p] = { r: [...T.r], t: [T.t[0], T.t[1], T.t[2]] };
    return poses;
  };
  // screws seat on the counterbore floors (table top 27 − ISO 4762 M3 head 3), the bearing in its seat
  const home = pose();
  const screws = Object.keys(home).filter((k) => k.includes("parts:screw"));
  expect(screws.length).toBe(4);
  for (const s of screws) {
    expect(Math.abs(home[s].t[0])).toBeCloseTo(10, 6);
    expect(Math.abs(home[s].t[1])).toBeCloseTo(10, 6);
    expect(home[s].t[2]).toBeCloseTo(24, 6);
  }
  const brg = Object.keys(home).find((k) => k.endsWith("parts:bearing"))!;
  expect(home[brg].t.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([30, 0, 20]);
  e.setPoses(home);
  expect(e.interferences(ids)).toEqual([]);
  // at the end of travel the carriage and everything on it has moved 75 along the rail
  expect(mech.setValues({ travel: [75] })).toBeLessThan(1e-6);
  const end = pose();
  expect(end[screws[0]].t[0] - home[screws[0]].t[0]).toBeCloseTo(75, 6);
  e.setPoses(end);
  expect(e.interferences(ids)).toEqual([]);
}, 60_000);
