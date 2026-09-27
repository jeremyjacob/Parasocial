import { assembly } from "parasocial";
import base, { turret, lowerArm, lowerRod, elbow, upperArm, upperRod, wrist, shade, bulb } from "./lamp";

export const name = "Mechanism";

// How the lamp moves (this studio holds its own copies of the parts). Every joint is 0 where the parts are modeled. Two closed loops: the lower
// arm, lower rod, turret and elbow form a parallelogram, and so do the upper arm, upper rod,
// elbow and wrist, so the elbow and the wrist stay level. Four degrees of freedom: swivel,
// shoulder, elbow and the shade's tilt. Drag the arms, the shade or the turret.
export default assembly("Desk lamp", ({ fix, revolute, fastened }) => {
  fix(base);
  revolute(base, turret, turret.at("swivel"), { min: -170, max: 170, name: "swivel" });

  // lower parallelogram (angles: positive raises the arm)
  revolute(turret, lowerArm, turret.at("arm"), { min: -20, max: 45, name: "shoulder" });
  revolute(turret, lowerRod, turret.at("rod"), { name: "shoulder rod" });
  revolute(lowerArm, elbow, lowerArm.at("elbow"), { name: "elbow pin" });
  revolute(lowerRod, elbow, lowerRod.at("elbow"), { name: "elbow rod pin" });

  // upper parallelogram
  revolute(elbow, upperArm, elbow.at("arm"), { min: -30, max: 50, name: "elbow" });
  revolute(elbow, upperRod, elbow.at("rod"), { name: "elbow rod" });
  revolute(upperArm, wrist, upperArm.at("wrist"), { name: "wrist pin" });
  revolute(upperRod, wrist, upperRod.at("wrist"), { name: "wrist rod pin" });

  // the shade tilts on the wrist; the bulb rides in its socket
  revolute(wrist, shade, wrist.at("tilt"), { min: -30, max: 100, name: "tilt" });
  fastened(shade, bulb, { name: "bulb" });
});
