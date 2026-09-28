/**
 * Zero schema: the client-visible slice of the data model.
 *
 * Postgres uses snake_case; Zero rows are camelCase via `.from()`. Server-only
 * tables (passkeys, auth_sessions, invites, oauth_*, script_contents, blobs,
 * instance_settings) are deliberately absent: they are not in the replication
 * publication and never reach clients. See migrations/0001_init.sql.
 *
 * `enableLegacyQueries` / `enableLegacyMutators` stay off: clients can only
 * sync through the named queries in queries.ts (which enforce document
 * membership) and write through the custom mutators in mutators.ts.
 */
import {
  boolean,
  createBuilder,
  createSchema,
  json,
  number,
  relationships,
  string,
  table,
  type JSONObject,
  type Row,
} from "@rocicorp/zero";
import type {
  AgentStatus,
  MutatorContext,
  NoteAnchor,
  NoteStatus,
  Role,
  SelectionEntry,
  VersionChanges,
  VersionKind,
  VersionSnapshot,
} from "./types.ts";

const users = table("users")
  .columns({
    id: string(),
    name: string(),
    avatarSeed: string().from("avatar_seed"),
    isAdmin: boolean().from("is_admin"),
    createdAt: number().from("created_at"),
  })
  .primaryKey("id");

const documents = table("documents")
  .columns({
    id: string(),
    name: string(),
    ownerID: string().from("owner_id"),
    units: string(),
    settings: json<JSONObject>(),
    headVersion: number().from("head_version"),
    /** Blob hashes of the documents-list thumbnail (iso render per theme), and the version it shows. */
    thumbLight: string().from("thumb_light").optional(),
    thumbDark: string().from("thumb_dark").optional(),
    thumbVersion: number().from("thumb_version").optional(),
    /** View-only link token (/s/:token), null when link sharing is off. */
    shareToken: string().from("share_token").optional(),
    createdAt: number().from("created_at"),
    updatedAt: number().from("updated_at"),
  })
  .primaryKey("id");

const documentMembers = table("documentMembers")
  .from("document_members")
  .columns({
    documentID: string().from("document_id"),
    userID: string().from("user_id"),
    role: string<Role>(),
    createdAt: number().from("created_at"),
  })
  .primaryKey("documentID", "userID");

const agentSessions = table("agentSessions")
  .from("agent_sessions")
  .columns({
    id: string(),
    userID: string().from("user_id"),
    oauthClientID: string().from("oauth_client_id").optional(),
    clientName: string().from("client_name"),
    label: string().optional(),
    avatarSeed: string().from("avatar_seed"),
    status: string<AgentStatus>(),
    documentID: string().from("document_id").optional(),
    detail: json<JSONObject>().optional(),
    /** Run by the app itself (the built-in agent), not an MCP connection */
    builtin: boolean().optional(),
    createdAt: number().from("created_at"),
    lastSeenAt: number().from("last_seen_at"),
  })
  .primaryKey("id");

const scripts = table("scripts")
  .columns({
    id: string(),
    documentID: string().from("document_id"),
    path: string(),
    content: string(),
    contentHash: string().from("content_hash"),
    version: number(),
    updatedAt: number().from("updated_at"),
    updatedByUser: string().from("updated_by_user").optional(),
    updatedByAgent: string().from("updated_by_agent").optional(),
  })
  .primaryKey("id");

const versions = table("versions")
  .columns({
    id: string(),
    documentID: string().from("document_id"),
    number: number(),
    kind: string<VersionKind>(),
    authorUserID: string().from("author_user_id").optional(),
    authorAgentID: string().from("author_agent_id").optional(),
    message: string(),
    noteID: string().from("note_id").optional(),
    restoredFrom: string().from("restored_from").optional(),
    snapshot: json<VersionSnapshot>(),
    changes: json<VersionChanges>().optional(),
    createdAt: number().from("created_at"),
    updatedAt: number().from("updated_at"),
  })
  .primaryKey("id");

const configurations = table("configurations")
  .columns({
    id: string(),
    documentID: string().from("document_id"),
    name: string(),
    createdAt: number().from("created_at"),
  })
  .primaryKey("id");

const paramOverrides = table("paramOverrides")
  .from("param_overrides")
  .columns({
    id: string(),
    documentID: string().from("document_id"),
    configurationID: string().from("configuration_id"),
    part: string(),
    name: string(),
    expression: string(),
    value: json<number | string | boolean>(),
    codeDefault: string().from("code_default").optional(),
    updatedAt: number().from("updated_at"),
  })
  .primaryKey("id");

const notes = table("notes")
  .columns({
    id: string(),
    documentID: string().from("document_id"),
    authorUserID: string().from("author_user_id").optional(),
    authorAgentID: string().from("author_agent_id").optional(),
    anchor: json<NoteAnchor>(),
    snapshotHash: string().from("snapshot_hash").optional(),
    status: string<NoteStatus>(),
    orphaned: boolean(),
    claimedBy: string().from("claimed_by").optional(),
    /** Handed to the built-in agent by this user (runs on their provider) */
    agentAssignedBy: string().from("agent_assigned_by").optional(),
    agentAssignedAt: number().from("agent_assigned_at").optional(),
    removedAt: number().from("removed_at").optional(),
    createdAt: number().from("created_at"),
    updatedAt: number().from("updated_at"),
  })
  .primaryKey("id");

const noteMessages = table("noteMessages")
  .from("note_messages")
  .columns({
    id: string(),
    noteID: string().from("note_id"),
    documentID: string().from("document_id"),
    authorUserID: string().from("author_user_id").optional(),
    authorAgentID: string().from("author_agent_id").optional(),
    kind: string<"message" | "activity">(),
    text: string(),
    data: json<JSONObject>().optional(),
    versionID: string().from("version_id").optional(),
    createdAt: number().from("created_at"),
  })
  .primaryKey("id");

const markupStrokes = table("markupStrokes")
  .from("markup_strokes")
  .columns({
    id: string(),
    documentID: string().from("document_id"),
    noteID: string().from("note_id").optional(),
    authorUserID: string().from("author_user_id").optional(),
    part: string(),
    points: json<[number, number, number][]>(),
    color: string(),
    width: number(),
    createdAt: number().from("created_at"),
  })
  .primaryKey("id");

const presence = table("presence")
  .columns({
    id: string(),
    documentID: string().from("document_id"),
    userID: string().from("user_id"),
    agentSessionID: string().from("agent_session_id").optional(),
    selection: json<SelectionEntry[]>(),
    activeConfigurationID: string().from("active_configuration_id").optional(),
    updatedAt: number().from("updated_at"),
  })
  .primaryKey("id");

// ── relationships ──

const documentRels = relationships(documents, ({ many, one }) => ({
  members: many({ sourceField: ["id"], destField: ["documentID"], destSchema: documentMembers }),
  owner: one({ sourceField: ["ownerID"], destField: ["id"], destSchema: users }),
  scripts: many({ sourceField: ["id"], destField: ["documentID"], destSchema: scripts }),
  versions: many({ sourceField: ["id"], destField: ["documentID"], destSchema: versions }),
  configurations: many({ sourceField: ["id"], destField: ["documentID"], destSchema: configurations }),
  notes: many({ sourceField: ["id"], destField: ["documentID"], destSchema: notes }),
}));

const memberRels = relationships(documentMembers, ({ one }) => ({
  user: one({ sourceField: ["userID"], destField: ["id"], destSchema: users }),
  document: one({ sourceField: ["documentID"], destField: ["id"], destSchema: documents }),
}));

const scriptRels = relationships(scripts, ({ one }) => ({
  document: one({ sourceField: ["documentID"], destField: ["id"], destSchema: documents }),
}));
const versionRels = relationships(versions, ({ one }) => ({
  document: one({ sourceField: ["documentID"], destField: ["id"], destSchema: documents }),
  authorUser: one({ sourceField: ["authorUserID"], destField: ["id"], destSchema: users }),
  authorAgent: one({ sourceField: ["authorAgentID"], destField: ["id"], destSchema: agentSessions }),
}));
const configurationRels = relationships(configurations, ({ one, many }) => ({
  document: one({ sourceField: ["documentID"], destField: ["id"], destSchema: documents }),
  overrides: many({ sourceField: ["id"], destField: ["configurationID"], destSchema: paramOverrides }),
}));
const paramOverrideRels = relationships(paramOverrides, ({ one }) => ({
  document: one({ sourceField: ["documentID"], destField: ["id"], destSchema: documents }),
}));
const noteRels = relationships(notes, ({ one, many }) => ({
  document: one({ sourceField: ["documentID"], destField: ["id"], destSchema: documents }),
  messages: many({ sourceField: ["id"], destField: ["noteID"], destSchema: noteMessages }),
  strokes: many({ sourceField: ["id"], destField: ["noteID"], destSchema: markupStrokes }),
  claimant: one({ sourceField: ["claimedBy"], destField: ["id"], destSchema: agentSessions }),
  authorUser: one({ sourceField: ["authorUserID"], destField: ["id"], destSchema: users }),
  authorAgent: one({ sourceField: ["authorAgentID"], destField: ["id"], destSchema: agentSessions }),
}));
const noteMessageRels = relationships(noteMessages, ({ one }) => ({
  document: one({ sourceField: ["documentID"], destField: ["id"], destSchema: documents }),
  note: one({ sourceField: ["noteID"], destField: ["id"], destSchema: notes }),
  authorUser: one({ sourceField: ["authorUserID"], destField: ["id"], destSchema: users }),
  authorAgent: one({ sourceField: ["authorAgentID"], destField: ["id"], destSchema: agentSessions }),
}));
const markupRels = relationships(markupStrokes, ({ one }) => ({
  document: one({ sourceField: ["documentID"], destField: ["id"], destSchema: documents }),
}));
const presenceRels = relationships(presence, ({ one }) => ({
  document: one({ sourceField: ["documentID"], destField: ["id"], destSchema: documents }),
  user: one({ sourceField: ["userID"], destField: ["id"], destSchema: users }),
  agentSession: one({ sourceField: ["agentSessionID"], destField: ["id"], destSchema: agentSessions }),
}));
const agentSessionRels = relationships(agentSessions, ({ one }) => ({
  user: one({ sourceField: ["userID"], destField: ["id"], destSchema: users }),
  document: one({ sourceField: ["documentID"], destField: ["id"], destSchema: documents }),
}));

export const schema = createSchema({
  tables: [
    users,
    documents,
    documentMembers,
    agentSessions,
    scripts,
    versions,
    configurations,
    paramOverrides,
    notes,
    noteMessages,
    markupStrokes,
    presence,
  ],
  relationships: [
    documentRels,
    memberRels,
    scriptRels,
    versionRels,
    configurationRels,
    paramOverrideRels,
    noteRels,
    noteMessageRels,
    markupRels,
    presenceRels,
    agentSessionRels,
  ],
});

export type Schema = typeof schema;

/** Query builder bound to this schema. Use with `tx.run(zql.scripts.where(...))`, `zero.run`, etc. */
export const zql = createBuilder(schema);

export type User = Row<Schema["tables"]["users"]>;
export type Document = Row<Schema["tables"]["documents"]>;
export type DocumentMember = Row<Schema["tables"]["documentMembers"]>;
export type AgentSession = Row<Schema["tables"]["agentSessions"]>;
export type Script = Row<Schema["tables"]["scripts"]>;
export type Version = Row<Schema["tables"]["versions"]>;
export type Configuration = Row<Schema["tables"]["configurations"]>;
export type ParamOverride = Row<Schema["tables"]["paramOverrides"]>;
export type Note = Row<Schema["tables"]["notes"]>;
export type NoteMessage = Row<Schema["tables"]["noteMessages"]>;
export type MarkupStroke = Row<Schema["tables"]["markupStrokes"]>;
export type Presence = Row<Schema["tables"]["presence"]>;

/**
 * Register our schema and context as Zero's defaults so `defineMutator`,
 * `defineQuery`, `new Zero(...)` and `zero.mutate` are typed without threading
 * generics everywhere. Context is `undefined` for logged-out clients.
 */
declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: Schema;
    context: MutatorContext | undefined;
  }
}
