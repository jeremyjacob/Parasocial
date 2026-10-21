import { buildSteps } from "parasocial";
import mechanism from "../studios/mechanism";
import body, { lid, drawer } from "../studios/box";

// How the hinged box goes together: open the Build view (A) on the Mechanism studio to play it.
export default buildSteps(mechanism, ({ step }) => {
  step("Set down the body", body);
  // the drawer's rail connector points out the front: it starts out there and slides in
  step("Slide in the drawer", drawer, { along: drawer.at("rail"), distance: 60, description: "Push it all the way in until the front sits flush." });
  step("Fit the lid", lid, { from: [[0, 40, 40], [0, 0, 25]], description: "Hook it over the back edge, then lower it shut." });
});
