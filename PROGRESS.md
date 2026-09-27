# Progress

Living status for resuming after a context reset. PLAN.md is the source of truth; deviations are recorded in PLAN.md §14 (Deviations) and summarized here.

## Environment
- macOS arm64 (M1 Pro, 8 cores, 16 GB). Bun 1.4.2 (no Node/npm on PATH — everything runs on Bun). Docker 29 via OrbStack. Local Postgres 18 on :5432. Playwright Chromium cached.
- replicad cloned (shallow, e4b05f6) at `reference/replicad/` (gitignored). OCCT WASM: `replicad-opencascadejs@1.1.0` (pinned).

## Done
- Repo init, Bun workspace skeleton (`packages/*`).
- M0 (kernel, Bun side): replicad WASM loads in ~110–150 ms under Bun. OCCT history **is reachable** in the stock build:
  `Generated/Modified/IsDeleted` on MakePrism, MakeFillet, BRepAlgoAPI_Cut/Fuse (BuilderAlgo). `NCollection_List_TopoDS_Shape` iterates via copy + `First()/RemoveFirst()`.
  Shape identity: `ReplicadShapeHasher.HashCode` + `IsSame` (IndexedMap has no `Add` binding; not needed). Mesh extractor returns per-face groups (tri start, count, hash) and edge groups. No fork needed so far. Spike: `packages/kernel/spike/history.ts`.

## In progress
- M0 browser half: engine iframe (cross-origin, COOP/COEP), worker, threads, transfer, Three.js picking.
- M1: kernel op layer + element maps + naming.

## Blocked
- (none)

## Next
- M1 naming + API core, regression corpus.
- M2 platform, design system (/design route).
