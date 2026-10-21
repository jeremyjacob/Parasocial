import { buildSteps } from "parasocial";
import mechanism from "../studios/mechanism";
import base, { turret, lowerArm, lowerRod, elbow, upperArm, upperRod, wrist, shade, bulb } from "../studios/lamp";

// Bottom up. The arms ride on one side of the knuckles and the rods on the other, so each slides on
// its pins from its own side.
export default buildSteps(mechanism, ({ step }) => {
  step("Set down the base", base);
  step("Seat the turret", turret, { from: [0, 0, 60], turn: 90 });
  step("Pin on the lower arm", lowerArm, { from: [0, 60, 0] });
  step("Pin on the lower rod", lowerRod, { from: [0, -60, 0] });
  step("Add the elbow", elbow, { from: [0, 0, 60], description: "Between the tops of the lower arm and rod." });
  step("Pin on the upper arm and rod", [upperArm, upperRod], { from: [0, 0, 60], stagger: 0.2 });
  step("Add the wrist", wrist, { from: [60, 0, 0] });
  step("Hang the shade", shade, { from: [0, 0, -60] });
  step("Screw in the bulb", bulb, { from: [0, 0, -40], turn: 720 });
});
