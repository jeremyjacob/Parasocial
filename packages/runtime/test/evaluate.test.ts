import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { Engine, SHARED } from "../src";
import { summarize, num } from "../src/evaluate";

beforeAll(async () => {
  await loadKernel();
});

const WINCH = `import { param, box, mm } from "parasocial";
const plate = 4;
export const drumLength = 60;
export function winch() {
  const travel = param("travel", 120, { unit: mm });
  const drumFront = plate + drumLength / 3;
  return { drumFront, endPlateInner: drumFront + drumLength, travel, ratio: 1 / 3, body: box(10, 20, 30), pick: (x: number) => x };
}
`;
const STUDIO = `import { part } from "parasocial";
import { winch } from "../lib/winch";
export default part("Pedestal", () => winch().body);
`;

const engine = (overrides: Record<string, Record<string, string | number>> = {}) => {
  const e = new Engine();
  e.setDocument({ scripts: { "lib/winch.ts": WINCH, "studios/pedestal.ts": STUDIO }, overrides });
  return e;
};

test("evaluates in a script's module scope: exports, private consts, imports, params, geometry", () => {
  const r = engine().evaluate("lib/winch.ts", "winch()");
  expect(r.value).toEqual({ drumFront: 24, endPlateInner: 84, travel: 120, ratio: 0.333333, body: { type: "Solid", bbox: { min: [0, 0, 0], max: [10, 20, 30], size: [10, 20, 30] } }, pick: "[function pick]" });
  expect(r.params).toEqual({ travel: 120 });
  expect(engine().evaluate("lib/winch.ts", "plate * 2 as number;").value).toBe(8);
  expect(engine().evaluate("lib/winch.ts", "box(1, 2, 3).volume()").value).toBe(6);
  expect(engine().evaluate("studios/pedestal.ts", "winch().travel - 20").value).toBe(100);
});

test("params read the part's overrides when given, else defaults and shared overrides", () => {
  const e = engine({ pedestal: { travel: 200 } });
  expect(e.evaluate("lib/winch.ts", "winch().travel").value).toBe(120);
  expect(e.evaluate("lib/winch.ts", "winch().travel", "pedestal").value).toBe(200);
  expect(() => e.evaluate("lib/winch.ts", "1", "nope")).toThrow(/no part "nope"\. Parts: pedestal/);
  const shared = `import { param } from "parasocial";\nexport const t = () => param("t", 1, { shared: true });\n`;
  const s = new Engine();
  s.setDocument({ scripts: { "lib/s.ts": shared }, overrides: { [SHARED]: { t: 7 } } });
  expect(s.evaluate("lib/s.ts", "t()").value).toBe(7);
});

test("errors carry the expression's or the script's line", () => {
  const e = engine();
  expect(() => e.evaluate("lib/winch.ts", "winch(")).toThrow(/syntax error: .*\(expr:\d+\)/);
  expect(() => e.evaluate("lib/winch.ts", "nope()")).toThrow(/nope is not defined \(expr:1\)/);
  expect(() => e.evaluate("lib/winch.ts", "1 +\n  winch().x.y")).toThrow(/\(expr:2\)/);
  e.setScript("lib/bad.ts", "export function f() {\n  return (null as any).x;\n}\n");
  expect(() => e.evaluate("lib/bad.ts", "f()")).toThrow(/\(bad\.ts:2\)/);
  expect(() => e.evaluate("lib/none.ts", "1")).toThrow(/no script at lib\/none\.ts/);
  // the engine keeps working afterwards
  expect(e.regenerate("pedestal").ok).toBe(true);
});

test("summarize: rounding, caps, cycles", () => {
  expect([num(1234.56789), num(0.0000123456789), num(-0), num(Infinity), num(2)]).toEqual([1234.5679, 0.0000123457, 0, "Infinity", 2]);
  const a: any = { x: 1 };
  a.self = a;
  expect(summarize(a)).toEqual({ x: 1, self: "[circular]" });
  const shared = { v: 1 };
  expect(summarize([shared, shared])).toEqual([{ v: 1 }, { v: 1 }]);
  expect((summarize(Array.from({ length: 150 }, (_, i) => i)) as unknown[]).at(-1)).toBe("+50 more");
  expect(summarize({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })).toEqual({ a: { b: { c: { d: { e: { f: "[Object]" } } } } } });
  expect(summarize(new Map([["k", 1.123456789]]))).toEqual({ type: "Map", size: 1, entries: [["k", 1.12346]] });
  expect(summarize(undefined)).toBe("[undefined]");
  expect(summarize(class Foo {})).toBe("[class Foo]");
});
