/**
 * Zero's server endpoints plus a direct mutator runner.
 *
 *  - `createMutateHandler` → POST /api/zero/mutate  (ZERO_MUTATE_URL)
 *  - `createQueryHandler`  → POST /api/zero/query   (ZERO_QUERY_URL)
 *  - `runMutator`          → run a mutator server-side without the push
 *    protocol (MCP tools, zip import, admin scripts).
 *
 * zero-cache forwards the browser's cookies (ZERO_*_FORWARD_COOKIES=true) and
 * Origin, so the handlers authenticate with the same session cookie as the
 * rest of the app and apply the same engine-origin rejection.
 */
import { handleMutateRequest, handleQueryRequest, isApplicationError } from "@rocicorp/zero/server";
import { mustGetMutator, mustGetQuery, type ReadonlyJSONValue } from "@rocicorp/zero";
import type { AnyMR } from "../undo.ts";
import { mutators } from "../mutators.ts";
import { queries } from "../queries.ts";
import { schema } from "../schema.ts";
import type { MutatorContext } from "../types.ts";
import type { ServerConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { error, json } from "./http.ts";

export type ResolveUser = (req: Request) => Promise<{ userID: string } | null>;

type Deps = {
  db: Db;
  config: Pick<ServerConfig, "appOrigin" | "engineOrigins" | "zeroApiKey">;
  resolveUser: ResolveUser;
};

function gate(req: Request, config: Deps["config"]): Response | null {
  if (req.method !== "POST") return error(405, "Method not allowed");
  if (config.zeroApiKey && req.headers.get("x-api-key") !== config.zeroApiKey) return error(401, "Bad API key");
  // zero-cache forwards the client's Origin; a websocket opened from the engine origin is rejected here.
  const origin = req.headers.get("origin");
  if (origin && config.engineOrigins.includes(origin)) return error(403, "Requests from the engine origin are not allowed");
  return null;
}

/** POST /api/zero/mutate. Browser sessions never carry an agentSessionID. */
export function createMutateHandler({ db, config, resolveUser }: Deps) {
  return async (req: Request): Promise<Response> => {
    const denied = gate(req, config);
    if (denied) return denied;
    const user = await resolveUser(req);
    if (!user) return error(401, "Not signed in");
    const ctx: MutatorContext = { userID: user.userID };
    const result = await handleMutateRequest({
      dbProvider: db.zql,
      request: req,
      userID: user.userID,
      logLevel: "error", // app errors (stale writes, claims) are expected; they go back to the client
      handler: (transact) =>
        transact((tx, name, args) => mustGetMutator(mutators, name).fn({ tx, ctx, args: args as never })),
    });
    return json(result);
  };
}

/** POST /api/zero/query. Re-evaluates the named query with the authenticated context. */
export function createQueryHandler({ config, resolveUser }: Omit<Deps, "db">) {
  return async (req: Request): Promise<Response> => {
    const denied = gate(req, config);
    if (denied) return denied;
    const user = await resolveUser(req);
    // Logged-out clients still get answers: every query filters by membership, so they are empty.
    const ctx: MutatorContext | undefined = user ? { userID: user.userID } : undefined;
    const result = await handleQueryRequest({
      schema,
      request: req,
      userID: user?.userID ?? null,
      logLevel: "error", // app errors (stale writes, claims) are expected; they go back to the client
      handler: (name, args) => mustGetQuery(queries, name).fn({ args: args as never, ctx }),
    });
    return json(result);
  };
}

export type RunResult =
  | { ok: true }
  | { ok: false; message: string; details: Record<string, unknown> & { code?: string } };

/**
 * Runs one mutator authoritatively in its own transaction. This is what MCP
 * tools call; `ctx.agentSessionID` identifies the agent session.
 */
export async function runMutator(
  db: Db,
  request: AnyMR | { name: string; args: ReadonlyJSONValue | undefined },
  ctx: MutatorContext,
): Promise<RunResult> {
  const name = "mutator" in request ? request.mutator.mutatorName : request.name;
  const args = request.args;
  try {
    await db.zql.transaction(async (tx) => {
      await mustGetMutator(mutators, name).fn({ tx, ctx, args: args as never });
    });
    return { ok: true };
  } catch (e) {
    if (isApplicationError(e)) {
      return { ok: false, message: e.message, details: (e.details ?? {}) as Record<string, unknown> };
    }
    throw e;
  }
}

/** Like runMutator but throws the ApplicationError. */
export async function runMutatorOrThrow(db: Db, request: Parameters<typeof runMutator>[1], ctx: MutatorContext) {
  const name = "mutator" in request ? request.mutator.mutatorName : request.name;
  await db.zql.transaction(async (tx) => {
    await mustGetMutator(mutators, name).fn({ tx, ctx, args: request.args as never });
  });
}
