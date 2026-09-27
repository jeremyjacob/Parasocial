/** Shared domain types for the sync layer (no runtime deps). */

export type Vec3 = [number, number, number];
export type BlobHash = string; // sha256 hex

export type Role = "owner" | "editor" | "viewer";
export type NoteStatus = "Open" | "AgentWorking" | "Resolved";
export type AgentStatus = "idle" | "working" | "writing" | "disconnected";
export type VersionKind = "script" | "params" | "restore" | "import";

export type Plane = { origin: Vec3; normal: Vec3; xDir?: Vec3 };

export type Stroke = {
  id?: string;
  part: string;
  points: Vec3[];
  color: string;
  width?: number;
};

/** PLAN §6 anchor model. `markup` is stored in markup_strokes rows, not inline. */
export type NoteAnchor = {
  targets: Array<{
    kind: "face" | "edge" | "vertex" | "part" | "point";
    name: string;
    query?: string;
    part?: string;
    point: Vec3;
    normal?: Vec3;
  }>;
  camera: { position: Vec3; target: Vec3; up: Vec3; fov: number; ortho: boolean };
  version: string;
  configuration: string;
  sectionPlane?: Plane;
  markup?: Stroke[];
  snapshot: BlobHash;
};

export type SelectionEntry = {
  kind: "face" | "edge" | "vertex" | "part";
  name: string;
  part?: string;
};

export type ParamValue = number | string | boolean;

export type SnapshotOverride = { part: string; name: string; expression: string; value: ParamValue };
export type SnapshotConfiguration = { id: string; name: string; overrides: SnapshotOverride[] };

/** What a version captures: every script (by content hash) plus the param state. */
export type VersionSnapshot = {
  scripts: Record<string, string>; // path -> sha256
  params: { configurations: SnapshotConfiguration[] };
};

/**
 * Coalescing state for params versions: key -> first "from" and latest "to".
 * `kind: "param"` renders as "thickness 3 → 4"; `kind: "config"` as
 * "+M3" (created), "−M3" (deleted) or "M3 → M4" (renamed).
 */
export type ChangeEntry = { kind: "param" | "config"; label: string; from: string; to: string };
export type VersionChanges = { params: Record<string, ChangeEntry> };

/** Parties a mutation runs as. `agentSessionID` is only ever set server-side (MCP). */
export type MutatorContext = {
  userID: string;
  agentSessionID?: string | null;
};
