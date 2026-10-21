import { buildSteps } from "parasocial";
import stage from "../studios/stage";
import base, { rail, carriage, table, screw, bearing } from "../studios/parts";

// The linear stage, bottom up: rail on the base, carriage onto the rail, then the table and its parts.
export default buildSteps(stage, ({ step }) => {
  step("Set down the base", base);
  step("Bolt on the rail", rail, { from: [0, 0, 30] });
  step("Slide the carriage onto the rail", carriage, { along: "X", distance: 170, description: "From the end: keep it level so the balls stay in." });
  step("Fit the table", table, { from: [0, 0, 40] });
  step("Screw down the table", screw, { from: [0, 0, 20], turn: 1080, stagger: 0.25, description: "Four M3 × 8 into the carriage, in a cross pattern." });
  step("Press in the bearing", bearing, { from: [0, 0, 30] });
});
