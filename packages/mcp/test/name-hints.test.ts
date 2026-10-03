// Write results flag names that pack in details (part numbers, materials, status) so the agent moves them to description.
import { expect, test } from "bun:test";
import { nameHints } from "../src/write-report";

test("names that pack in details or run long are flagged, only in the written files", () => {
  const parts = [
    { file: "studios/rotor.ts", name: "Rotor carrier", studio: "Printed rotor carrier — PL-B-20-38" },
    { file: "studios/rotor.ts", name: "Hub (PPA-CF)", studio: "Printed rotor carrier — PL-B-20-38" },
    { file: "studios/drum.ts", name: "Winch drum and shaft", studio: "Winch drum and shaft" },
    { file: "studios/other.ts", name: "Level-wind: detailed development", studio: "other" },
  ];
  const assemblies = [{ file: "studios/winch.ts", name: "Winch assembly for the RI115 compact level-wind", studio: "Winch" }];
  expect(nameHints(parts, assemblies, new Set(["studios/rotor.ts", "studios/drum.ts", "studios/winch.ts"]))).toEqual([
    'studios/rotor.ts: studio name "Printed rotor carrier — PL-B-20-38" packs in details; keep names to 1–4 words and move the rest to export const description',
    'studios/rotor.ts: part name "Hub (PPA-CF)" packs in details; keep names to 1–4 words and move the rest to part(name, body, { description, partNumber, material })',
    'studios/winch.ts: assembly name "Winch assembly for the RI115 compact level-wind" packs in details; keep names to 1–4 words and move the rest to assembly(name, body, { description, partNumber })',
  ]);
  // hyphenated words aren't separators
  expect(nameHints([{ file: "studios/a.ts", name: "Level-wind carriage", studio: "Level-wind" }], [], new Set(["studios/a.ts"]))).toEqual([]);
});
