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
6. wait_for_notes to keep working as notes come in.`;

export const DETAILS = `Details
- Claims: claim_note fails if another agent holds the note. People can paste images (sketches, references, screenshots) into a note or reply: get_note returns them.
- Edits: always pass the baseVersion you read. A stale baseVersion is rejected with the current content; re-read and redo your change on top of it. To change a lib/ file and the studios that use it, use write_scripts: all files land in one version or none do. Every write regenerates automatically and returns compact results (per part ok and problems with file:line, the new script versions; verbose: true for the full result): fix any errors before continuing. Results also list otherSessions recently on those files and changedByOthers (files you read, or lib files your studios import, that someone else changed since): re-read those before building on them. Writes are safe to retry: an identical retry succeeds without a new version (pass the same writeId to be sure). Errors come with a source location and say what to do next; the workspace shows the last good geometry until you fix it.
- Inspecting interiors: render({ view: "iso", section: { origin: [0, 0, 5], normal: [0, 0, 1] } }) cuts at z = 5 mm and keeps z <= 5; negate the normal to keep the other side. The section applies only to that image and works with named views, note views or a custom camera.
- Resolving: once the work is complete and verified, call set_note_status with status "Resolved" immediately. No permission request or completion reply is needed. Reply only when you have useful information, a question, or a caveat; reply_to_note links your version and resolves by default. For unfinished work or questions, pass status "Open". These status changes release your claim. A human follow-up reopens a resolved note. Skip routine completion replies; when a reply is useful, be concise and include only what the human needs.
- wait_for_notes returns new notes and human replies as soon as they land (or nothing at its timeout; call it again).
- Params: get_params / set_param / reset_param never edit source. By default set_param is a session preview: only your MCP session sees it (render, measure, check, describe_model…), it creates no version and doesn't disturb people or other agents. Pass scope "shared" to save an override in your active configuration (set_configuration) as a version. The default is exactly what the code says; to change a default, edit the script. Overrides accept units and expressions ("1/4 in", "=width/2").
- Poses: to show a mechanism in another position, use set_pose({ assembly, joints: { lid: 90 } }) (session preview by default, scope "shared" saves the positions everyone sees) rather than params or script edits. describe_model lists assemblies and joints. render({ parts: ["mechanism"] }) renders an assembly's instances where your session poses them; parts also takes instance ids. Renders are Z-up like the workspace (front looks along +Y); pass up: "y" for Y-up views.
- Standard holes and parts (screws, nuts, inserts, bearings, circlips, MGN rails): don't model them by hand; see api_reference topic "std" and .hole(pts, { screw: "M3", counterbore: "ISO4762" }).
- Modeling conventions (api_reference topic "part"): give params a short plain-language label; tag anything a human might point at, since tags become part of the stable names notes use to find their geometry after dimensions change. Assemblies, instances, connectors and joints: topic "assembly".`;

export const INSTRUCTIONS = `${ESSENTIALS}\n\n${DETAILS}`;
