# Progress

Living status for resuming after a context reset. PLAN.md is the source of truth; deviations are in PLAN.md §14.

## Environment
- macOS arm64 (M1 Pro, 8 cores, 16 GB). **Bun 1.4.2 only** (no Node/npm on PATH). Docker 29 via OrbStack. Local Postgres 18 on :5432 (user's; don't touch).
- Test Postgres container `parasocial-sync-test-pg` on :54329 (postgres:17, wal_level=logical) for `packages/sync` tests.
- Playwright: root `@playwright/test` (chromium 1243 downloaded). packages/app pins playwright 1.61.1 (cached chromium 1228) for its screenshot script.
- replicad cloned at `reference/replicad/` (gitignored). OCCT: `replicad-opencascadejs@1.1.0` (pinned).

## How to run
- `bun run test` (root): kernel, naming, api, runtime unit tests + geometry corpus (`tests/corpus`, `UPDATE_GOLDEN=1` to accept).
- `bun test packages/sync` (needs test Postgres, see packages/sync/README.md).
- `cd packages/app && bun run dev` → http://localhost:5391/design ; `bun run test` (vitest), `bun run check`.
- M0 spike: `cd packages/viewer && bun spike/serve.ts` (app :5180, engine :5181) then `bun tests/e2e/m0.spike.ts <outdir>`.

## Done
- **M0 kernel spike** — done. Stock replicad WASM exposes OCCT history (Generated/Modified/IsDeleted on MakeShape/BRepAlgoAPI/Fillet). Engine runs in a worker inside a cross-origin iframe (engine origin :5181, COOP/COEP/CORP/CSP), app origin cross-origin isolated; threads work (8) but give no speedup → single-threaded default (§14). Meshes transferred (verified detached). Measurements: WASM 23.0 MB raw / 7.2 MB gzip / 5.7 MB brotli; kernel ready cold ~1.3 s (local), repeat visit ~160–195 ms; bracket regen 20–30 ms warm; pick 0.7 ms; click→describe 1.9 ms.
- **M1 naming + API core** — done. Element maps (extrude/revolve/boolean/fillet/chamfer/transform/pattern), names `op · role · source`, edges/vertices by adjacent faces, splits resolve to all descendants + disambiguation, selectors (patterns, CadQuery `>Z |Z #Z +Z %type [n]`, set ops), `param()` with units/expressions/bounds/overrides, provenance (call site + helper chain, mapped to script lines), per-op cache + lazy names + latest-wins scheduler, corpus (goldens for all examples, fillet survival sweeps, split face, anchors/orphans), engine-level budgets.
- **Runtime**: Engine (regenerate, describe, names, query, resolve, measure, check), sandboxed loader (Sucrase, shadowed globals, seeded random, frozen Date, frozen API, fresh module cache), friendly problems with file:line, last-good geometry on failure, highlight of failing op inputs.
- **Viewer**: Three.js, render on demand, GPU ID picking (faces/edges), preselect/selection/error overlays, display modes, ortho/persp, fit/views, CSS view cube, grid/triad, CAD controls with presets.
- **M2 platform** (subagent, merged): packages/sync — Zero 1.9 schema/queries/mutators/undo, Svelte adapter, passkeys, blobs, zip, versions; deploy/ compose verified (postgres, zero-cache, storage, caddy); engine-pool service is a stub.
- **Design system** (subagent, merged): packages/app SvelteKit + Tailwind v4 + bits-ui, tokens light/dark, components, /design showcase, DESIGN.md, screenshots.
- Examples: bracket, flange (+lib helper), enclosure (body+lid), knob, gasket; corpus parts split, filletchain.

## In progress
- M3 workspace.

## Blocked / stubs
- engine-pool container is a stub (M5).
- OAuth/MCP not started (M5).

## Next
- M3: app routes wired to platform, sign-in, documents list, workspace shell with real engine + viewer, params/configs, errors, ⌘K, undo, cache-first open, SW WASM caching.
- M4 notes/markup/compare/history, M5 MCP, M6 breadth, M7 polish; then full test pass.
