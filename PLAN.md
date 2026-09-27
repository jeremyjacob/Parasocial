# Parasocial — Plan

An AI-first, code-driven parametric CAD tool that runs in the browser. Parts are TypeScript scripts built on an OpenCascade-backed API. You review the model in a polished 3D workspace and give feedback by pinning **notes directly onto faces, edges and parts**, or by sketching over the model with a pencil. AI agents read those notes over MCP, edit the scripts, check their own work, and reply in the thread.

It's a client-server app like Onshape, with documents stored on the server. The client drives changes the way Linear does: every edit applies instantly and syncs in the background. v1 ships as a self-hostable docker compose stack.

The UI should feel like Figma or Framer: calm, precise and considered. It should never feel barren. The one thing v1 leaves out is **direct-edit modeling tools**. Geometry changes only through code, whether an agent or a person writes it, and through parameter values the code declares.

---

## 1. Principles

1. **Code is the source of truth.** Every model is a set of TypeScript scripts stored with its document. Parameter overrides and configurations are data next to them. There is no hidden state.
2. **The client drives changes.** Every change is an optimistic mutation. It applies in the client immediately and the server confirms it. People and agents go through the same mutators.
3. **Notes are the primary interaction.** Point at geometry and say what's wrong. The system turns "this face" into a precise reference an agent can act on.
4. **References never silently drift.** Stable topological naming underpins both notes and the API. When a reference can't be resolved, the UI says so loudly and never guesses.
5. **Agents check their own work.** Regeneration is automatic, and agents can render, measure and inspect before replying.
6. **The UI gets out of the way, but is never empty.** It has rich, read-only insight into the model, Figma-grade inputs for parameters, and smooth motion throughout.
7. **Fast and snappy, always.** Input never waits on the kernel, the network or an animation. Performance has budgets, and CI checks them (see §9).
8. **Sync what's authored, recompute what's derived.** Sync carries only what people and agents author. Meshes, caches and renders are addressed by content hash and can be thrown away.
9. **Built-ins are written in the public API.** Anything we ship can also be written by users and agents. This keeps the path open to direct-edit tools later.

## 2. Core loop

```
 ┌──────────────┐  pin note / sketch    ┌──────────────┐
 │    Human     │ ────────────────────▶ │    Notes     │
 │  (workspace) │ ◀─ reply + version ── │   (threads)  │
 └──────┬───────┘                       └──────┬───────┘
        │ tweak params                         │ list_notes / claim_note
        ▼                                      ▼
 ┌──────────────┐   write_script        ┌──────────────┐
 │   Scripts    │ ◀──────────────────── │  AI agents   │
 │  (Postgres)  │ ────────────────────▶ │   (MCP)      │
 └──────────────┘   regen result,       └──────────────┘
                    render / measure
```

1. The human selects geometry and presses `C` to leave a note ("wall too thin here, needs 2mm"). They can also sketch over the model with the pencil (`P`).
2. An agent calls `list_notes` and claims one. Each note comes with its resolved entity, stable name, **source location** (`bracket.ts:42`), any pencil strokes, and a snapshot of the view the note was made from.
3. The agent edits the script with `write_script` or `edit_script`. Regeneration is automatic: the write returns the regeneration result. The agent then calls `render` and `measure` to verify.
4. The agent replies on the thread and moves the note to **Awaiting review**, with a link to the new version.
5. The human compares the old and new geometry, then resolves the note or replies. Once a note is done, an agent or the human can remove it.

## 3. Architecture

```
parasocial/                      Bun workspaces monorepo
├─ packages/
│  ├─ kernel/       OCCT WASM build + TS bindings, tessellation, history → element maps
│  ├─ naming/       stable names, query resolution, disambiguation, note anchoring
│  ├─ api/          public modeling API (what scripts import), selectors, params, types
│  ├─ runtime/      engine iframe + worker, script hygiene, transpile, regen cache, provenance capture
│  ├─ viewer/       Three.js renderer, picking, selection, overlays, markup (framework-agnostic)
│  ├─ sync/         Zero schema, custom mutators (shared by client, server and MCP), Svelte 5 adapter
│  ├─ app/          SvelteKit: workspace UI plus server routes (mutators, auth, OAuth, blobs, MCP)
│  ├─ engine-pool/  headless Chromium pool that runs the engine build for MCP and cache warming
│  └─ mcp/          MCP tool definitions (hosted by the app server)
├─ deploy/          docker compose stack
└─ examples/        reference parts; also the regression corpus and the source of empty-state art
```

### Services (docker compose)

| Service | Role |
|---|---|
| `postgres` | All authored state. Logical replication on, for Zero |
| `zero-cache` | Syncs Postgres to clients |
| `app` | SvelteKit, running on Bun. Serves the UI, runs mutators, handles passkeys and OAuth, hosts the MCP endpoint, and serves the engine page on a separate origin (second port or subdomain) |
| `engine-pool` | Headless Chromium workers that run the same engine build. No network egress |
| `caddy` | TLS and routing for the app and engine origins. Passkeys need HTTPS everywhere except `localhost` |
| `storage` | S3-compatible object storage for derived data and authored binaries. S3 or R2 when hosted; a bundled S3-compatible service or a filesystem adapter in compose |

**Data flow:** a client runs a mutator optimistically and pushes it to the `app` server. The server runs the same mutator against Postgres, and `zero-cache` fans the result out to every client. MCP tools call the same mutators on the server, so agent edits show up live in the workspace.

### Where geometry runs

There is **one engine build**, hosted in two places.

- **In the browser**, the kernel runs in a Web Worker inside a sandboxed, cross-origin **engine iframe** (see §5, Sandboxing). It regenerates automatically on every change the human sees.
- **On the server**, `engine-pool` runs the same build in headless Chromium for MCP calls: write results, `render`, `measure`, `describe_model`, and so on. MCP never depends on a browser tab being open.
- **Why:** the same build with the same deterministic inputs means agents get exactly the geometry the human sees. We also avoid maintaining OCCT on both a server runtime and the browser.
- **Isolation**, because this runs user code on our servers:
  - Each document job gets its own Chromium process, with the Chromium sandbox on.
  - Containers have no network egress.
  - Jobs have CPU, memory and wall-clock limits.

### Authored vs. derived data

- **Authored** (Postgres, synced by Zero): documents, scripts, versions, configurations and overrides, notes and messages, pencil strokes, and ephemeral presence (selection, which agent is working on what).
- **Derived** (object storage): meshes, the per-op B-rep cache and renders. Each is keyed by `hash(script contents, effective params, engine build)`, is immutable, and is cached forever.
  - Each cached mesh carries its face and edge metadata (stable names, source locations, generating operation), so a document opened from cache is fully interactive before the kernel has loaded (see §9).
  - Clients regenerate locally. The cache speeds up cold loads and headless calls. A missing cache entry makes things slower but never breaks them.
  - The engine build hash is part of the key, so a kernel change can't poison the cache.
- **Authored binaries** (note snapshots with markup): upload first, then run the mutation that references the hash. A row never points at a missing blob.
- **Cleanup:** cache entries expire. Authored blobs are swept by reference count.
- **Access:** signed URLs, checked against document permissions.

### Data model (sketch)

`users`, `passkeys`, `oauth_clients`, `oauth_tokens`, `documents`, `document_members` (document, user, role), `scripts` (document, path under `parts/` or `lib/`, content, head version), `versions` (document, number, author, message, note, snapshot of script hashes and params), `configurations`, `param_overrides`, `notes`, `note_messages`, `markup_strokes`, `agent_sessions`, `presence`.

**Permissions go through `document_members` from day one**, even though v1 documents have a single owner. Zero permission rules, signed blob URLs and MCP access all check membership. Share links and multiplayer later become a new role or token, not a migration.

### Import and export

A document exports as a zip of plain files and imports back the same way:

```
bracket.zip
├─ parasocial.json        settings, units, configurations and overrides
├─ parts/
│  ├─ bracket.ts
│  └─ lid.ts
├─ lib/
└─ notes.json             optional: threads and anchors
```

Versions and blobs are not exported. This is how `examples/` gets seeded and how the regression corpus runs. It's also the backup path, and the escape hatch for moving an instance (see Accounts and auth). It's available from the document menu, from the documents list (import), and over MCP.

### Accounts and auth

- **Passkeys only, with just a name.** No email and no password.
  - Sign up: enter a name, then create a passkey.
  - Sign in: one button, plus passkey autofill.
- Users can add more passkeys in settings. Synced passkeys (iCloud Keychain, Google Password Manager, 1Password) cover device loss. The sign-up screen says plainly that there is no other way to recover an account.
- **The domain is fixed at install.** Passkeys are bound to the domain they were created on (the WebAuthn RP ID), so moving an instance to a new domain invalidates every passkey. The domain is set once in the compose config, and the docs warn about this. To move, users export their documents and re-import them on the new instance.
- **Instance setup:** the first account becomes admin. The admin chooses between open sign-up and invite links.
- **MCP uses OAuth 2.1**, following the MCP authorization spec. The app is the authorization server, with dynamic client registration and PKCE.
  - Connecting Claude Code opens the browser, the user signs in with their passkey, and a consent screen shows the client's name.
  - Settings lists connected agents, and each can be revoked.

## 4. Kernel and naming

- **OCCT build:** depend on replicad's WASM build (`replicad-opencascadejs`, pinned) rather than upstream opencascade.js. Fork its build pipeline if we need to trim modules or add bindings.
- **replicad is a reference, not the core.** It has no topological naming and its operations don't expose OCCT history, so we own the thin layer that calls OCCT operations; naming has to own that layer anyway. replicad is MIT-licensed, so we port code with attribution where it fits: 2D sketch/drawing geometry, OCCT memory management, meshing with face/edge groups, STEP/STL export, text. Clone its source into `reference/replicad/` (gitignored, never built or imported) to read when we need it. The WASM is loaded separately (LGPL compliance and caching). It's threaded when COOP/COEP is available and falls back to single-threaded otherwise.
- **Element maps:** after each operation, walk `Generated` / `Modified` / `IsDeleted` (and the `BOPAlgo` history for Booleans). Every output face, edge and vertex gets a name:
  `opId · role · sourceName`, for example `bracket/extrude1 · side · sketch1/line3`.
- **Edges and vertices without their own history** are named by the names of the faces around them.
- **Splits** resolve to all descendants. When only one is wanted, disambiguate by adjacency to other named entities, then by closest match to the previous geometry.
- **Lazy names:** each operation records its OCCT history cheaply as it runs. Name strings are only built when something asks for them (selection, notes, `describe_model`).
- **Per-op cache:** each operation's output B-rep and history are cached by `hash(op inputs)`, so a change only reruns the operations downstream of it. It lives in the same layer as naming and is built with it in M1.
- **Operation IDs** come from the API call (explicit `tag`, or else an auto ID from the call-site path plus a per-scope counter), so they stay stable when unrelated code changes.
- **Provenance:** every operation records its call site (`file:line:col`) from a captured stack trace, source-mapped back through transpilation.
- **Reference implementation to study:** FreeCAD 1.0's topological naming work, which uses element maps on OCCT.

## 5. Scripting API

TypeScript, transpiled in the worker with esbuild-wasm. Scripts run off the main thread and inside a sandbox.

- **One file per part.** Each `parts/*.ts` has a default export of `part(...)`, so the file, the part in the parts list, `#lid` mentions and source links all line up. Multi-part files (named exports) can come later.
- **Imports:** only `parasocial` and relative imports within the document (`../lib/gears`), resolved by an esbuild plugin that reads the synced scripts. No npm packages in v1: they would break determinism and the no-network sandbox.

### Sandboxing

A blob or same-origin worker is **not** a sandbox: it shares the app's origin, so it could `fetch` the app server, read the origin's storage, or `importScripts` remote code. We use a cross-origin iframe as the boundary and light hygiene inside it. The engine never fetches anything itself: the app sends it script sources over the channel. The server-side pool adds process and network isolation on top (see §3).

1. **Cross-origin engine iframe (the boundary).**
   - A tiny engine page is served from a separate origin (e.g. a second port or an `engine.` subdomain). It hosts the kernel worker.
   - CSP: `connect-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:`. That means no network access and no remote code.
   - The engine page is served with COOP/COEP/CORP headers so it stays cross-origin isolated. OCCT threads need `SharedArrayBuffer`.
   - Its only channel to the app is a `MessageChannel`. The app validates every message against a schema. Mutations are **never** reachable through this channel.
   - The app server rejects requests from the engine origin: it checks the Origin header, and the engine never receives a session credential.
2. **Script hygiene inside the worker (correctness, not security).** The iframe is the security boundary. These measures only stop scripts from interfering with the kernel, with each other, or with determinism.
   - `Object.freeze` the `parasocial` API objects so scripts can't monkey-patch them.
   - Evaluate each module in a `new Function` wrapper that shadows ambient globals (`self`, `globalThis`, `fetch`, `importScripts`, `Worker`, `WebSocket`, `setTimeout`, …) as `undefined`. This is leaky by design and acceptable because of the iframe.
   - **Determinism:** replace `Math.random` with a PRNG seeded per regeneration, and stub `Date` inside the worker. Stable names, the derived-data cache and browser/server parity all depend on identical output from identical input.
   - Clear the module cache before each regeneration so no state carries over between runs.
   - Tag each module with `//# sourceURL` so stack traces map back to `parts/*.ts` for provenance.
   - **Revisit SES** (`lockdown()` + a fresh `Compartment` per regeneration) if scripts turn out to interfere with each other or the kernel in practice.

Killing and respawning the worker is **only for timeouts** (runaway scripts). A spare, pre-loaded worker takes over so recovery is instant. Normal changes never cancel a run (see §9, latest-wins).

**Prior art to borrow from:**
- **CadQuery**: fluent chaining, workplanes, and string selectors (`">Z"`, `"|X"`). These are well represented in LLM training data, which is a real advantage for agents.
- **replicad**: the closest JS/TS precedent on opencascade.js, covering sketch → drawing → shape layering, API ergonomics, and memory management of OCCT objects (explicit `delete()` vs. scoped cleanup).
- **build123d**: its selector and filter design (`.filter_by`, `.sort_by`, `.group_by`) is cleaner than CadQuery's in places.

Match CadQuery and replicad naming wherever there's no reason to differ, so agents' existing knowledge carries over.

```ts
import { part, param, sketch, plane, mm } from "parasocial";

export default part("Bracket", ({ color }) => {
  const t = param("thickness", 3, { min: 1, max: 10, unit: mm, step: 0.5 });
  const w = param("width", 40, { unit: mm });

  const base = sketch(plane.XY)
    .rect(w, 25, { center: true, tag: "outline" })
    .circle([0, 0], 4, { tag: "bore" })
    .extrude(t, { tag: "base" });

  return base
    .fillet(base.edges("base.side").parallelTo("Z"), 2, { tag: "corners" })
    .chamfer(base.edges("base.cap.end & bore"), 0.5)
    .color(color.auto());
});
```

### v1 surface

| Area | Included |
|---|---|
| Planes and references | origin planes, offset / angle / 3-point planes, axes, points |
| Sketch (explicit geometry) | line, polyline, arc (3-pt, tangent, center), circle, rect, slot, polygon, spline, offset, 2D fillet/chamfer, trim, mirror, text, regions |
| Solid operations | extrude (new/add/remove, symmetric, up-to), revolve, sweep, loft, shell, draft, thicken, mirror, linear/circular pattern, hole (simple/counterbore/countersink) |
| Finishing | fillet (constant; variable later), chamfer (distance, distance-angle) |
| Booleans | union, subtract, intersect, split |
| Transforms | move, rotate, copy |
| Selection | tags, stable-name queries, CadQuery-style selectors (`">Z"`, `"|X"`), filters (`.planar()`, `.parallelTo()`, `.largest()`), set ops (`&`, `|`, `-`) |
| Parameters | `param()` with unit, bounds, step and options, which generates UI automatically. The value in code is the **default**; the UI and agents can override it per configuration (see §8) |
| Inspection | `measure`, `massProps`, `boundingBox`, `isValid` |
| Parts | multi-part documents, colors, materials (density) |
| Units | per-document units, SI default. Every numeric input accepts a unit (`"1/4 in"`) and expressions |

Later: constraint-solved sketches (`sketch.constrain(...)` on **planegcs**), variable fillets, helix and threads, pattern along a curve, custom features with their own property panels, and an outline view of each part (operation records are kept internally, so this is UI work only).

### Designed for agents

- **Error messages say what to do next**, with a source location. For example: `fillet radius 5 exceeds adjacent face width 3.2 (bracket.ts:18)`, not a bare OCCT error code.
- **Complete `.d.ts` files with doc comments and examples.** Served over MCP as a resource.
- **Agent instructions** are sent as the MCP server's instructions and also served as a resource. They cover API conventions, tagging guidance ("tag anything a human might point at"), claiming notes, and the verify-before-reply rule.

## 6. Notes

### Anchor model

```ts
type NoteAnchor = {
  targets: Array<{               // one or many, across parts
    kind: "face" | "edge" | "vertex" | "part" | "point";
    name: string;               // stable name, e.g. "bracket/extrude1 · cap.end"
    query?: string;             // semantic query, if the entity was tagged
    point: [number, number, number];   // part-local fallback point on the surface
    normal?: [number, number, number];
  }>;
  camera: { position; target; up; fov; ortho: boolean };
  version: string;              // document version the note was made on
  configuration: string;        // active configuration when the note was made
  sectionPlane?: Plane;         // if made while a section view was active
  markup?: Stroke[];            // pencil strokes, part-local (see §8 Pencil)
  snapshot: BlobHash;           // viewport capture, including markup
};
```

Notes anchor to geometry and parts, never to operations or params (they can still mention params). A note can target **any number of entities**, across parts. Feedback about a whole operation ("make the corner fillets bigger") targets its faces; the stable names already identify the operation that made them.

Resolution on every regen:
1. Resolve by stable name or query.
2. If that fails, use the nearest entity of the same kind to `point`, within a tolerance.
3. If that fails, the note is **orphaned**. The pin shows as a dashed "ghost" at its last position, and the thread offers "Re-anchor".

### Lifecycle

`Open` → `Agent working` (claimed by one agent session) → `Awaiting review` → `Resolved`. A reply moves it back to `Open`.

- **Orphaned** is a flag that can apply at any stage.
- **Removed** is a soft delete, by the human or by an agent once the work is done. Removed notes are hidden by default and can be restored from the Notes filter.

### UX

- **`C` enters note mode** (Figma convention). Click geometry to place a pin, or select first and then press `C` to note the selection. A note can target any number of entities, across parts. Shift/⌘-click, box select, or "Select all from this operation" builds the selection first.
- **Pins sit in the viewport**, hide when their geometry is occluded, and cluster when zoomed out. Avatars distinguish the human from each agent.
- **Threads live in a Notes tab** in the right panel. They can be filtered by status (including Removed), part or author. Hovering a thread highlights its geometry and shows its markup.
- **Every agent reply links a version.** Clicking it opens compare (see §8 Compare).
- **Notes can mention params** (`@thickness`) and parts (`#lid`), which render as chips.

## 7. MCP server

Streamable HTTP at `https://<host>/mcp`, authenticated with OAuth (see §3). **Many clients can connect at once.** Each session is identified by its registered client name plus an optional label, and gets its own avatar in the workspace. Parasocial doesn't decide how many agents work on a document; claims and base versions keep them from colliding.

Every tool takes a `document`. A session connected from a document's **Connect agent** dialog defaults to that document.

### Tools

| Tool | Returns |
|---|---|
| `list_documents()` / `create_document(name)` | documents the user can access |
| `list_notes(status?, part?)` | threads with markup and snapshot. Each target is described fully: entity type, stable name, the operation that made it (tag, operation type, source line), the helper call chain (`mountingHoles()` at `bracket.ts:30` → `lib/holes.ts:12`), key measurements (area/length, normal/radius), and the named neighbors it touches |
| `get_note(id)` / `reply_to_note(id, text, version?)` | thread operations |
| `claim_note(id)` / `release_note(id)` | claim a note for this session; fails with the holder's name if another session has it |
| `set_note_status(id, status)` / `delete_note(id)` | status changes; `delete_note` removes a finished note (soft delete) |
| `get_selection()` | the human's current selection, described the same way as note targets |
| `list_scripts()` / `read_script(path)` | scripts, each with its content and current version |
| `write_script(path, content, baseVersion, message?)` / `edit_script(path, edits, baseVersion, message?)` / `delete_script(path, baseVersion)` | each write creates a version and **returns the regeneration result**: success, or structured errors (same shape the UI shows, see §8 Errors) with source locations, timings and warnings. A stale `baseVersion` is rejected with the current content |
| `render({ view, highlight?, section?, style? })` | PNG; named views (`iso`, `top`, …), a note's anchor view, or a custom camera |
| `describe_model(part?)` | parts, bounding boxes, volume/area/mass, then faces and edges with name, type, area/length, normal/axis, source location |
| `query(expr, part?)` | evaluate a selector against the live model; returns matched entities |
| `measure(a, b)` | distance, angle, min clearance between entities or parts |
| `get_params(configuration?)` | each param's code default, override (if any) and effective value |
| `set_param(name, value, configuration?)` / `reset_param(name, configuration?)` | set or clear an override and return the regeneration result; never edits source |
| `list_configurations()` / `set_configuration(name)` | configurations, and this session's active one (each session and each user has its own) |
| `list_problems()` | current errors and warnings per part, same structured shape as write results, with the version and author that introduced each. Agent instructions say to check it at the start of a session and after each write |
| `check(part?)` | BRepCheck validity, self-intersection, interference between parts |
| `list_versions()` / `read_version(id, path?)` / `restore_version(id)` | history; `restore_version` copies a version to the tip as a new version |
| `export(part, format)` | STEP / STL / 3MF, as a signed download URL |
| `export_document()` / `import_document(zip)` | the plain-file format from §3 Import and export |

There is no `regenerate` tool. Regeneration happens automatically on every write.

### Resources

API type definitions, API docs and examples, agent instructions, and document settings.

### Guardrails

- Regeneration has a timeout. A runaway script's worker is killed and replaced by a warm spare, so it can't hang a session.
- Scripts run in the isolated engine pool (see §3). Agent writes go through mutators, never through the engine.
- Script paths stay inside `parts/` and `lib/`.
- Every write creates a version, so an agent's change can always be inspected and restored.
- Rate limits per session.

## 8. Workspace UI

The references are Figma UI3, Framer and Onshape (see `inspo ui/`).

### Sign-in and empty states

Polished but restrained. Empty states get depth from **grayscale geometric art**: clay-style renders of our own example parts, made with our engine in a consistent studio lighting setup. They're exported as optimized AVIF/WebP images in light and dark variants, so these screens load without WASM.

- **Sign in:** centered card over a soft render. A name field and "Create account" for new users; "Sign in with passkey" and autofill for returning users.
- **No documents:** a large render, "Create your first document," and a few example documents to open.
- **Empty document:** "Add a part" or "Connect an agent," with a small render.
- **Agent not connected:** the Connect agent dialog shows the MCP URL with a copy button and a one-line setup for Claude Code.
- **No notes / no versions:** one line of guidance and the relevant shortcut, not a blank panel.
- **Engine loading:** the document opens from the cached mesh and metadata, fully interactive, with a thin progress line while the kernel loads. Only a document that has never been generated falls back to a render placeholder.

### Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ ◆ Bracket ▾   Default ▾      Model | Code        ◉◉ 2  ⌘K  ◐  (you) │  top bar
├────────────┬───────────────────────────────────────────┬────────────┤
│ Parts      │                                    ┌────┐ │ Properties │
│  ● Bracket │                                    │cube│ │ Params     │
│  ● Lid     │                                    └────┘ │ Notes (3)  │
│  ● Gasket  │                              ◐ ✂ ⊥ 100%   │ ────────── │
│            │              3D viewport                  │  Figma-    │
│            │      (pins, markup, selection, ghosts)    │  style     │
│            │                                           │  panels    │
│            │              ┌─────────────┐              │            │
│            │              │ 175.2 mm²   │  selection   │            │
│            │              └─────────────┘  label       │            │
│            │  ┌────────────────────────────────────┐   │            │
│            │  │ ↖ select ◌ note ✎ pencil ↔ measure │   │            │
└────────────┴──┴────────────────────────────────────┴───┴────────────┘
```

`Default ▾` is the active configuration. `◉◉ 2` shows the connected agents. There is no status bar (see Selection label).

- **Left panel, with tabs:**
  - **Parts** (default): visibility, isolate, color swatch, and a status badge (ok / warning / error). There is no feature tree in v1: people review the model, not the code, and agents fix their own errors. Operation structure shows up where it's useful instead, in the face/edge Properties and in note targets.
  - **Scripts:** the document's scripts under `parts/` and `lib/`.
  - **History:** versions (see Versions).
- **Viewport:**
  - view cube, standard views
  - a small control cluster under the view cube: display mode (shaded, shaded + edges, wireframe, hidden-line), section, orthographic/perspective, selection filter, zoom
  - zoom to fit (`F`) and zoom to selection
  - grid, origin triad
  - configurable navigation presets (Onshape / SolidWorks / Fusion / trackpad-first)
  - trackpad pinch and pan; hold `Space` and drag to pan (Figma convention)
  - SpaceMouse via WebHID (later)
- **Floating bottom toolbar** (Figma-style), with just four tools: **select** (`V`), **note** (`C`), **pencil** (`P`), **measure** (`M`).
- **Right panel, with tabs:**
  - **Properties** for the current context:
    - With nothing selected: document settings, including units.
    - With a part selected: material, mass properties, color, and a shortcut to its params.
    - With a face or edge selected: type, area or length, normal or radius, stable name, **"Created by `corners` (fillet) · `bracket.ts:18` →"**, and the notes on it.
  - **Params:** the parameter and configuration editor (see below).
  - **Notes:** threads (see §6).
- **Code mode:** a Monaco split view next to the viewport. Selecting geometry highlights the source line, and placing the cursor on an operation highlights its geometry. This is also where people write code by hand.
  - The viewport regenerates live from the editor buffer as you type (short debounce, then latest-wins) and shows an **Unsaved preview** pill.
  - Monaco is lazy-loaded when Code mode first opens and prefetched when the browser is idle.
  - **`⌘S` saves and creates a new version**, which is when other clients and agents see the change.
  - Errors show as Monaco markers on the offending lines.

### Selection label

Measurements have one home on the canvas and one in the panel, each with a clear job:

- **The selection label** is a small pill anchored next to the selection, like Figma's size label. It shows the single most useful value: area for faces, length for edges, radius for circular edges, distance or angle for two entities, and a count for mixed selections. It's for glancing.
- **Properties** has the full detail. It's for reading.

### Pencil

A grease-pencil tool for marking up the model, like drawing on a screenshot in Figma, but in 3D.

- Strokes project onto the surface under the pen. Where the pen leaves the model, they continue on a plane at the depth of the last hit. They're stored in part-local coordinates, so they stay attached to the model as you orbit.
- Drawing starts a draft note. The strokes become its markup, and the entities they cross become its targets. Add text and post, or `Esc` to discard.
- Agents get the strokes, the crossed entities, and the snapshot with the markup drawn in.
- Markup shows while its note is open or hovered, and hides once the note is resolved.
- A few colors, one width, and an eraser. Nothing more in v1.

### Measure tool

- Click two entities to draw a dimension in the viewport, showing distance, angle or clearance. `Esc` clears it.
- "Note this measurement" turns it into a note with the dimension attached.

### Compare

Opened from a version link in a thread or from History.

- The previous geometry appears as a translucent ghost over the current geometry.
- A **Before ↔ After** slider in the compare bar blends from the old geometry alone (solid), through the ghost overlay, to the new geometry alone (solid).
- Hold `B` to flash the before state.
- A version picker changes which version is compared (the previous one by default).

### Parameters and configurations

Parameters are first-class. Their **defaults live in code** (the value passed to `param()`), and the UI can **override** them without touching the source.

- **Configurations** are named sets of overrides, for example `M3`, `M4` or `Print-draft`. `Default` is the configuration with no overrides, so it is exactly what the code says.
  - The active configuration is picked in the top bar and at the top of the Params tab. It's per user (and per agent session), not per document.
  - Configurations can be created, duplicated, renamed or deleted in the Params tab.
- Overrides and configurations are stored in Postgres. Scripts never see them directly; the runtime passes effective values into `param()`.
- **Overridden values are obvious.** An overridden row gets an accent-colored value and a dot by its label, like Figma's overridden component properties. Hovering shows the code default and where it's declared (`bracket.ts:12`).
- **Reverting is one click.** Each overridden row has a ↺ reset button, and each part group and each configuration has "Reset all". `⌘⌫` on a focused input resets it too.
- If the code default changes underneath an override, the row shows "code default changed: 3 → 4" until the override is reset or kept.
- Overrides outside the declared bounds are rejected inline, with the bound shown.
- Inputs behave like Figma's:
  - Drag the label to scrub the value. Shift gives coarse steps, Alt fine steps.
  - `↑`/`↓` step by the param's `step` (with Shift/Alt modifiers).
  - Inputs accept expressions and units (`=width/2`, `1/4 in`). The expression is stored in the override as typed, and the evaluated value is shown beside it.
  - Changes regenerate live, latest-wins (see §9), with coarse meshing while scrubbing. The override is committed when the gesture ends.
- Params are grouped per part and can be collapsed. The panel is generated entirely from the `param()` declarations.

### Versions

- A version is a snapshot of the whole document: every script plus the param state.
- New versions come from `⌘S`, agent writes, param changes (a burst of changes is coalesced into one version, e.g. "Params: thickness 3 → 4"), and restores.
- Each version records its author (you or a named agent session), a timestamp, a message, and the note it answers if any.
- The **History** tab lists versions. Opening one shows its geometry and its scripts **read-only**, with a banner ("Viewing version from 14:02 · Restore · Back to current").
- **Restore** copies that version to the tip as a new version ("Restored from v12"). Nothing is ever overwritten, so restores can themselves be undone.
- There are no code diffs.

### Unsaved edits (dirty buffers)

Code mode can have unsaved edits while an agent changes the same script.

- A dirty buffer shows a dot on its tab and in the Scripts list.
- Notes and the pencil are disabled while you're previewing unsaved code ("Save to add notes"), because notes must anchor to a saved version.
- If the script changes while the buffer is dirty, a banner appears above the editor: "`bracket.ts` was changed by Claude Code. **Reload** (discard my edits) · **Keep mine** (my next save overwrites theirs)." Nothing is lost either way, because the other write already exists as a version.
- If the script changes while the buffer is clean, the buffer reloads silently and keeps its cursor and scroll position.
- While an agent has claimed a note on a part, the part's script tab shows that agent's avatar, so a collision is visible before it happens.
- Closing a dirty buffer or the browser tab asks before discarding.

### Errors

**Errors are the agents' job, not the user's.** Agents receive structured errors in every write result and through `list_problems`, and fix them over MCP. The UI stays calm: it tells people something is wrong without asking them to debug it.

- **Kinds:** syntax/transpile, runtime exception, operation failure (for example a fillet that fails), invalid geometry (BRepCheck), timeout, and unresolved references (selectors that match nothing, orphaned notes).
- **The viewport never goes blank.**
  - After a syntax error, the last good geometry stays on screen, dimmed.
  - After an operation failure, the model shows the result up to the last successful operation, and the failing operation's inputs are highlighted in red (for example, the edges a fillet couldn't handle).
- **A quiet status pill** in the viewport ("Bracket didn't regenerate · agents notified") instead of a banner. Expanding it shows the message and a `bracket.ts:18 →` link for people who want to look.
- **Everywhere else:** a red badge on the part and on the script. Monaco markers in Code mode.
- Warnings (validity, slow regeneration, selectors that match more than expected) use the same surfaces in amber and never block.
- **Errors caused by people** (a param override or an edit in Code mode) reach agents the same way: they appear in `list_problems` with the version and author that introduced them.

### Selection

- **Preselect:** orange stroke on hover.
- **Selected:** translucent orange fill plus stroke.
- Click to select. Shift or ⌘-click adds to the selection. **`Esc` clears it** (Figma convention).
- Box select, dragging on empty space: a window selects fully enclosed entities, a crossing selects any it touches.
- Selection filters (face / edge / vertex / part) in the viewport control cluster and on number keys.
- `Tab` cycles through entities hidden under the cursor, but only while the pointer is over the viewport and no input has focus. Otherwise `Tab` moves keyboard focus as usual.
- Select tangent chain / select loop from the context menu.
- The right-click context menu covers: note, measure, **select all from this operation**, isolate, hide, zoom to, reveal source, copy stable name.

### Visual system

- Neutral greys with one blue accent. Orange is reserved for selection.
- Light and dark themes. Follows the system setting by default.
- **Nested rounded corners stay concentric** (inner radius = outer radius − padding).
- Built on shadcn-svelte / bits-ui components with custom tokens. Tailwind v4.
- Inter or Geist for text. Tabular numerals in every numeric field.
- **Part colors:** a curated, tasteful palette, assigned round-robin in the Onshape style, with no orange or accent-blue hues. Each part can override its own color.
- **Empty-state art:** grayscale clay renders of the example parts (see Sign-in and empty states).
- **Rendering:**
  - crisp, anti-aliased feature edges (Line2)
  - silhouette edges
  - subtle ambient occlusion
  - polygon offset so edges never fight faces
  - reversed-Z or logarithmic depth
- **Motion:** 150–250 ms spring or ease-out transitions on panels, hovers, camera moves (view cube, zoom-to), and discrete regenerations such as an agent write or a restore (cross-fade from old mesh to new). While scrubbing or typing, meshes swap instantly. Every animation is interruptible and never delays input. Respects reduced motion.

### Undo

- **`⌘Z` / `⌘⇧Z` undo and redo your own recent mutations** in this session: param overrides, configuration changes, note actions and markup. Each undo is itself a mutation, so it syncs like any other change.
- It never undoes another session's work, including agents'. Those go through Restore (see Versions).
- Inside Monaco, `⌘Z` is the editor's own undo.
- Older changes, and anything across a reload, go through Restore.

### Keyboard

- **⌘K command palette** for every action, view, param, and note.
- Every action has a shortcut. Shortcuts are customizable, with conflict detection, and avoid browser-reserved keys.
- A cheatsheet opens on `?`.
- Defaults: `V` select, `C` note, `P` pencil, `M` measure, `S` section, `F` fit, `B` (hold) flash before in compare, `Esc` deselect/cancel, `Space`-drag pan, `1–4` selection filters, `⌘Z`/`⌘⇧Z` undo/redo, `⌘S` save (Code mode), `⌘⇧E` export, `⌘\` toggle Code mode.

### Agent presence

- The top bar shows stacked avatars for connected agent sessions. Hovering lists each one with its status: idle, working on a note, or writing a script.
- While an agent is working on a part, that part shows a subtle shimmer.
- Each agent's activity (renders, measurements, edits) is visible as a collapsible log inside the note thread, so its reasoning stays inspectable.

## 9. Performance

Speed and snappiness are features. These budgets are checked in CI against the `examples/` corpus, and a regression fails the build.

### Budgets

| Interaction | Budget |
|---|---|
| Hover preselect | within the current frame |
| Click to select, with Properties updated | < 50 ms |
| Param scrub step, when upstream operations are cached | < 100 ms to the new mesh on screen |
| Open a document with a warm cache | < 1 s to an interactive model (hover, select, Properties), before the kernel is ready |
| Kernel ready on a repeat visit (WASM already cached) | < 1.5 s |
| Agent write to regeneration result, warm engine | < 1 s |
| Typical edit to re-rendered result, cold op cache | < 2 s |

### Regeneration

- **Latest-wins, never kill-to-cancel.** At most one regeneration runs per part. New requests replace the queued one, and when the current run finishes it jumps straight to the latest request. Terminating the worker is only for timeouts.
- **Per-op cache** (see §4): a change reruns only the operations downstream of it.
- **Progressive meshing:** coarse tessellation while scrubbing or typing, refined once input settles. Only faces whose geometry changed are re-meshed.
- **Lazy naming:** history is recorded as operations run; name strings are built on demand.
- Compare ghosts are computed on demand. Compare is rare, so nothing is precomputed for it.

### Loading

- **The WASM is cached aggressively.** It's served from a content-hashed URL with `Cache-Control: immutable`, precached by a service worker on the engine origin, and compiled with `WebAssembly.compileStreaming` so the browser also caches the compiled code. A repeat visit never downloads it again.
- **Cache-first open:** a document renders from its cached mesh and metadata immediately, and the kernel loads in the background.
- The engine iframe starts warming when the pointer hovers a document in the list.
- The workspace is a client-rendered SPA route (no SSR or hydration). Sign-in and the documents list use SSR.
- Monaco and other heavy panels are lazy-loaded and prefetched when idle.
- Zero syncs version **metadata** only. A version's contents are fetched when it's opened.

### Rendering and data path

- **Render on demand**, never in a continuous loop: only when the camera, the scene or the selection changes.
- Ambient occlusion is dropped while the camera moves and restored when it stops.
- All edges of a part are batched into one line object. Picking uses a GPU ID buffer (or a BVH), never raycasting raw triangles.
- **Meshes are always transferred, never copied**, across worker → engine iframe → app (`Transferable` ArrayBuffers).
- **Geometry never enters Svelte state.** It lives in the `viewer` package. Large lists use `$state.raw`.
- Threaded OCCT requires the app itself to be cross-origin isolated too, so the iframe can use `SharedArrayBuffer`. M0 verifies this and measures single- vs. multi-threaded, so a silent fallback can't hide a slowdown.

### Server

- The engine pool keeps warm engines (WASM compiled, kernel initialized). An active document is pinned to one engine, which keeps its per-op cache in memory. Idle engines are recycled.
- Mutations are optimistic, so no user action waits on a network round trip.

## 10. Non-goals for v1

- Direct-edit or interactive modeling tools: sketch drawing UI, on-canvas modeling manipulators, property panels that create features. View tools with handles (dragging a section plane, picking measure points) and the pencil are fine.
- Assemblies and mates. The data model keeps parts separate so assemblies can reference them later.
- 2D drawings.
- Real-time multiplayer between humans and share links, **for now**. `document_members` and Zero keep the door open.
- A managed hosted service. v1 is a self-hostable docker compose stack.
- Git integration.
- A feature tree, outline view or roll back. Operation records are kept internally, so these can be added later as UI only.
- A built-in chat panel. v1 brings your own agents (Claude Code, etc.) over MCP. An embedded agent could come later.

## 11. Milestones

| # | Milestone | Done when |
|---|---|---|
| **M0** | **Kernel spike** | Custom OCCT WASM loads in a worker **inside the cross-origin engine iframe, with COEP working and threads enabled**; using replicad's WASM build, **with the OCCT history API (`Generated`/`Modified`/`IsDeleted`, `BRepTools_History`, `TopTools_ListOfShape` iteration) confirmed reachable, or the build forked to add it**; a box is extruded, filleted and tessellated into Three.js with faces and edges pickable, with meshes transferred (not copied) to the app; threads confirmed working with the app cross-origin isolated; WASM size, cold and cached load time, and single- vs. multi-threaded speed measured |
| **M1** | **Naming + API core** | Element maps for extrude/revolve/boolean/fillet/chamfer; tags and selectors; `param()`; provenance; per-op cache with lazy naming and latest-wins regeneration; **a regression corpus shows fillets surviving upstream dimension changes and a split face**; CI budget checks running |
| **M2** | **Platform** | docker compose stack (Postgres, zero-cache, SvelteKit app, storage); Caddy with TLS; passkey accounts; `document_members` permissions; documents and scripts in Postgres through Zero mutators; versions with restore; zip import/export (seeds `examples/`); our Svelte adapter for Zero |
| **M3** | **Workspace** | Shell with panels, sign-in and empty states, viewport, preselect and selection, selection label, view cube, display modes, parts list, Params tab with overrides and configurations, undo/redo, automatic regeneration, error surfaces, themes, ⌘K; cache-first open and service-worker WASM caching; progressive meshing; render-on-demand; budgets met |
| **M4** | **Notes + markup** | Anchors, resolution, orphan handling, pins, threads, lifecycle with claims and removal, pencil, compare, History tab |
| **M5** | **MCP** | OAuth, the full tool set, many concurrent sessions, the isolated engine pool, agent instructions; the end-to-end loop works with Claude Code on the example parts |
| **M6** | **API breadth + output** | Remaining v1 operations (sweep, loft, shell, draft, patterns, hole, mirror); measure tool and mass properties; section view; STEP/STL/3MF export; Code mode with live preview and dirty-buffer handling |
| **M7** | **Polish** | Motion pass, navigation presets, shortcut customization, box select, performance pass against the budgets on larger parts, accessibility pass |

M0 and M1 carry the risk. M2 doesn't depend on naming and can run alongside them. Don't start M3 until naming is proven on the regression corpus.

## 12. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Kernel | OpenCascade (replicad's build pipeline, trimmed) | LGPL: ship the WASM separately; COOP/COEP for threads |
| Rendering | Three.js (WebGL2; evaluate WebGPU renderer after M3) | Plain Three.js in the `viewer` package, not Threlte, so it stays framework-agnostic |
| App | **SvelteKit** (Svelte 5 runes), running on Bun | Chosen over SolidStart because shadcn-svelte / bits-ui are much more mature |
| Sync | **Zero** + Postgres | Custom mutators shared by client, server and MCP. We own the Svelte adapter in `packages/sync` and pin the Zero version |
| Styling | Tailwind v4 + shadcn-svelte | Custom tokens for the neutral + blue palette and concentric radii |
| Code editor | Monaco | Loaded with the API `.d.ts` files |
| Script runtime | Cross-origin engine iframe → Web Worker; esbuild-wasm | Frozen API, shadowed globals, seeded `Math.random`; source maps for provenance |
| Auth | Passkeys via SimpleWebAuthn; an OAuth 2.1 authorization server for MCP | The OAuth server must support dynamic client registration and PKCE. Evaluate `oidc-provider` |
| MCP | `@modelcontextprotocol/sdk`, streamable HTTP | Hosted in the SvelteKit server |
| Engine pool | Playwright-driven headless Chromium | Per-document processes, no egress, resource limits. Runs on Bun; if Playwright proves flaky under Bun, this one service falls back to Node (it's its own container) |
| Storage | S3-compatible object storage | Content-addressed; signed URLs |
| Runtime and tooling | **Bun**: package manager, workspaces, runtime, scripts, and test runner | `zero-cache` runs in its own upstream container, whatever its runtime |
| Deploy | docker compose | |
| License | AGPL-3.0 (for now) | Compatible with the LGPL OCCT build, which ships as a separate WASM |
| Tests | `bun test` for plain TypeScript packages; Vitest where Vite is needed (Svelte components); geometry regression corpus (regen → compare volume, face count, named-entity survival); mutator tests against a real Postgres; Playwright for the UI; performance budgets (§9) measured in CI on the example corpus | |

## 13. Risks and open questions

- **Naming robustness is the project.** If notes drift, the core interaction fails. Mitigation: build the corpus early, prefer tags, and treat orphaned as a first-class state.
- **LLM spatial reasoning.** Mitigation: rich `describe_model`, source-linked entities, renders from the note's own camera, pencil markup, and the verify-before-reply rule.
- **Iteration latency.** See the budgets in §9. Depends on the per-op cache, progressive meshing and warm engines. OCCT fillets and Booleans on complex parts may still blow the scrub budget; measure on the corpus early.
- **WASM size and load time.** Measure in M0. Budget: < 15 MB compressed. Only the first visit pays for it; after that it's served from the service worker and the compiled-code cache.
- **Browser/server parity.** Geometry must match exactly (same build, deterministic inputs). Renders from the pool use software GL, so they only need to be faithful, not pixel-identical to the user's GPU.
- **Running user code on our servers.** The pool is a real attack surface. Mitigation: Chromium sandbox, per-document processes, no egress, resource limits.
- **Passkey-only accounts have no recovery beyond synced or extra passkeys.** Mitigation: prompt users to add a second passkey, say so clearly at sign-up, and make export easy.
- **Passkeys are bound to the instance's domain.** Mitigation: fix the domain at install, document it, and use export/import for moves.
- **We own the Zero Svelte adapter.** Small, but leaked subscriptions are the main bug risk. Mitigation: pin Zero, test subscription cleanup.
- **Cross-origin isolation friction.** COEP on both origins affects every asset (fonts, CDN scripts). Serve everything from our own origins with CORP headers.
- **Open:** nothing blocking. Revisit the license before any hosted offering.

---

*Original brainstorm: `idea.md`. Figma UI3 reference: https://www.figma.com/blog/our-approach-to-designing-ui3/*

## 14. Deviations

Recorded as they happen, with the reason. The sections above stay the target; these explain where the build differs.

- **Script transpiler: Sucrase instead of esbuild-wasm (§5, §12).** Sucrase is ~0.2 MB versus esbuild-wasm's ~11 MB of WASM, which matters for the "kernel ready < 1.5 s" budget, and it preserves line numbers, so provenance maps stack frames straight back to `parts/*.ts` lines without source maps. Modules are transformed individually and loaded by our own tiny CommonJS loader (fresh cache per regeneration). Sucrase reports some syntax errors at the enclosing arrow function; the loader re-parses the block to find the real line.
- **Scripts are evaluated in sloppy mode.** JavaScriptCore (Bun) performs proper tail calls in strict mode, which drops helper frames from stack traces. Provenance and auto op ids (`part/helper/type<n>`) depend on those frames, so modules are evaluated without `"use strict"` to get identical results under Bun and Chromium. Writes to the frozen API are then ignored rather than throwing; the API is still frozen.
- **Seam edges are excluded from edge selections** unless the selector mentions `seam`. A periodic face's seam is a parametrization artifact, not a feature edge; `base.edges("base.side")` shouldn't pick up a bore's seam.
