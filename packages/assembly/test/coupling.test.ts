import { describe, expect, test } from "bun:test";
import { Mechanism, type Frame, type JointSpec, type Vec3 } from "../src";

const Z = (origin: Vec3): Frame => ({ origin, z: [0, 0, 1], x: [1, 0, 0] });
const X = (origin: Vec3): Frame => ({ origin, z: [1, 0, 0], x: [0, 1, 0] });
const onCircle = (c: Vec3, r: number, deg: number): Vec3 => [c[0] + r * Math.cos((deg * Math.PI) / 180), c[1] + r * Math.sin((deg * Math.PI) / 180), c[2]];

// two gears on a plate, 40 mm apart: the small one (r 10) drives the big one (r 30) the other way round
const gears = (limits?: { min?: number; max?: number }) =>
  new Mechanism({
    joints: [
      { name: "small", type: "revolute", a: "plate", b: "pinion", frame: Z([0, 0, 0]) },
      { name: "big", type: "revolute", a: "plate", b: "wheel", frame: Z([40, 0, 0]), limits: [limits] },
    ],
    couplings: [{ a: "small", b: "big", ratio: -1 / 3 }],
  });

describe("gear", () => {
  test("one degree of freedom; the driven gear isn't a driver", () => {
    const m = gears();
    expect(m.dof()).toBe(1);
    expect(m.drivers()).toEqual(["small"]);
    expect(m.movable("pinion")).toBe(true);
    expect(m.movable("wheel")).toBe(true);
  });

  test("dragging the small gear turns the big one", () => {
    const m = gears();
    // pull a tooth tip of the pinion a quarter turn round
    for (let a = 5; a <= 90; a += 5) m.drag("pinion", [10, 0, 0], onCircle([0, 0, 0], 10, a));
    const v = m.values();
    expect(v.small[0]).toBeCloseTo(90, 1);
    expect(v.big[0]).toBeCloseTo(-30, 1);
    expect(m.error()).toBeLessThan(1e-6);
  });

  test("dragging the big gear turns the small one", () => {
    const m = gears();
    for (let a = 2; a <= 20; a += 2) m.drag("wheel", [70, 0, 0], onCircle([40, 0, 0], 30, a));
    const v = m.values();
    expect(v.big[0]).toBeCloseTo(20, 1);
    expect(v.small[0]).toBeCloseTo(-60, 1);
  });

  test("setting one joint moves the other; a limit on the follower stops the driver", () => {
    const m = gears({ min: -20, max: 20 });
    expect(m.setValues({ small: [30] })).toBeLessThan(1e-6);
    expect(m.values().small[0]).toBeCloseTo(30, 6);
    expect(m.values().big[0]).toBeCloseTo(-10, 6);
    // the wheel stops at -20, so the pinion stops at 60
    m.setValues({ small: [90] });
    expect(m.values().big[0]).toBeCloseTo(-20, 4);
    expect(m.values().small[0]).toBeCloseTo(60, 3);
    for (let a = 60; a <= 180; a += 5) m.drag("pinion", [10, 0, 0], onCircle([0, 0, 0], 10, a));
    expect(m.values().big[0]).toBeGreaterThanOrEqual(-20);
    expect(m.values().small[0]).toBeLessThan(60.5);
    expect(m.error()).toBeLessThan(1e-4);
  });
});

describe("lead screw", () => {
  // a winch: a drum on a frame turns a lead screw (2:1, the other way), which drives a carriage (4 mm per turn)
  const joints: JointSpec[] = [
    { name: "drum", type: "revolute", a: "frame", b: "drum", frame: X([0, 0, 50]) },
    { name: "screw", type: "revolute", a: "frame", b: "screw", frame: X([0, 0, 0]) },
    { name: "carriage", type: "slider", a: "frame", b: "carriage", frame: X([0, 0, 0]), limits: [{ min: 0, max: 100 }] },
  ];
  const make = () =>
    new Mechanism({
      joints,
      couplings: [
        { a: "drum", b: "screw", ratio: -2 },
        { a: "screw", b: "carriage", ratio: 4 / 360 },
      ],
    });

  test("one degree of freedom through the chain", () => {
    const m = make();
    expect(m.dof()).toBe(1);
    expect(m.drivers()).toEqual(["drum"]);
    expect(m.movable("carriage")).toBe(true);
  });

  test("dragging the carriage turns the screw and the drum", () => {
    const m = make();
    for (let x = 1; x <= 20; x++) m.drag("carriage", [0, 10, 0], [x, 10, 0]);
    const v = m.values();
    expect(v.carriage[0]).toBeCloseTo(20, 2);
    expect(v.screw[0]).toBeCloseTo(1800, 0);
    expect(v.drum[0]).toBeCloseTo(-900, 0);
    expect(m.error()).toBeLessThan(1e-4);
  });

  test("the carriage's limit stops the drum", () => {
    const m = make();
    m.setValues({ drum: [-90] }); // half a turn of the screw: 2 mm
    expect(m.values().carriage[0]).toBeCloseTo(2, 6);
    m.setValues({ drum: [90] }); // would go below 0
    expect(m.values().carriage[0]).toBeCloseTo(0, 4);
    expect(m.values().drum[0]).toBeCloseTo(0, 2);
  });

  test("a screw on one cylindrical joint: turning advances it", () => {
    const m = new Mechanism({
      joints: [{ name: "nut", type: "cylindrical", a: "rod", b: "nut", frame: Z([0, 0, 0]) }],
      couplings: [{ a: "nut", ia: 0, b: "nut", ib: 1, ratio: 1.5 / 360 }],
    });
    expect(m.dof()).toBe(1);
    m.setValues({ nut: [720, 0] });
    expect(m.values().nut[0]).toBeCloseTo(720, 6);
    expect(m.values().nut[1]).toBeCloseTo(3, 6);
  });
});

test("couplings must name joint variables that exist", () => {
  const j: JointSpec = { name: "r", type: "revolute", a: "a", b: "b", frame: Z([0, 0, 0]) };
  expect(() => new Mechanism({ joints: [j], couplings: [{ a: "r", b: "nope", ratio: 1 }] })).toThrow(/no joint "nope"/);
  expect(() => new Mechanism({ joints: [j], couplings: [{ a: "r", b: "r", ratio: 1 }] })).toThrow(/itself/);
  expect(() => new Mechanism({ joints: [j], couplings: [{ a: "r", b: "r", ib: 1, ratio: 1 }] })).toThrow(/no variable 1/);
});
