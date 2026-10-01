// Executing an operation through the per-op cache, with provenance and friendly errors.
import { KernelError, scoped, noteKernelFault, faultMessage } from "@parasocial/kernel";
import { createRecord, hash, stableStringify, type OpRecord, type RecordInit } from "@parasocial/naming";
import { ctx, shortLoc, type Frame } from "./context";
import type { Problem } from "./types";
import type { EntityKind } from "@parasocial/kernel";

/** Bump when kernel/naming behavior changes so cached records can't leak across builds. */
export const ENGINE_VERSION = "ps-engine-1";

export class OpError extends Error {
  constructor(
    message: string,
    public problem: Problem,
  ) {
    super(message);
  }
}

export type OpSpec = {
  type: string;
  tag?: string;
  /** JSON-able parameters that fully determine the result (with the input keys). */
  params: Record<string, unknown>;
  inputs: OpRecord[];
  build: () => Omit<RecordInit, "id" | "type" | "tag" | "key" | "inputs" | "params" | "callSite" | "callChain">;
  /** Entities to highlight if the op fails. */
  highlight?: () => { kind: EntityKind; names: string[] } | undefined;
  /** Improve a kernel failure message (e.g. fillet radius vs. face width). */
  explain?: (e: KernelError) => string | undefined;
};

const toLoc = (f?: Frame) => (f ? { file: f.file, line: f.line, col: f.col, fn: f.fn } : undefined);

export function runOp(spec: OpSpec): OpRecord {
  const c = ctx();
  const frames = c.frames();
  const site = frames[0];
  if (spec.tag !== undefined) validateTag(spec.tag, site);
  // sketches have their own tag namespace, so `sketch(p, { tag: "rib" }).extrude(3, { tag: "rib" })` works
  const sketchy = spec.type === "sketch" || spec.type === "path";
  const id = spec.tag ? `${c.part}/${spec.tag}${sketchy ? ".sketch" : ""}` : c.autoId(spec.type, frames);
  if (spec.tag) {
    const key = sketchy ? `sketch:${spec.tag}` : spec.tag;
    if (c.tags.has(key)) fail(spec, `${sketchy ? "sketch " : ""}tag "${spec.tag}" is used twice in ${c.part}; tags must be unique within a part`, site, id);
    c.tags.set(key, toLoc(site));
  }
  const key = hash(stableStringify({ v: ENGINE_VERSION, type: spec.type, id, params: spec.params, inputs: spec.inputs.map((i) => i.key) }));
  let rec = c.cache.get(key);
  const callChain = frames
    .slice()
    .reverse()
    .map((f) => toLoc(f)!);
  if (!rec) {
    const t0 = performance.now();
    try {
      rec = scoped(() => createRecord({ ...spec.build(), id, type: spec.type, tag: spec.tag, key, inputs: spec.inputs, params: spec.params, callSite: toLoc(site), callChain }));
    } catch (e) {
      if (e instanceof OpError) throw e;
      // a trap/abort inside OCCT: this part fails here; the engine replaces the kernel afterwards
      if (noteKernelFault(e)) fail(spec, `${spec.type} crashed the geometry kernel (${faultMessage(e)}); check its inputs`, site, id);
      const base = e instanceof Error ? e.message : String(e);
      const better = e instanceof KernelError ? spec.explain?.(e) : undefined;
      fail(spec, better ?? base, site, id, e instanceof KernelError ? "operation" : "runtime");
    }
    c.opTime += performance.now() - t0;
    c.cache.put(rec!);
  } else {
    // same geometry, but the call may have moved in the source
    rec.callSite = toLoc(site);
    rec.callChain = callChain;
  }
  c.ops.push(rec!);
  return rec!;
}

function validateTag(tag: string, site?: Frame) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tag)) {
    const c = ctx();
    throw new OpError(`tag "${tag}" must start with a letter and contain only letters, digits, _ or - (${shortLoc(site)})`, {
      severity: "error",
      kind: "runtime",
      message: `tag "${tag}" is not a valid identifier (${shortLoc(site)})`,
      part: c.part,
      source: site && { file: site.file, line: site.line, col: site.col },
    });
  }
}

export function fail(spec: Pick<OpSpec, "type" | "tag" | "highlight">, message: string, site: Frame | undefined, id?: string, kind: Problem["kind"] = "operation"): never {
  const c = ctx();
  const loc = shortLoc(site);
  const text = loc ? `${message} (${loc})` : message;
  let highlight: Problem["highlight"];
  try {
    highlight = spec.highlight?.();
  } catch {}
  throw new OpError(text, {
    severity: "error",
    kind,
    message: text,
    part: c.part,
    source: site && { file: site.file, line: site.line, col: site.col },
    op: id ? { id, type: spec.type, tag: spec.tag } : undefined,
    highlight,
  });
}

/** Raise a user-facing error at the current call site (bad arguments etc.). */
export function userError(message: string): never {
  const c = ctx();
  const site = c.frames()[0];
  const loc = shortLoc(site);
  const text = loc ? `${message} (${loc})` : message;
  throw new OpError(text, { severity: "error", kind: "runtime", message: text, part: c.part, source: site && { file: site.file, line: site.line, col: site.col } });
}

export function warn(message: string, kind: Problem["kind"] = "unresolved") {
  const c = ctx();
  const site = c.frames()[0];
  const loc = shortLoc(site);
  const text = loc ? `${message} (${loc})` : message;
  if (!c.problems.some((p) => p.message === text)) c.problems.push({ severity: "warning", kind, message: text, part: c.part, source: site && { file: site.file, line: site.line, col: site.col } });
}
