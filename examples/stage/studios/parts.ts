import { part, param, box, std, mm, type Vec3 } from "parasocial";

export const name = "Stage parts";

// A small linear stage built from standard content: an MGN12 rail and MGN12H carriage, a table
// bolted on with ISO 4762 screws in counterbores, a 608 bearing seat, heat-set inserts and a
// captive nut. studios/stage.ts assembles it.
const RAIL = 200;
const PLATE = 6; // base thickness: the rail sits on top
const CAR = std.tables.mgnCarriages.MGN12H;
const TABLE_Z = PLATE + CAR.H; // the table sits on the carriage
const BRG = std.tables.bearings["608"];

/** Four points at (±x, ±y) on the plane z. */
const corners = (x: number, y: number, z: number): Vec3[] => [-1, 1].flatMap((sx) => [-1, 1].map((sy): Vec3 => [sx * x, sy * y, z]));

export default part("Base", ({ color }) => {
  const width = param("width", 40, { min: 30, max: 80, unit: mm, label: "Width" });
  const plate = box(RAIL + 40, width, PLATE, { center: "xy", tag: "plate" });
  // tapped M3 holes under the rail's bolt holes, countersunk M4 holes to mount the base
  const railBolts = std.mgnRailHoles("MGN12", RAIL).map((x): Vec3 => [x, 0, PLATE]);
  return plate
    .hole(railBolts, { screw: "M3", fit: "tap", depth: 5, tag: "rail-taps" })
    .hole(corners(RAIL / 2 + 10, width / 2 - 7, PLATE), { screw: "M4", countersink: "ISO10642", tag: "mount" })
    .color(color.auto())
    .material("aluminum");
});

export const rail = part("Rail", () => std.mgnRail("MGN12", RAIL).translate([0, 0, PLATE]));

export const carriage = part("Carriage", () => std.mgnCarriage("MGN12H").translate([0, 0, PLATE]));

export const table = part("Table", ({ color }) => {
  const t = param("thickness", 8, { min: 8, max: 14, unit: mm, label: "Thickness" });
  const top = TABLE_Z + t;
  const plate = box(90, 40, t, { center: "xy", tag: "table" }).translate([0, 0, TABLE_Z]);
  // a 608 seat from the top, with a shoulder below it
  const seat: Vec3 = [30, 0, top];
  return (
    plate
      // counterbored screws into the carriage's C × B pattern; the "bolt" frames seat the screws
      .hole(corners(CAR.C / 2, CAR.B / 2, top), { screw: "M3", counterbore: "ISO4762", connector: "bolt", tag: "carriage-bolts" })
      .hole(seat, BRG.D, { depth: BRG.B, tag: "bearing-seat" })
      .hole(seat, 12, { tag: "shoulder" })
      .hole(corners(40, 14, top), { insert: "M3x5.7", tag: "inserts" })
      // a captive M3 nut slid in from the -X end, under an M3 clamp screw
      .nutTrap([-32, 0, top], { size: "M3", inset: 3, slot: [-1, 0, 0], tag: "clamp-nut" })
      .hole([-32, 0, top], { screw: "M3", tag: "clamp" })
      .color(color.auto())
      .material("petg")
      .connector("seat", { origin: [seat[0], seat[1], top - BRG.B] })
  );
});

export const screw = part("Screw", () => std.screw("M3", 8));

export const bearing = part("Bearing", () => std.bearing("608"));
