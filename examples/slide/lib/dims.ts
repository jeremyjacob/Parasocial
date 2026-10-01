// Shared between the parts and the assembly: the gear sizes and the screw's lead set how the
// relations in studios/mechanism.ts turn one joint into another.

/** Pitch radius of the crank's gear (mm). */
export const CRANK_R = 10;
/** Pitch radius of the gear on the lead screw (mm): two crank turns per screw turn. */
export const GEAR_R = 20;
/** The lead screw's lead: mm the carriage travels per turn. */
export const LEAD = 8;
/** The lead screw's axis: along X at this height. */
export const AXIS_Z = 30;
/** The crank's axis, above the screw so the two gears mesh. */
export const CRANK_Z = AXIS_Z + CRANK_R + GEAR_R;
/** Inner faces of the end plates (±x), and their thickness. */
export const INNER = 62;
export const PLATE = 8;
/** Carriage length along the screw. */
export const CARRIAGE = 30;
