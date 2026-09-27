import { cylinder, type Solid } from "parasocial";

/** `count` through-holes of `diameter` on a circle of `radius`, as one tool body. */
export function boltCircle(count: number, radius: number, diameter: number, height: number): Solid {
  const hole = cylinder(diameter / 2, height + 2, { at: [radius, 0, -1], tag: "bolt" });
  return hole.circularPattern(count, { tag: "bolts" });
}
