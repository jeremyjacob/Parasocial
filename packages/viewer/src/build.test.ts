import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { buildOrder, PAUSE, type OrderNode } from "./build";

const box = (min: number[], max: number[]) => new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
const solid = (item: string, min: number[], max: number[]) => {
  const b = box(min, max);
  const s = b.getSize(new THREE.Vector3());
  return { item, box: b, vol: s.x * s.y * s.z };
};
/** A hollow shell: its bounds, with 2 mm walls' worth of volume. */
const shell = (item: string, min: number[], max: number[]) => {
  const p = solid(item, min, max);
  const s = p.box.getSize(new THREE.Vector3());
  return { ...p, vol: p.vol - (s.x - 4) * (s.y - 4) * (s.z - 2) };
};

// an 80 × 50 × 30 enclosure split at z = 15, with a board and a battery inside
const lower = shell("lower housing", [-40, -25, 0], [40, 25, 15]);
const upper = shell("upper housing", [-40, -25, 15], [40, 25, 30]);
const board = solid("board", [-37, -22, 3], [37, 22, 4.6]);
const battery = solid("battery", [-30, -15, 5], [0, 5, 18]);
const sensor = solid("sensor", [10, 5, 8], [14, 9, 11]);
const button = solid("button", [20, -5, 26], [26, 1, 32]);

describe("buildOrder", () => {
  test("internals land before the housing that encloses them", () => {
    const order = buildOrder({ pieces: [lower, upper, board, battery, sensor, button], kids: [] });
    const at = (n: string) => order.findIndex((o) => o.item === n);
    expect(at("board")).toBeLessThan(at("lower housing"));
    expect(at("battery")).toBeLessThan(at("lower housing"));
    expect(at("battery")).toBeLessThan(at("upper housing"));
    // small, but deep inside: in before the housing closes
    expect(at("sensor")).toBeLessThan(at("lower housing"));
    expect(at("sensor")).toBeLessThan(at("upper housing"));
    // small, poking through the top: fitted after
    expect(at("button")).toBeGreaterThan(at("upper housing"));
  });

  test("pauses before the housings close up and before the last piece", () => {
    const order = buildOrder({ pieces: [lower, upper, board, battery], kids: [] });
    expect(order[0].pause).toBe(0);
    expect(order[2].pause).toBe(PAUSE.cover);
    expect(order[3].pause).toBeGreaterThanOrEqual(PAUSE.last);
  });

  test("a sub-assembly builds in one go, inside-out, then a beat before what follows", () => {
    const internals: OrderNode<string> = { pieces: [board, battery], kids: [] };
    const order = buildOrder({ pieces: [upper, lower], kids: [internals] });
    expect(order.map((o) => o.item).slice(0, 2).sort()).toEqual(["battery", "board"]);
    expect(order[2].pause).toBeGreaterThanOrEqual(PAUSE.group);
  });

  test("screws land after the solid part they fasten into", () => {
    const gear = solid("gear", [-20, -20, 0], [20, 20, 10]);
    const screws = solid("screw", [5, 5, 2], [8, 8, 10]);
    expect(buildOrder({ pieces: [screws, gear], kids: [] }).map((o) => o.item)).toEqual(["gear", "screw"]);
  });

  test("a set of screws spread over its host is fastened on after it, even a hollow one", () => {
    const cup = shell("cup", [-30, -30, 0], [30, 30, 20]);
    const stator = solid("stator", [-20, -20, 2], [20, 20, 18]);
    const screws: OrderNode<string> = { pieces: [solid("s1", [-28, -28, 0], [-25, -25, 8]), solid("s2", [25, 25, 0], [28, 28, 8])], kids: [] };
    const order = buildOrder({ pieces: [cup, stator], kids: [screws] }).map((o) => o.item);
    expect(order).toEqual(["stator", "cup", "s1", "s2"]);
  });

  test("nothing enclosed, equal reach: bottom-up", () => {
    const order = buildOrder({ pieces: [solid("top", [0, 0, 10], [10, 10, 20]), solid("bottom", [0, 0, 0], [10, 10, 10])], kids: [] });
    expect(order.map((o) => o.item)).toEqual(["bottom", "top"]);
  });
});
