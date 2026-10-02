// The per-part regeneration context: op cache, params, provenance, counters.
import { OpCache, type OpRecord } from "@parasocial/naming";
import type { ParamDecl, Problem } from "./types";
import { SI_DEFAULT, type DocUnits } from "./units";

export type Frame = { file: string; line: number; col: number; fn?: string };

export type ContextOptions = {
  /** Part id (studio file stem, plus `:export` for named parts), e.g. `bracket`. */
  part: string;
  /** Script path, e.g. `studios/bracket.ts`. */
  file: string;
  cache: OpCache;
  /** Param overrides for the active configuration: name -> expression or value. */
  overrides?: Record<string, string | number>;
  /** Overrides of shared params (`param(..., { shared: true })`), one set for the whole document. */
  sharedOverrides?: Record<string, string | number>;
  units?: DocUnits;
  /** Map a raw stack frame to source (sourceURL / source maps). Return null to drop it. */
  mapFrame?: (f: Frame) => Frame | null;
  /** Is this (mapped) file user code? Default: under studios/ or lib/. */
  isUserFile?: (file: string) => boolean;
  /** Param values from a previous pass, so overrides can refer to params declared later. */
  paramHints?: Record<string, number>;
};

export class PartContext {
  readonly part: string;
  readonly file: string;
  readonly cache: OpCache;
  readonly overrides: Record<string, string | number>;
  readonly sharedOverrides: Record<string, string | number>;
  readonly units: DocUnits;
  readonly params: ParamDecl[] = [];
  readonly ops: OpRecord[] = [];
  readonly problems: Problem[] = [];
  readonly counters = new Map<string, number>();
  /** Tag → the user frames (innermost first) of the op that took it, for "used twice" errors. */
  readonly tags = new Map<string, Frame[]>();
  /** Latest successful solid result: shown when a later op fails (§8 Errors). */
  lastSolid?: OpRecord;
  private mapFrame: (f: Frame) => Frame | null;
  private isUserFile: (file: string) => boolean;
  opTime = 0;
  readonly options: ContextOptions;

  constructor(o: ContextOptions) {
    this.options = o;
    this.part = o.part;
    this.file = o.file;
    this.cache = o.cache;
    this.overrides = o.overrides ?? {};
    this.sharedOverrides = o.sharedOverrides ?? {};
    this.units = o.units ?? SI_DEFAULT;
    this.mapFrame = o.mapFrame ?? ((f) => f);
    this.isUserFile = o.isUserFile ?? ((f) => /(^|\/)(studios|lib)\/[^/]+/.test(f));
  }

  /** User frames, innermost first. */
  frames(stack?: string): Frame[] {
    const raw = parseStack(stack ?? new Error().stack ?? "");
    const out: Frame[] = [];
    for (const f of raw) {
      const m = this.mapFrame(f);
      if (m && this.isUserFile(m.file)) out.push(m);
    }
    return out;
  }

  /** Auto op id: `part/[helper/]type<n>`, counted per scope so unrelated edits don't shift it. */
  autoId(type: string, frames: Frame[]): string {
    // scope = helper functions between the op call and the part body (outermost user frame)
    const helpers = frames
      .slice(0, -1)
      .map((f) => cleanFn(f.fn))
      .filter((n): n is string => !!n)
      .reverse();
    const scope = helpers.join("/");
    const key = `${scope}|${type}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return `${this.part}/${scope ? scope + "/" : ""}${type}${n}`;
  }
}

function cleanFn(fn?: string): string | undefined {
  if (!fn) return undefined;
  const n = fn.replace(/^(async |new )/, "").split(".").pop()!;
  if (!n || n === "anonymous" || n === "<anonymous>" || n.startsWith("<") || n === "eval" || n === "Function") return undefined;
  return n;
}

/** Parse V8 (`at fn (file:1:2)`) and JSC (`fn@file:1:2`) stack traces. */
export function parseStack(stack: string): Frame[] {
  const out: Frame[] = [];
  for (const line of stack.split("\n")) {
    let m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (m) {
      out.push({ fn: m[1], file: stripUrl(m[2]), line: +m[3], col: +m[4] });
      continue;
    }
    m = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/.exec(line);
    if (m) out.push({ fn: m[1] || undefined, file: stripUrl(m[2]), line: +m[3], col: +m[4] });
  }
  return out;
}

function stripUrl(f: string) {
  // recent V8 names `new Function` code by its sourceURL plus ", <anonymous>"
  return f.replace(/^file:\/\//, "").replace(/^async /, "").replace(/, <anonymous>$/, "");
}

let current: PartContext | null = null;

export function ctx(): PartContext {
  if (!current) throw new Error("modeling operations must run inside part(...): call them from the part's body or from a helper it calls");
  return current;
}

export function hasContext() {
  return current !== null;
}

export function withContext<T>(c: PartContext, fn: () => T): T {
  const prev = current;
  current = c;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

export function shortLoc(f?: { file: string; line: number }) {
  if (!f) return "";
  return `${f.file.split("/").pop()}:${f.line}`;
}

/** A call chain (frames innermost first) as the user reads it, outermost first: `winch.ts:300 via join() at x.ts:200`. */
export function chainLoc(frames: Frame[]): string {
  if (!frames.length) return "an unknown place";
  const [outer, ...inner] = frames.slice().reverse();
  return [shortLoc(outer), ...inner.map((f) => `via ${cleanFn(f.fn) ?? "a helper"}() at ${shortLoc(f)}`)].join(" ");
}
