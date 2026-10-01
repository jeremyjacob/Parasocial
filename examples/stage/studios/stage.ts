import { assembly } from "parasocial";
import base, { rail, carriage, table, screw, bearing } from "./parts";

export const name = "Stage";

// The carriage slides along the rail; the table, its screws and the bearing ride with it.
// Screws and the bearing go in connector to connector: each "bolt" frame of the table's
// counterbores takes a screw's "head", the table's "seat" takes the bearing's "back".
export default assembly("Linear stage", ({ fix, fastened, slider, insert }) => {
  fix(base);
  fastened(base, rail);
  slider(rail, carriage, rail.at("carriage"), { min: -75, max: 75, name: "travel" });
  fastened(carriage, table);
  for (let i = 0; i < 4; i++) fastened(table.at("bolt", i), insert(screw, { name: `bolt ${i + 1}` }).at("head"));
  fastened(table.at("seat"), bearing.at("back"));
});
