import { assembly } from "parasocial";
import frame, { crank, leadScrew, carriage } from "./slide";
import { CRANK_R, GEAR_R, LEAD, INNER, CARRIAGE } from "../lib/dims";

export const name = "Mechanism";

// The joints of the slide, tied together: one degree of freedom. Drag the crank, the screw or the
// carriage and the other two follow; the carriage stops at the end plates, and so does the crank.
export default assembly("Lead-screw slide", ({ fix, revolute, slider, gear, screw }) => {
  fix(frame);
  const turn = revolute(frame, crank, crank.at("axle"), { name: "crank" });
  const spin = revolute(frame, leadScrew, leadScrew.at("axis"), { name: "screw" });
  const travel = slider(frame, carriage, carriage.at("rail"), { min: -(INNER - CARRIAGE / 2), max: INNER - CARRIAGE / 2, name: "carriage" });
  // meshing gears turn opposite ways: the screw turns -10/20 of a turn per crank turn
  gear(turn, spin, -CRANK_R / GEAR_R);
  // a right-handed screw: 8 mm along +X per turn
  screw(spin, travel, LEAD);
});
