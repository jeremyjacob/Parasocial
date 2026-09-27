import { assembly } from "parasocial";
import body, { lid, drawer } from "./box";

export const name = "Mechanism";

// How the box's parts move. Every joint is 0 where the parts are modeled (closed); drag the lid
// or the drawer in the viewport. Parts that run into each other show red.
export default assembly("Hinged box", ({ revolute, slider }) => {
  revolute(body, lid, body.at("hinge"), { min: 0, max: 110, name: "lid" });
  slider(body, drawer, drawer.at("rail"), { min: 0, max: 40, name: "drawer" });
});
