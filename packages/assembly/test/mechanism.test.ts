import { describe, expect, test } from "bun:test";
import { Mechanism, distance, type Frame, type Vec3 } from "../src";

const Z = (origin: Vec3): Frame => ({ origin, z: [0, 0, 1], x: [1, 0, 0] });

describe("revolute", () => {
  // a lid hinged along X at the back top edge of a box
  const hinge: Frame = { origin: [0, 25, 30], z: [1, 0, 0], x: [0, 1, 0] };
  const make = (limits?: { min?: number; max?: number }) => new Mechanism({ joints: [{ name: "hinge", type: "revolute", a: "body", b: "lid", frame: hinge, limits: [limits] }] });

  test("home pose is the identity", () => {
    const m = make();
    expect(m.pointAt("lid", [0, -25, 30])).toEqual([0, -25, 30]);
    expect(m.fixed.has("body")).toBe(true);
    expect(m.movable("lid")).toBe(true);
    expect(m.movable("body")).toBe(false);
  });

  test("dragging the front edge up opens the lid", () => {
    const m = make();
    const grab: Vec3 = [0, -25, 30];
    // pull straight up by 20: the point swings on a circle of radius 50 about the hinge
    for (let z = 32; z <= 50; z += 2) m.drag("lid", grab, [0, -25, z]);
    const p = m.pointAt("lid", grab);
    expect(distance(p, [0, 25, 30])).toBeCloseTo(50, 6); // stays on the circle
    expect(p[2]).toBeGreaterThan(45);
    expect(m.values().hinge[0]).toBeLessThan(0); // right-handed about +X: opening toward -Y is negative
  });

  test("limits clamp", () => {
    const m = make({ min: -30, max: 0 });
    for (let z = 32; z <= 90; z += 2) m.drag("lid", [0, -25, 30], [0, -25, z]);
    expect(m.values().hinge[0]).toBeCloseTo(-30, 6);
  });
});

test("slider travels along its axis only", () => {
  const m = new Mechanism({ joints: [{ name: "rail", type: "slider", a: "base", b: "carriage", frame: Z([0, 0, 0]), limits: [{ min: 0, max: 80 }] }] });
  m.drag("carriage", [5, 5, 5], [30, 40, 25]);
  expect(m.values().rail[0]).toBeCloseTo(20, 2);
  const p = m.pointAt("carriage", [5, 5, 5]);
  expect(p[0]).toBeCloseTo(5, 6);
  expect(p[1]).toBeCloseTo(5, 6);
  for (let i = 0; i < 20; i++) m.drag("carriage", [5, 5, 5], [5, 5, 300]);
  expect(m.values().rail[0]).toBeCloseTo(80, 4);
});

test("fastened parts don't move", () => {
  const m = new Mechanism({ joints: [{ name: "bolt", type: "fastened", a: "plate", b: "bolt", frame: Z([0, 0, 0]) }] });
  expect(m.movable("bolt")).toBe(false);
  expect(m.drag("bolt", [0, 0, 0], [10, 0, 0])).toBe(false);
});

test("a chain moves both links", () => {
  const m = new Mechanism({
    joints: [
      { name: "shoulder", type: "revolute", a: "base", b: "upper", frame: Z([0, 0, 0]) },
      { name: "elbow", type: "revolute", a: "upper", b: "lower", frame: Z([40, 0, 0]) },
    ],
  });
  const tip: Vec3 = [80, 0, 0];
  for (let k = 0; k <= 20; k++) m.drag("lower", tip, [80 - 3 * k, 2.5 * k, 0]);
  expect(distance(m.pointAt("lower", tip), [20, 50, 0])).toBeLessThan(0.01);
  const v = m.values();
  expect(Math.abs(v.shoulder[0])).toBeGreaterThan(1);
  expect(Math.abs(v.elbow[0])).toBeGreaterThan(1);
});

describe("four-bar linkage (closed loop)", () => {
  // ground A(0,0)–D(40,0), crank A–B(0,20), coupler B–C(40,30), rocker C–D
  const make = () =>
    new Mechanism({
      joints: [
        { name: "A", type: "revolute", a: "ground", b: "crank", frame: Z([0, 0, 0]) },
        { name: "B", type: "revolute", a: "crank", b: "coupler", frame: Z([0, 20, 0]) },
        { name: "C", type: "revolute", a: "coupler", b: "rocker", frame: Z([40, 30, 0]) },
        { name: "D", type: "revolute", a: "rocker", b: "ground", frame: Z([40, 0, 0]) },
      ],
    });

  test("one degree of freedom", () => {
    const m = make();
    expect(m.error()).toBeLessThan(1e-9);
    expect(m.dof()).toBe(1);
    expect(m.movable("coupler")).toBe(true);
  });

  test("dragging the crank keeps the loop closed", () => {
    const m = make();
    const B: Vec3 = [0, 20, 0];
    for (let k = 1; k <= 30; k++) {
      const a = (k * 3 * Math.PI) / 180;
      m.drag("crank", B, [-20 * Math.sin(a), 20 * Math.cos(a), 0]);
      expect(m.error()).toBeLessThan(1e-6);
    }
    // link lengths hold: B–C (coupler) and C–D (rocker)
    const b = m.pointAt("coupler", B),
      c = m.pointAt("coupler", [40, 30, 0]),
      c2 = m.pointAt("rocker", [40, 30, 0]);
    expect(distance(b, c)).toBeCloseTo(Math.hypot(40, 10), 6);
    expect(distance(c, c2)).toBeLessThan(1e-5);
    expect(distance(c2, [40, 0, 0])).toBeCloseTo(30, 5);
    expect(Math.abs(m.values().A[0])).toBeGreaterThan(60);
  });

  test("values round-trip", () => {
    const m = make();
    for (let k = 1; k <= 10; k++) m.drag("crank", [0, 20, 0], [-20 * Math.sin(k * 0.05), 20 * Math.cos(k * 0.05), 0]);
    const saved = m.values();
    const n = make();
    expect(n.setValues(saved)).toBeLessThan(1e-6);
    expect(distance(n.pointAt("coupler", [40, 30, 0]), m.pointAt("coupler", [40, 30, 0]))).toBeLessThan(1e-4);
  });
});

test("ball joint has three freedoms", () => {
  const m = new Mechanism({ joints: [{ name: "ball", type: "ball", a: "socket", b: "stick", frame: Z([0, 0, 0]) }] });
  expect(m.dof()).toBe(3);
  for (let t = 0; t <= 1; t += 0.1) m.drag("stick", [0, 0, 50], [30 * t, 20 * t, 50]);
  expect(distance(m.pointAt("stick", [0, 0, 50]), [0, 0, 0])).toBeCloseTo(50, 6);
  expect(m.pointAt("stick", [0, 0, 50])[0]).toBeGreaterThan(15);
});
