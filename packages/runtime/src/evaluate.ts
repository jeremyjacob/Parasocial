// `evaluate` (an agent reading computed values off a script): an expression runs appended to a
// script module, so it sees the module's exports, its private top-level bindings and its imports
// (the modeling API included). It runs inside a part context, so params and modeling ops work.
// The result comes back JSON-friendly: rounded numbers, capped depth/size, geometry summarized.
import { Solid, Sketch, Plane, Path3d, EntitySet } from "@parasocial/api";
import { PartContext, withContext, parseStack, OpError } from "@parasocial/api/internal";
import { loadModule, mapScriptFrame, ScriptError, type Scripts } from "./loader";

export type EvaluateResult = { value: unknown; params?: Record<string, number | string>; warnings?: string[] };

const KEY = "__parasocialEvaluate__";

/** Evaluate `expr` in `script`'s module scope, within `ctx` (params read its overrides). Throws an Error whose message carries the location. */
export function evaluateExpression(o: { scripts: Scripts; api: Record<string, unknown>; seed: number; script: string; expr: string; ctx: PartContext }): EvaluateResult {
  const src = o.scripts.get(o.script);
  if (src === undefined) throw new Error(`no script at ${o.script}. Scripts: ${[...o.scripts.keys()].join(", ") || "none"}`);
  const base = src.split("\n").length + 1; // the expression starts on the line after this one
  const expr = o.expr.trim().replace(/;+$/, "");
  const scripts = new Map(o.scripts).set(o.script, `${src}\n;export const ${KEY} = (\n${expr}\n);`);
  const short = o.script.split("/").pop()!;
  const loc = (file: string, line?: number) => (file === o.script && line && line > base ? `expr:${line - base}` : line ? `${file.split("/").pop()}:${line}` : file.split("/").pop());
  // OpError messages carry `winch.ts:<line>`: lines past the script are the expression's
  const fix = (m: string) => m.replace(new RegExp(`\\b${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`, "g"), (s, n) => (+n > base ? `expr:${+n - base}` : s));
  try {
    return withContext(o.ctx, () => {
      const value = summarize(loadModule(o.script, { scripts, api: o.api, seed: o.seed })[KEY]);
      const params = Object.fromEntries(o.ctx.params.map((p) => [p.name, typeof p.value === "number" ? num(p.value) : p.value]));
      const warnings = o.ctx.problems.map((p) => fix(p.message));
      return { value, ...(o.ctx.params.length ? { params } : {}), ...(warnings.length ? { warnings } : {}) };
    });
  } catch (e) {
    if (e instanceof ScriptError) throw new Error(`${e.kind === "syntax" ? "syntax error: " : ""}${e.message} (${loc(e.file, e.line)})`);
    if (e instanceof OpError) throw new Error(fix(e.message));
    const err = e instanceof Error ? e : new Error(String(e));
    let at: string | undefined;
    for (const f of parseStack(err.stack ?? "")) {
      const m = mapScriptFrame(f);
      if (m && /^(studios|lib)\//.test(m.file)) {
        at = loc(m.file, m.line);
        break;
      }
    }
    throw new Error(`${err.name && err.name !== "Error" ? err.name + ": " : ""}${err.message}${at ? ` (${at})` : ""}`);
  }
}

/** 4 decimals, or 6 significant digits for small values; integers as they are. */
export function num(x: number): number | string {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return x === 0 ? 0 : x;
  const mag = Math.floor(Math.log10(Math.abs(x)));
  return +x.toPrecision(Math.min(17, Math.max(6, mag + 5))) || 0;
}

const MAX_DEPTH = 6, MAX_KEYS = 50, MAX_ITEMS = 100, MAX_NODES = 2000;

/** A value as JSON: numbers rounded, geometry summarized, functions named, cycles and size capped. */
export function summarize(v: unknown): unknown {
  let nodes = 0;
  const path = new Set<object>();
  const vec = (p: readonly number[]) => p.map(num);
  const walk = (v: unknown, depth: number): unknown => {
    if (v === undefined) return "[undefined]";
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number") return num(v);
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "symbol") return String(v);
    if (typeof v === "function") return /^class\b/.test(Function.prototype.toString.call(v)) ? `[class ${v.name || "anonymous"}]` : `[function ${v.name || "anonymous"}]`;
    const o = v as any;
    if (++nodes > MAX_NODES) return "[truncated]";
    if (path.has(o)) return "[circular]";
    if (o instanceof Solid) {
      try {
        const b = o.boundingBox();
        return { type: "Solid", bbox: { min: vec(b.min), max: vec(b.max), size: vec(b.size) } };
      } catch {
        return { type: "Solid" };
      }
    }
    if (o instanceof Sketch) return { type: "Sketch", ...(o.tag ? { tag: o.tag } : {}), plane: { origin: vec(o.plane.origin), normal: vec(o.plane.normal) } };
    if (o instanceof Plane) return { type: "Plane", origin: vec(o.origin), normal: vec(o.normal), xDir: vec(o.xDir) };
    if (o instanceof EntitySet) return { type: "EntitySet", kind: o.kind, count: o.indices.length, ...(o.query ? { query: o.query } : {}) };
    if (o instanceof Path3d) return { type: "Path3d", ...(o.tag ? { tag: o.tag } : {}) };
    if (o.__part === true) return { type: "Part", name: o.name };
    if (o.__assembly === true) return { type: "Assembly", name: o.name };
    if (o instanceof Date) return Number.isNaN(o.getTime()) ? "Invalid Date" : o.toISOString();
    if (o instanceof Error) return { type: o.name || "Error", message: o.message };
    if (typeof o.then === "function") return "[Promise]";
    const list: ArrayLike<unknown> | null = Array.isArray(o) || (ArrayBuffer.isView(o) && "length" in o) ? (v as ArrayLike<unknown>) : null;
    if (depth >= MAX_DEPTH) return list ? `[Array(${list.length})]` : "[Object]";
    path.add(o);
    try {
      if (list) {
        const xs = Array.from(list).slice(0, MAX_ITEMS).map((x) => walk(x, depth + 1));
        return list.length > MAX_ITEMS ? [...xs, `+${list.length - MAX_ITEMS} more`] : xs;
      }
      if (o instanceof Map) {
        const es = [...o].slice(0, MAX_ITEMS).map(([k, x]) => [walk(k, depth + 1), walk(x, depth + 1)]);
        return { type: "Map", size: o.size, entries: es };
      }
      if (o instanceof Set) return { type: "Set", size: o.size, values: [...o].slice(0, MAX_ITEMS).map((x) => walk(x, depth + 1)) };
      const proto = Object.getPrototypeOf(o);
      const out: Record<string, unknown> = proto && proto !== Object.prototype && proto.constructor?.name ? { type: proto.constructor.name } : {};
      const keys = Object.keys(o);
      for (const k of keys.slice(0, MAX_KEYS)) {
        let x: unknown;
        try {
          x = o[k];
        } catch (e) {
          x = `[throws: ${(e as Error)?.message ?? e}]`;
        }
        if (x !== undefined) out[k] = walk(x, depth + 1);
      }
      if (keys.length > MAX_KEYS) out["…"] = `+${keys.length - MAX_KEYS} more keys`;
      return out;
    } finally {
      path.delete(o);
    }
  };
  return walk(v, 0);
}
