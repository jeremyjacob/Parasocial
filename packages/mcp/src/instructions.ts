// Agent instructions: sent as the MCP server's instructions and served as a resource (§5, §7).
// Clients truncate server instructions (Claude Code keeps ~2048 chars, less after a channel's own
// instructions), so ESSENTIALS comes first and stays short; modeling details live in the API's
// JSDoc, served by the api_reference tool and the d.ts resource.
import { API_DTS_URI } from "./api-reference";

export const ESSENTIALS = `Parasocial is code-driven parametric CAD. A document is TypeScript scripts: studios/*.ts export parts (export default part("Name", () => solid)) or assemblies; helpers go in lib/. People review the 3D model and pin notes on faces, edges and parts; your job is usually to pick up a note, change the scripts, verify, and resolve it.

Modeling API docs: call api_reference (no args: index; { topic: "cheatsheet" } to start; { symbol: "Solid.fillet" }; topics plane, selection, sketch, solid, part, assembly). Full d.ts: resource ${API_DTS_URI}; real scripts: parasocial://examples. Units are mm and degrees, Z up. plane.XZ sketches [x, z] with normal −Y; plane.YZ sketches [y, z], normal +X.

Workflow
1. list_problems, then list_notes (status "Open").
2. claim_note before working on a note; release_note if you stop.
3. get_note describes each target (stable name, operation, source line); render({ view: "note:<id>" }) shows the note's view.
4. edit_script or write_script with the baseVersion you read (write_scripts: several files, one version); writes regenerate and return errors to fix.
5. Verify (render, measure, describe_model, query, list_problems), then set_note_status "Resolved" without asking.
6. wait_for_notes to keep working as notes come in.
Every document tool takes an optional document id (default: this session's document).`;

// What the tool descriptions don't already say: how the pieces fit together, and modeling advice.
export const DETAILS = `Details
- Edits: a stale baseVersion is rejected with the current content; re-read and redo your change on top of it. Fix the errors a write returns before continuing (the workspace shows the last good geometry meanwhile). otherSessions and changedByOthers in write results name files others are on or changed since you read them (including lib files your studios import): re-read those before building on them. An identical retry succeeds without a new version.
- Resolving: no permission request or routine completion reply; reply only with useful information, a question or a caveat, briefly. A human follow-up reopens a resolved note.
- Params: set_param never edits source and by default is a preview only your session sees. The Default configuration is exactly what the code says: to change a default, edit the script.
- Poses: to show a mechanism in another position use set_pose, not params or script edits; render({ parts: ["mechanism"] }) shows the assembly's instances as your session poses them.
- Modeling extras (api_reference has details): pipe(path3d | helix | points, r) for ropes, cables and helical grooves; history selection solid.edges({ createdBy: "finUnion" }) or the selector "@finUnion" (prefer it over coordinate filters); in-script measure.distance / minClearance / overlap / volume / area / length / boundingBox / centroid, and check(cond, "reason") to fail a part on a design rule with its script line. part(name, body, { material, partNumber, description, vendor, standard }) feeds bom and drawing.
- Standard holes and parts (screws, nuts, inserts, bearings, circlips, MGN rails): don't model them by hand; see api_reference topic "std" and .hole(pts, { screw: "M3", counterbore: "ISO4762" }).
- Modeling conventions (api_reference topic "part"): give params a short plain-language label; tag anything a human might point at, since tags become part of the stable names notes use to find their geometry after dimensions change. Assemblies, instances, connectors and joints: topic "assembly".`;

export const INSTRUCTIONS = `${ESSENTIALS}\n\n${DETAILS}`;
