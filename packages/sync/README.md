# @parasocial/sync

The platform layer (M2): the Zero schema, custom mutators shared by client, server and MCP, the Svelte 5 adapter, and framework-agnostic server modules (`Request → Response`) that SvelteKit routes call in one line.

Zero is pinned at **@rocicorp/zero 1.9.0**. The compose `zero-cache` image (`rocicorp/zero:1.9.0`) must match it.

## Entry points

| Import | For | Contents |
|---|---|---|
| `@parasocial/sync` | browser + server | `schema`, `zql` builder, row types, `mutators`, `queries`, undo (`captureInverse`), `createZero`, path validation |
| `@parasocial/sync/svelte` | Svelte components | `setZero`, `getZero`, `useQuery` |
| `@parasocial/sync/server` | app server only | `createPlatform` and the individual handlers, `runMutator`, zip, blobs, auth, migrations |

## Modules

| File | What it does |
|---|---|
| `migrations/*.sql` | Postgres DDL. `0001_init.sql` creates every table plus the `parasocial_zero` publication, which lists only the synced tables. Server-only tables (passkeys, sessions, invites, oauth, `script_contents`, `blobs`) never reach zero-cache. |
| `src/server/migrate.ts` | Migration runner: advisory lock, one transaction per file, `schema_migrations`. CLI: `DATABASE_URL=… bun src/server/migrate.ts` |
| `src/schema.ts` | Zero schema (camelCase over snake_case columns) and relationships. Registers `DefaultTypes` (schema + `MutatorContext`). |
| `src/queries.ts` | Synced queries. **This is the permission layer for reads**: each query filters through `document_members` using the server-side context. |
| `src/mutators.ts` | All custom mutators (see below). Authorization runs server-side through `document_members` roles. |
| `src/undo.ts` | `captureInverse(read, mr)` → the mutations that undo `mr`. Covers params, configurations, notes, markup. |
| `src/client.ts` | `createZero({ userID, cacheURL })`. Use it instead of `new Zero` (see Quirks). |
| `src/svelte/query.svelte.ts` | `useQuery(() => query, { zero?, ttl? })` returns `{ data, status, error }` backed by `$state.raw`. The view is destroyed when its effect is torn down. |
| `src/server/zero.ts` | `/api/zero/mutate` and `/api/zero/query` handlers. `runMutator(db, mr, ctx)` runs a mutator directly (for MCP and import). |
| `src/server/auth.ts` | Passkeys (SimpleWebAuthn 14): sign-up with a name only, discoverable sign-in (autofill), add or remove passkeys, HttpOnly session cookie, first account is admin, open vs. invite sign-up. |
| `src/server/blobs.ts` | Content-addressed blobs: filesystem and S3 (`Bun.S3Client`) adapters, upload-then-reference, HMAC-signed expiring read URLs scoped to a document, refcount sweep. |
| `src/server/zip.ts` | Plain-file import/export (`parasocial.json`, `parts/`, `lib/`, `notes.json`) with fflate. Zips are deterministic. `readDocumentDir` reads the same layout from a folder, for seeding `examples/`. |
| `src/server/versions.ts` | Version contents on demand (History tab, MCP `read_version`). |
| `src/server/http.ts` | Origin policy: requests from the **engine origin are always rejected**, and unsafe cross-origin methods are rejected. Also cookie helpers. |
| `src/server/index.ts` | `createPlatform()` wires everything from env and runs migrations. |

## Wiring into SvelteKit

```ts
// src/lib/server/platform.ts
import { createPlatform } from "@parasocial/sync/server";
export const platform = await createPlatform(); // reads env (see deploy/.env.example), runs migrations, starts the hourly blob sweep
```

| Route file | One-liner |
|---|---|
| `routes/api/zero/mutate/+server.ts` | `export const POST = ({ request }) => platform.mutate(request);` |
| `routes/api/zero/query/+server.ts` | `export const POST = ({ request }) => platform.query(request);` |
| `routes/api/auth/[...path]/+server.ts` | `export const GET = ({ request }) => platform.auth(request); export const POST = GET;` |
| `routes/api/blobs/[...path]/+server.ts` | `export const GET = ({ request }) => platform.blobs(request); export const POST = GET;` |
| `routes/api/documents/[...path]/+server.ts` | `export const GET = ({ request }) => platform.documents(request); export const POST = GET;` |
| `routes/api/versions/[id]/+server.ts` | `export const GET = ({ request }) => platform.versions(request);` |
| `hooks.server.ts` | `event.locals.user = await platform.resolveUser(event.request);` |

Auth routes live under `/api/auth/…`: `GET session`, `POST register/options|verify`, `POST login/options|verify`, `POST logout`, `GET passkeys`, `POST passkeys/options|verify|delete`, `GET|POST admin/settings`, `GET|POST admin/invites`. On the client, pair them with `@simplewebauthn/browser` (`startRegistration` / `startAuthentication`, using `useBrowserAutofill` for the sign-in field).

Client:

```ts
import { createZero, mutators, queries } from "@parasocial/sync";
import { setZero, useQuery } from "@parasocial/sync/svelte";

const zero = createZero({ userID: data.user.userID, cacheURL: `${location.origin}/zero` });
setZero(zero); // in the root layout
const scripts = useQuery(() => queries.scripts({ documentID })); // scripts.data, scripts.status
zero.mutate(mutators.script.write({ documentID, path: "parts/bracket.ts", content, baseVersion: s.version }));
```

The session cookie reaches zero-cache on the websocket because `/zero` is same-origin. zero-cache then forwards it to `/api/zero/*` (`ZERO_*_FORWARD_COOKIES=true`), so the browser never handles a token.

## Mutators

All ids are client-generated and passed in args, so optimistic and authoritative rows match. Errors are `ApplicationError`s with `details.code`: `unauthenticated`, `forbidden`, `not_found`, `invalid`, `invalid_path`, `stale`, `exists`, `edit_failed`, `claimed`, `not_claimed`, `blob_missing`.

| Group | Mutators | Notes |
|---|---|---|
| `document` | `create`, `rename`, `updateSettings`, `delete` (owner), `import` | |
| `script` | `write`, `edit` (search/replace, each match must be unique unless `all`), `delete` | `baseVersion` is the script's `version` (`null` means create). A stale base is rejected with `details.current = { content, version, contentHash }`. Every change creates a version; a write with identical content is a no-op. Paths must be `parts/*.ts` or `lib/**/*.ts`. |
| `version` | `restore` | Copies scripts and param state to the tip as a new version, "Restored from v12". |
| `param` | `set`, `reset`, `resetAll`, `apply` | Coalesced: the same author's changes within 10 s, with nothing committed in between, fold into one version ("Params: thickness 3 → 5"). The expression is stored as typed, alongside the evaluated value. **`Default` holds no overrides**: overrides need a named configuration (PLAN §8). |
| `configuration` | `create`, `duplicate`, `rename`, `delete` | Coalesced into the same params versions (`+M3`, `M3 → M4`, `−M3`). |
| `note` | `create`, `reply`, `deleteMessage`, `claim`, `release`, `setStatus`, `remove`, `restore`, `reanchor`, `setOrphaned` | `create` requires the snapshot blob to already exist. `claim` is for agent sessions only and fails with "Claimed by Claude Code (label)". A human reply moves AwaitingReview or Resolved back to Open. `kind: "activity"` replies form the agent log. |
| `markup` | `add`, `remove` | Draft strokes (no note) get attached by `note.create({ strokeIDs })`. |
| `presence` | `set`, `clear` | Per tab or agent session: selection and active configuration. |
| `agent` | `start`, `setStatus` | Called by the MCP server with `ctx.agentSessionID`. |

`ctx` is `{ userID, agentSessionID? }`. The push endpoint only ever sets `userID`. `agentSessionID` is only set server-side by MCP through `runMutator`, and is checked to belong to the user.

### Undo

```ts
const inverse = await captureInverse((q) => zero.run(q), mr); // before mutating
zero.mutate(mr);
// ⌘Z: const redo = await captureInverseAll(read, inverse); inverse.forEach((m) => zero.mutate(m));
```

Script writes, restores and presence aren't undoable (they go through Restore). Undoing `note.create` soft-deletes the note.

## Quirks (Zero 1.9)

- **Permissions are synced queries, not `definePermissions`**, which is deprecated in 1.x. Reads are controlled by `queries.ts`, and writes by the checks inside the mutators.
- **Construct Zero with `createZero`.** `new Zero({ context: { userID } })` infers the context type from the literal, and then `zero.mutate(mutators.x(...))` fails to typecheck.
- A mutator that throws on the client aborts the mutation **before it is pushed**. The client-side checks therefore only reject what they can prove from local data (bad paths, a stale `baseVersion` visible locally, someone else's claim). Anything else is left to the server.
- Mutators return nothing to the caller. Structured results (such as stale content) travel in `ApplicationError.details`, which reaches the client as `(await zero.mutate(mr).server).error.details`.
- The query endpoint's response is `{ kind: "QueryResponse", queries: [...] }`, and zero-cache sends `schema=zero_0&appID=zero` on the push URL.
- `svelte` resolves to its server build under `bun test`. The adapter test compiles `.svelte.ts` through a Bun plugin (`test/svelte-plugin.ts`) and drives the client runtime directly.

## Tests

```sh
docker run -d --name parasocial-sync-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=parasocial_test -p 54329:5432 postgres:17 -c wal_level=logical
bun test packages/sync          # TEST_DATABASE_URL overrides the default postgres://test:test@localhost:54329/parasocial_test
```

Each test file creates and drops its own `ps_test_*` database. Opt-in suites:
- `S3_TEST_ENDPOINT=http://localhost:58333 …` runs the S3 adapter against the compose storage.
- `ZERO_E2E_CACHE_URL=…` runs `test/zero-cache.e2e.test.ts`: real Zero clients through a real zero-cache, with this package's handlers served from the host.
