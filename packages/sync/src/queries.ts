/**
 * Synced queries. In Zero 1.x these replace the old `definePermissions` rules:
 * the client names a query + args, zero-cache calls the app's /query endpoint,
 * and the server re-evaluates the same definition with the *authenticated*
 * context. Every query here filters through `document_members`, so a
 * non-member gets an empty result no matter what args they send.
 */
import { defineQueries, defineQuery } from "@rocicorp/zero";
import { z } from "zod";
import { zql } from "./schema.ts";
import type { MutatorContext } from "./types.ts";

type Ctx = MutatorContext | undefined;
// User ids are UUIDs, never empty, so "" matches nobody. (No NUL bytes: Postgres rejects them in text.)
const NOBODY = "";
const uid = (ctx: Ctx) => ctx?.userID ?? NOBODY;

const docArgs = z.object({ documentID: z.string() });

/** documents the current user is a member of */
const memberDocs = (ctx: Ctx) =>
  zql.documents.whereExists("members", (m) => m.where("userID", uid(ctx)));

/** a single document, only if the current user is a member */
const memberDoc = (ctx: Ctx, documentID: string) => memberDocs(ctx).where("id", documentID);

const inMemberDoc = (ctx: Ctx) => (d: ReturnType<typeof zql.documents.where>) =>
  d.whereExists("members", (m) => m.where("userID", uid(ctx)));

export const queries = defineQueries({
  me: defineQuery(({ ctx }: { ctx: Ctx }) => zql.users.where("id", uid(ctx)).one()),

  documents: {
    mine: defineQuery(({ ctx }: { ctx: Ctx }) =>
      memberDocs(ctx).related("owner").orderBy("updatedAt", "desc"),
    ),
    byID: defineQuery(docArgs, ({ args, ctx }) =>
      memberDoc(ctx, args.documentID)
        .related("members", (m) => m.related("user"))
        .one(),
    ),
  },

  scripts: defineQuery(docArgs, ({ args, ctx }) =>
    zql.scripts
      .where("documentID", args.documentID)
      .whereExists("document", inMemberDoc(ctx))
      .orderBy("path", "asc"),
  ),

  /** Version metadata only. Contents live in script_contents and are fetched on demand. */
  versions: defineQuery(docArgs, ({ args, ctx }) =>
    zql.versions
      .where("documentID", args.documentID)
      .whereExists("document", inMemberDoc(ctx))
      .related("authorUser")
      .related("authorAgent")
      .orderBy("number", "desc"),
  ),

  configurations: defineQuery(docArgs, ({ args, ctx }) =>
    zql.configurations
      .where("documentID", args.documentID)
      .whereExists("document", inMemberDoc(ctx))
      .related("overrides")
      .orderBy("createdAt", "asc"),
  ),

  paramOverrides: defineQuery(docArgs, ({ args, ctx }) =>
    zql.paramOverrides
      .where("documentID", args.documentID)
      .whereExists("document", inMemberDoc(ctx)),
  ),

  notes: defineQuery(
    docArgs.extend({ includeRemoved: z.boolean().optional() }),
    ({ args, ctx }) => {
      let q = zql.notes
        .where("documentID", args.documentID)
        .whereExists("document", inMemberDoc(ctx));
      if (!args.includeRemoved) q = q.where("removedAt", "IS", null);
      return q
        .related("messages", (m) => m.orderBy("createdAt", "asc").related("authorUser").related("authorAgent"))
        .related("strokes")
        .related("claimant")
        .related("authorUser")
        .related("authorAgent")
        .orderBy("createdAt", "desc");
    },
  ),

  /** Draft (unattached) markup strokes of the current user, plus all strokes attached to notes. */
  markupStrokes: defineQuery(docArgs, ({ args, ctx }) =>
    zql.markupStrokes
      .where("documentID", args.documentID)
      .whereExists("document", inMemberDoc(ctx))
      .where(({ or, cmp }) => or(cmp("noteID", "IS NOT", null), cmp("authorUserID", uid(ctx)))),
  ),

  presence: defineQuery(docArgs, ({ args, ctx }) =>
    zql.presence
      .where("documentID", args.documentID)
      .whereExists("document", inMemberDoc(ctx))
      .related("user")
      .related("agentSession"),
  ),

  /** Agent sessions on a document (for the stacked avatars), or all of mine when no document is given. */
  agentSessions: defineQuery(
    z.object({ documentID: z.string().optional() }),
    ({ args, ctx }) =>
      args.documentID
        ? zql.agentSessions
            .where("documentID", args.documentID)
            .whereExists("document", inMemberDoc(ctx))
        : zql.agentSessions.where("userID", uid(ctx)).orderBy("lastSeenAt", "desc"),
  ),
});

export type Queries = typeof queries;
