import { expect, test } from "bun:test";
import { Mechanism, layout, flipFrame, applyPoint, rotation, type Frame, type Vec3, type LayoutJoint } from "../src";

const at = (origin: Vec3, z: Vec3 = [0, 0, 1], x: Vec3 = [1, 0, 0]): Frame => ({ origin, z, x });
const close = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

// a chassis with four axles pointing out ±Y at its corners; a wheel modeled at the origin with its hub along +Z
const axles: Record<string, Frame> = {
  fl: at([50, 30, 0], [0, 1, 0]),
  fr: at([50, -30, 0], [0, -1, 0]),
  rl: at([-50, 30, 0], [0, 1, 0]),
  rr: at([-50, -30, 0], [0, -1, 0]),
};
const hub = at([0, 0, 0]);

test("mates place copies: each wheel's hub lands on its axle", () => {
  const bodies = [{ id: "cart/chassis", scope: "cart" }, ...Object.keys(axles).map((k) => ({ id: `cart/wheel@${k}`, scope: "cart" }))];
  const joints: LayoutJoint[] = Object.entries(axles).map(([k, f]) => ({ a: "cart/chassis", b: `cart/wheel@${k}`, scope: "cart", mate: { a: f, b: hub } }));
  const { home, frames } = layout({ root: "cart", bodies, joints });
  close(applyPoint(home.get("cart/chassis")!, [1, 2, 3]), [1, 2, 3]);
  for (const [k, f] of Object.entries(axles)) {
    const H = home.get(`cart/wheel@${k}`)!;
    close(applyPoint(H, [0, 0, 0]), f.origin); // hub center on the axle
    close(applyPoint(H, [0, 0, 1]).map((v, i) => v - f.origin[i]) as Vec3, f.z); // hub axis along the axle
  }
  // the solver starts there, and each wheel spins about its own axle
  const m = new Mechanism({
    joints: Object.keys(axles).map((k, i) => ({ name: k, type: "revolute" as const, a: "cart/chassis", b: `cart/wheel@${k}`, frames: frames[i]! })),
    home: Object.fromEntries(home),
    fixed: ["cart/chassis"],
  });
  expect(m.error()).toBeLessThan(1e-9);
  close(m.pointAt("cart/wheel@fr", [0, 0, 0]), axles.fr.origin);
  m.setValues({ fr: [90] });
  close(m.pointAt("cart/wheel@fr", [0, 0, 0]), axles.fr.origin); // on the axis: stays
  close(m.pointAt("cart/wheel@fl", [10, 0, 0]), applyPoint(home.get("cart/wheel@fl")!, [10, 0, 0])); // others don't move
});

test("placed copies sit where placed; legacy frames in scope coordinates become a frame on each", () => {
  const place = { r: rotation([0, 0, 1], Math.PI / 2), t: [100, 0, 0] as Vec3 };
  const { home, frames } = layout({
    root: "a",
    bodies: [
      { id: "a/base", scope: "a" },
      { id: "a/arm@2", scope: "a", place },
    ],
    joints: [{ a: "a/base", b: "a/arm@2", scope: "a", frame: at([100, 0, 0]) }],
  });
  close(applyPoint(home.get("a/arm@2")!, [10, 0, 0]), [100, 10, 0]);
  const f = frames[0]!;
  close(f.a.origin, [100, 0, 0]);
  close(f.b.origin, [0, 0, 0]); // the same point, in the copy's own coordinates
});

test("a subassembly is laid out in its own coordinates, then placed as a whole by a mate onto one of its bodies", () => {
  // wheel assembly: hub, and a tire fastened around it 5 mm out along the hub axis
  const { home, frames } = layout({
    root: "cart",
    bodies: [
      { id: "cart/chassis", scope: "cart" },
      { id: "cart/wa@fl/hub", scope: "cart/wa@fl" },
      { id: "cart/wa@fl/tire", scope: "cart/wa@fl" },
    ],
    scopes: [{ id: "cart/wa@fl", parent: "cart" }],
    joints: [
      { a: "cart/wa@fl/hub", b: "cart/wa@fl/tire", scope: "cart/wa@fl", mate: { a: at([0, 0, 5]), b: at([0, 0, 0]) } },
      { a: "cart/chassis", b: "cart/wa@fl/hub", scope: "cart", mate: { a: axles.fl, b: hub } },
    ],
  });
  close(applyPoint(home.get("cart/wa@fl/hub")!, [0, 0, 0]), [50, 30, 0]);
  close(applyPoint(home.get("cart/wa@fl/tire")!, [0, 0, 0]), [50, 35, 0]); // 5 out along the axle (+Y)
  expect(frames.every(Boolean)).toBe(true);
});

test("mechanisms without frames on each side still work from home frames", () => {
  const m = new Mechanism({ joints: [{ name: "h", type: "revolute", a: "a", b: "b", frame: at([0, 0, 0]) }], home: { c: { r: rotation([0, 0, 1], 0), t: [5, 0, 0] } } });
  // a body listed only in home stays there
  expect(m.bodies).toContain("c");
  close(m.pointAt("c", [0, 0, 0]), [5, 0, 0]);
  expect(m.movable("c")).toBe(false);
});

test("a flipped mate faces the other way", () => {
  const { home } = layout({ root: "r", bodies: [{ id: "r/a", scope: "r" }, { id: "r/b", scope: "r" }], joints: [{ a: "r/a", b: "r/b", scope: "r", mate: { a: at([0, 0, 10]), b: flipFrame(at([0, 0, 0])) } }] });
  close(applyPoint(home.get("r/b")!, [0, 0, 5]), [0, 0, 5]); // b's +z now points back down into a
});
