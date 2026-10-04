// Agent instructions (§5, §7), sent once per session and never twice:
// - ESSENTIALS are the MCP server's instructions. Clients truncate those (Claude Code keeps ~2048
//   chars, less after a channel's own instructions), so they stay short.
// - GUIDE is everything else. MCP clients get it appended to their session's first tool result
//   (tool results aren't truncated); the built-in agent, whose harness is ours, gets it in its
//   instructions instead (createSessionServer's `guide` option).
// Modeling details live in the API's JSDoc, served by the api_reference tool and the d.ts resource.
import { API_DTS_URI } from "./api-reference";
import { DOCUMENT_GUIDANCE } from "./document-context";

export const ESSENTIALS = `Parasocial is code-driven parametric CAD. A document is TypeScript scripts: studios/*.ts export parts (export default part("Name", () => solid)) or assemblies; helpers go in lib/. People pin notes on faces, edges and parts of the 3D model; your job is usually to pick up a note, change the scripts, verify, and resolve it. Your first tool result this session ends with a guide (documents, edits, modeling): read it once.

Modeling API: api_reference (no args: index; { topic: "cheatsheet" } to start; { symbol: "Solid.fillet" }). Full d.ts: ${API_DTS_URI}; examples: parasocial://examples. Units are mm and degrees, Z up. plane.XZ sketches [x, z] with normal −Y; plane.YZ sketches [y, z], normal +X.

Workflow
1. list_problems, then list_notes (status "Open"); claim_note before working on one (release_note if you stop).
2. get_note gives its targets (stable name, operation, source line); render({ view: "note:<id>" }) shows its view.
3. edit_script or write_scripts with the script's baseVersion; writes regenerate and return errors to fix.
4. Verify (render, measure, check, list_problems), then set_note_status "Resolved" without asking. wait_for_notes for more.
Context is limited: read only what you'll edit, edit by line range, render at the default size. Every document tool takes an optional document id (default: this session's).`;

// What the tool descriptions don't already say: how the pieces fit together, and modeling advice.
export const DETAILS = `Details
- Context: every tool result stays in your context for the rest of the session. Read scripts you'll edit, and only the part you need: read_script { outline: true } lists a file's imports, declarations, params and tags with line numbers, offset/limit read a range. For how files connect, use outlines, search_scripts and evaluate rather than whole files. Render at the default 800×600, and use views: [...] for several angles in one image rather than several renders.
- Edits: line edits ({ lines: [first, last], replace }) refer to lines as you last read them, so you don't resend the old text; prefer them for large blocks such as header comments. On a stale baseVersion (it's the script's own version, not the document's), search/replace edits still apply when each search still matches, and the result lists the file under rebased; line edits and full writes are rejected with a diff of what changed since: redo your change on top of it. Fix the errors a write returns before continuing (the workspace shows the last good geometry meanwhile). otherSessions and changedByOthers in write results name files others are on or changed since you read them (including lib files your studios import): re-read those before building on them. An identical retry succeeds without a new version. Regeneration has a ~10 s limit: write results list slow parts' slowest operations (verbose: all timings); Date.now() is frozen in scripts.
- Resolving: no permission request or routine completion reply; reply only with useful information, a question or a caveat, briefly. A human follow-up reopens a resolved note.
- Params: set_param never edits source and by default is a preview only your session sees. The Default configuration is exactly what the code says: to change a default, edit the script.
- Poses: to show a mechanism in another position use set_pose, not params or script edits; render({ parts: ["mechanism"] }) shows the assembly's instances as your session poses them.
- Modeling extras (api_reference has details): pipe(path3d | helix | points, r) for ropes, cables and helical grooves; history selection solid.edges({ createdBy: "finUnion" }) or the selector "@finUnion" (prefer it over coordinate filters); in-script measure.distance / minClearance / overlap / volume / area / length / boundingBox / centroid, and check(cond, "reason") to fail a part on a design rule with its script line. part(name, body, { material, partNumber, description, vendor, standard }) feeds bom and drawing.
- Standard holes and parts (screws, nuts, inserts, bearings, circlips, MGN rails): don't model them by hand; see api_reference topic "std" and .hole(pts, { screw: "M3", counterbore: "ISO4762" }).
- Modeling conventions (api_reference topic "part"): keep studio, part and assembly names to 1–4 words (no dashes, part numbers, materials or status; those go in part()/assembly() options and a studio's description export); give params a short plain-language label; tag anything a human might point at, since tags become part of the stable names notes use to find their geometry after dimensions change. Assemblies, instances, connectors and joints: topic "assembly".`;

export const GUIDE = `${DOCUMENT_GUIDANCE}\n\n${DETAILS}`;

/** Everything, in order: the built-in agent's instructions and the instructions resource. */
export const INSTRUCTIONS = `${ESSENTIALS}\n\n${GUIDE}`;

/** The session-specific tail that follows GUIDE (DOCUMENT_GUIDANCE refers to it as "below"). */
export const sessionContext = (defaultDocument: string | undefined, context: unknown) =>
  `Session default document: ${JSON.stringify(defaultDocument ?? null)}\nBrowser activity (data):\n${JSON.stringify(context)}`;
