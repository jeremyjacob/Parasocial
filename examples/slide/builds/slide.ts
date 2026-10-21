import { buildSteps } from "parasocial";
import mechanism from "../studios/mechanism";
import frame, { crank, leadScrew, carriage } from "../studios/slide";

// The carriage sits between the end plates before the lead screw threads through it.
export default buildSteps(mechanism, ({ step }) => {
  step("Set down the frame", frame);
  step("Drop in the carriage", carriage, { from: [0, 0, 60], description: "Between the end plates, its nut in line with the holes." });
  step("Thread in the lead screw", leadScrew, { along: leadScrew.at("axis"), distance: -150, turn: 1440, duration: 2.4, description: "From the gear end, through the frame and the carriage's nut." });
  step("Fit the crank", crank, { along: crank.at("axle"), distance: -60, description: "Mesh its gear with the screw's." });
});
