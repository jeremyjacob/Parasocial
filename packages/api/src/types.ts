// Shared result/problem types: the same shapes go to the UI (§8 Errors), MCP write results
// and list_problems (§7).
import type { EntityKind, Vec3 } from "@parasocial/kernel";

export type Severity = "error" | "warning";
export type ProblemKind = "syntax" | "runtime" | "operation" | "invalid" | "timeout" | "unresolved" | "param" | "slow";

export type SourceRef = { file: string; line: number; col?: number };

export type Problem = {
  severity: Severity;
  kind: ProblemKind;
  /** Says what to do next and ends with the source location, e.g. `(bracket.ts:18)`. */
  message: string;
  part?: string;
  source?: SourceRef;
  /** Helper call chain, outermost first. */
  chain?: SourceRef[];
  op?: { id: string; type: string; tag?: string };
  /** Entities to highlight in red (e.g. the edges a fillet couldn't handle), by stable name. */
  highlight?: { kind: EntityKind; names: string[] };
};

export type ParamDecl = {
  name: string;
  part: string;
  default: number | string;
  /** Effective value in base units (mm / deg) or the chosen option. */
  value: number | string;
  unit?: string; // symbol
  min?: number;
  max?: number;
  step?: number;
  options?: (number | string)[];
  label?: string;
  description?: string;
  source?: SourceRef;
  overridden: boolean;
  /** The override expression as typed, if any. */
  expression?: string;
  /** Set when an override was rejected (out of bounds, bad expression). */
  error?: string;
};

export type ColorSpec = { kind: "auto" } | { kind: "rgb"; hex: string };
export type Material = { name?: string; density?: number /* g/cm³ */ };

export type EntityRef = { part: string; kind: EntityKind; name: string };

export type Vec = Vec3;
