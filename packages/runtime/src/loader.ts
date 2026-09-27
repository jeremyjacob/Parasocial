// Script loading inside the engine (PLAN §5 Sandboxing, "script hygiene"):
// - transpile TS with Sucrase (line-preserving, so stack lines map 1:1 to the source)
// - resolve only `parasocial` and relative imports within the document (studios/, lib/)
// - evaluate each module in a `new Function` wrapper that shadows ambient globals
// - seeded Math.random and a frozen Date per regeneration (determinism)
// - a fresh module cache per regeneration
// The cross-origin engine iframe is the security boundary; this is correctness, not security.
import { transform } from "sucrase";

export type Scripts = ReadonlyMap<string, string>; // path (studios/x.ts, lib/y.ts) -> source

export class ScriptError extends Error {
  constructor(
    message: string,
    public file: string,
    public line?: number,
    public col?: number,
    public kind: "syntax" | "runtime" = "syntax",
  ) {
    super(message);
  }
}

const transpiled = new Map<string, string>(); // `${path}\0${source}` -> js

export function transpile(path: string, source: string): string {
  const key = `${path}\0${source}`;
  const hit = transpiled.get(key);
  if (hit) return hit;
  let code: string;
  try {
    code = sucrase(source);
  } catch (e: any) {
    const at = refineSyntaxError(source, e);
    throw new ScriptError(at.message, path, at.line, at.col, "syntax");
  }
  // Sloppy mode on purpose: strict-mode proper tail calls (JSC) would drop helper frames from
  // stacks, which provenance and auto op ids rely on (and V8 never does PTC).
  code = code.replace(/^"use strict";/, "");
  if (transpiled.size > 500) transpiled.clear();
  transpiled.set(key, code);
  return code;
}

function sucrase(src: string) {
  return transform(src, { transforms: ["typescript", "imports"], disableESTransforms: true, production: true }).code;
}

type ErrAt = { message: string; line?: number; col?: number };

function errAt(e: any): ErrAt {
  const msg = String(e?.message ?? "syntax error");
  const m = /\((\d+):(\d+)\)\s*$/.exec(msg);
  return { message: msg.replace(/^Error transforming [^:]*: /, "").replace(/\s*\(\d+:\d+\)\s*$/, ""), line: m ? +m[1] : undefined, col: m ? +m[2] + 1 : undefined };
}

/**
 * Sucrase backtracks out of arrow functions and reports body errors at the arrow itself.
 * Re-parse the block that follows the reported position on its own to find the real location.
 */
function refineSyntaxError(src: string, e: any, depth = 0): ErrAt {
  const at = errAt(e);
  if (!at.line || depth > 8) return at;
  const lines = src.split("\n");
  const offset = lines.slice(0, at.line - 1).reduce((n, l) => n + l.length + 1, 0) + (at.col ?? 1) - 1;
  const open = src.indexOf("{", offset);
  if (open < 0 || src.slice(offset, open).includes("\n")) return at;
  const close = matchBrace(src, open);
  if (close < 0) return at;
  // keep line numbers: blank out everything outside the block
  const inner = src.slice(open + 1, close);
  const prefix = src.slice(0, open + 1).replace(/[^\n]/g, " ");
  const probe = prefix.slice(0, -1) + "{" + inner + "}";
  const wrapped = "(function(){" + probe.slice(12) + "})";
  if (probe.length < 12) return at;
  try {
    sucrase(wrapped);
    return at;
  } catch (e2) {
    const inner2 = errAt(e2);
    if (!inner2.line || (inner2.line === at.line && inner2.col === at.col)) return at;
    return refineSyntaxError(src, e2, depth + 1);
  }
}

/** Index of the brace matching `src[open]`, skipping strings, templates and comments. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) + 1 || src.length;
    else if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Globals shadowed as `undefined` inside scripts. */
const SHADOWED = [
  "self",
  "globalThis",
  "window",
  "global",
  "fetch",
  "importScripts",
  "Worker",
  "SharedWorker",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "requestAnimationFrame",
  "postMessage",
  "close",
  "indexedDB",
  "caches",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
  "BroadcastChannel",
  "MessageChannel",
  "process",
  "Bun",
  "Deno",
  "require",
];

const WRAPPER_PARAMS = ["module", "exports", "require", "Math", "Date", ...SHADOWED.filter((n) => n !== "require")];

/** mulberry32: small, fast, deterministic. */
export function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXED_TIME = Date.UTC(2024, 0, 1);

function sandboxMath(seed: number): Math {
  const m = Object.create(null);
  for (const k of Object.getOwnPropertyNames(Math)) m[k] = (Math as any)[k];
  m.random = seededRandom(seed);
  return Object.freeze(m);
}

function sandboxDate(): DateConstructor {
  const RealDate = Date;
  function FakeDate(this: any, ...args: any[]) {
    if (!new.target) return new RealDate(FIXED_TIME).toString();
    return args.length ? new (RealDate as any)(...args) : new RealDate(FIXED_TIME);
  }
  FakeDate.now = () => FIXED_TIME;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;
  return Object.freeze(FakeDate) as any;
}

/** Line offset V8/JSC add for the `new Function` header; measured once. */
let headerLines: number | null = null;
function measureHeader(): number {
  if (headerLines !== null) return headerLines;
  try {
    new Function(...WRAPPER_PARAMS, "throw new Error('probe')\n//# sourceURL=__probe__.js")();
  } catch (e: any) {
    const m = /__probe__\.js:(\d+)/.exec(e.stack ?? "");
    headerLines = m ? +m[1] - 1 : 2;
  }
  return headerLines!;
}

export type LoadOptions = {
  scripts: Scripts;
  /** The frozen `parasocial` module object. */
  api: Record<string, unknown>;
  /** Seed for Math.random (per regeneration). */
  seed?: number;
  /** Module cache to share across several entries (default: fresh per call). */
  cache?: Map<string, { exports: any }>;
  /** Called when a module finishes evaluating (dependencies finish before their importers). */
  onLoaded?: (path: string, exports: Record<string, any>) => void;
  /**
   * Collects every script path the load reads or looks for (including missing ones, and imports
   * made later, while the part builds): what a change must touch to affect the result.
   */
  touched?: Set<string>;
};

/** Where frames from evaluated modules point, for mapping stack traces back to scripts. */
export const SOURCE_PREFIX = "ps:///";

/** Map a raw stack frame file/line from an evaluated module back to its script path. */
export function mapScriptFrame(f: { file: string; line: number; col: number; fn?: string }) {
  if (!f.file.startsWith(SOURCE_PREFIX)) return null;
  return { ...f, file: f.file.slice(SOURCE_PREFIX.length), line: f.line - measureHeader() };
}

/** Load `entry` and its relative imports; returns its exports. Fresh module cache each call. */
export function loadModule(entry: string, o: LoadOptions): Record<string, any> {
  measureHeader();
  const cache = o.cache ?? new Map<string, { exports: any }>();
  const math = sandboxMath(o.seed ?? 1);
  const date = sandboxDate();
  const api = o.api;

  const resolve = (from: string, spec: string): string => {
    if (spec === "parasocial") return spec;
    if (!spec.startsWith(".")) throw new ScriptError(`import "${spec}" is not allowed: only "parasocial" and relative imports within the document (e.g. "../lib/gears")`, from, undefined, undefined, "runtime");
    const parts = from.split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") {
        if (!parts.length) throw new ScriptError(`import "${spec}" escapes the document`, from, undefined, undefined, "runtime");
        parts.pop();
      } else parts.push(seg);
    }
    let p = parts.join("/");
    for (const cand of [p, `${p}.ts`, `${p}/index.ts`]) {
      o.touched?.add(cand);
      if (o.scripts.has(cand)) return cand;
    }
    throw new ScriptError(`cannot find "${spec}" (looked for ${p}.ts)`, from, undefined, undefined, "runtime");
  };

  const load = (path: string): any => {
    if (path === "parasocial") return api;
    o.touched?.add(path);
    const hit = cache.get(path);
    if (hit) return hit.exports;
    if (!/^(studios|lib)\//.test(path)) throw new ScriptError(`scripts must live under studios/ or lib/ (got ${path})`, path);
    const src = o.scripts.get(path);
    if (src === undefined) throw new ScriptError(`no script at ${path}`, path);
    const code = transpile(path, src);
    const module = { exports: {} as any };
    cache.set(path, module);
    let fn: Function;
    try {
      fn = new Function(...WRAPPER_PARAMS, `${code}\n//# sourceURL=${SOURCE_PREFIX}${path}`);
    } catch (e: any) {
      throw new ScriptError(e.message, path, undefined, undefined, "syntax");
    }
    const req = (spec: string) => load(resolve(path, spec));
    fn(module, module.exports, req, math, date, ...SHADOWED.filter((n) => n !== "require").map(() => undefined));
    o.onLoaded?.(path, module.exports);
    return module.exports;
  };
  return load(entry);
}
