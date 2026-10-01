// One bad part never takes the engine down: NaN/undefined inputs are script errors at the user's
// line, and anything that still goes wrong (even inside the kernel) is a problem on that part only.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { loadKernel, kernelFault, clearKernelFault, isKernelFault } from "@parasocial/kernel";
import { Engine } from "../src";

beforeAll(async () => {
  await loadKernel();
});
afterEach(() => clearKernelFault());

// The reported case: a library edit renamed fields the fairlead still read (undefined → NaN).
const lib = `export const dims = { width: 40, height: 12 };\n`;
const fairlead = `import { part, box, sketch, plane } from "parasocial";
import { dims } from "../lib/dims";

export default part("Fairlead", () => {
  const body = box(dims.width, 20, dims.height);
  const lip = sketch(plane.XY).rect(dims.width, 4).extrude(dims.lipHeight);
  return body.translate([0, dims.offset, 0]);
});
`;
const cleat = `import { part, box } from "parasocial";
import { dims } from "../lib/dims";

export default part("Cleat", () => box(dims.width, 10, 5));
`;

test("undefined/NaN arguments are script errors with the user's file:line, and other parts still regenerate", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "lib/dims.ts": lib, "studios/fairlead.ts": fairlead, "studios/cleat.ts": cleat } });
  const r = e.regenerate("fairlead");
  expect(r.ok).toBe(false);
  expect(r.problems[0]).toMatchObject({ severity: "error", kind: "runtime", source: { file: "studios/fairlead.ts", line: 6 } });
  expect(r.problems[0].message).toBe("extrude distance is undefined (fairlead.ts:6)");
  // the shown geometry is what built before the failure, not garbage
  expect(r.mesh?.positions.every(Number.isFinite) ?? true).toBe(true);

  e.setScript("studios/fairlead.ts", fairlead.replace(/^.*lipHeight.*\n/m, ""));
  const r2 = e.regenerate("fairlead");
  expect(r2.problems[0].message).toBe("translate: y is undefined (fairlead.ts:6)");
  expect(r2.problems[0].source).toMatchObject({ file: "studios/fairlead.ts", line: 6 });

  const ok = e.regenerate("cleat");
  expect(ok.ok).toBe(true);
  expect(ok.mesh!.indices.length).toBeGreaterThan(0);
  expect(kernelFault()).toBeNull();
});

test("values far outside the modeling range are rejected before they reach the kernel", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/p.ts": `import { part, box } from "parasocial";\nexport default part("P", () => box(10, 10, 10).translate([0, 1e300, 0]));\n` } });
  const r = e.regenerate("p");
  expect(r.ok).toBe(false);
  expect(r.problems[0].message).toStartWith("translate: y is 1e+300, outside the modeling range");
});

test("a kernel fault while meshing is a problem on that part; regenerate never throws", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "lib/dims.ts": lib, "studios/cleat.ts": cleat, "studios/other.ts": `import { part, box } from "parasocial";\nexport default part("Other", () => box(1, 2, 3));\n` } });
  const proto = Object.getPrototypeOf(e);
  const real = proto.describeResult;
  try {
    // what an out-of-bounds trap inside OCCT's mesher looks like
    proto.describeResult = function (this: Engine, result: any, ...rest: unknown[]) {
      if (result.part === "cleat") throw new WebAssembly.RuntimeError("Out of bounds memory access");
      return real.call(this, result, ...rest);
    };
    const r = e.regenerate("cleat");
    expect(r.ok).toBe(false);
    expect(r.mesh).toBeUndefined();
    expect(r.problems.at(-1)!.message).toContain("the geometry kernel crashed while meshing Cleat (Out of bounds memory access) (cleat.ts:4)");
    expect(r.problems.at(-1)!.source).toMatchObject({ file: "studios/cleat.ts", line: 4 });
    // noted: the worker reports itself and is replaced
    expect(kernelFault()).toBe("Out of bounds memory access");
    expect(e.regenerate("other").ok).toBe(true);
  } finally {
    proto.describeResult = real;
  }
});

test("an unexpected engine error becomes a problem instead of an exception", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/p.ts": `import { part, box } from "parasocial";\nexport default part("P", () => box(1, 1, 1));\n` } });
  const proto = Object.getPrototypeOf(e);
  const real = proto.regenerateUnsafe;
  try {
    proto.regenerateUnsafe = () => {
      throw new Error("boom");
    };
    const r = e.regenerate("p");
    expect(r).toMatchObject({ part: "p", ok: false, empty: true });
    expect(r.problems[0].message).toBe("regenerating p failed: boom");
    expect(kernelFault()).toBeNull();
  } finally {
    proto.regenerateUnsafe = real;
  }
});

test("kernel faults are told apart from ordinary OCCT and script errors", () => {
  expect(isKernelFault(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
  expect(isKernelFault(new Error("Aborted(OOM)"))).toBe(true);
  expect(isKernelFault(new Error("Out of bounds memory access (evaluating 'f(x)')"))).toBe(true);
  expect(isKernelFault(new Error("fillet failed"))).toBe(false);
  expect(isKernelFault(new RangeError("Maximum call stack size exceeded"))).toBe(false);
  expect(isKernelFault(42)).toBe(false);
});

test("thicken of a planar face builds, and a failed thicken is a script error at its line", () => {
  // the reported case: thicken(box.faces(">Z")) surfaced as "[object WebAssembly.Exception]"
  const e = new Engine();
  const src = (t: number) => `import { part, box, cylinder, thicken } from "parasocial";

export default part("Skin", () => {
  const plate = box(40, 30, 5);
  const skin = thicken(plate.faces(">Z"), 2);
  return skin.union(thicken(cylinder(5, 10, { at: [60, 0, 0] }).faces("%cylinder"), ${t}));
});
`;
  e.setDocument({ scripts: { "studios/skin.ts": src(-1) } });
  const r = e.regenerate("skin");
  expect(r.problems).toEqual([]);
  expect(r.ok).toBe(true);

  e.setScript("studios/skin.ts", src(-6));
  const bad = e.regenerate("skin");
  expect(bad.ok).toBe(false);
  expect(bad.problems[0]).toMatchObject({ severity: "error", source: { file: "studios/skin.ts", line: 6 } });
  expect(bad.problems[0].message).toStartWith("thicken failed: thickness 6 is more than the 5 mm radius");
  expect(bad.problems[0].message).toEndWith("(skin.ts:6)");
  expect(kernelFault()).toBeNull();
});
