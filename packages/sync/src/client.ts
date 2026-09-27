/**
 * Browser-side Zero construction. Use this rather than `new Zero(...)`
 * directly: it wires our schema + mutators and pins Zero's generics to the
 * registered context type (`MutatorContext | undefined`). Otherwise TS infers
 * the context from the literal you pass and `zero.mutate(mutators.x(...))`
 * stops typechecking.
 *
 *   const zero = createZero({ userID: session.user.userID, cacheURL: `${location.origin}/zero` });
 *   zero.mutate(mutators.document.create({ id: newID(), name: "Bracket" }));
 */
import { Zero, type ZeroOptions } from "@rocicorp/zero";
import { mutators } from "./mutators.ts";
import { schema, type Schema } from "./schema.ts";
import type { MutatorContext } from "./types.ts";

export type ParasocialZero = Zero<Schema, undefined, MutatorContext | undefined>;

export function createZero(
  opts: { userID: string | null } & Omit<ZeroOptions<Schema, undefined, MutatorContext | undefined>, "schema" | "mutators" | "context" | "userID">,
): ParasocialZero {
  const { userID, ...rest } = opts;
  return new Zero<Schema, undefined, MutatorContext | undefined>({
    ...rest,
    schema,
    mutators,
    userID,
    context: userID ? { userID } : undefined,
  });
}
