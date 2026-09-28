// Debug traces for developing Parasocial: every agent tool call (MCP sessions) and every built-in
// agent run, in full, as JSONL under AGENT_TRACE_DIR/<date>/. Off when AGENT_TRACE_DIR is unset
// (scripts/dev.ts sets it to .data/agent-traces). Images are replaced by their size.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MAX_STRING = 50_000;

export type Trace = (event: Record<string, unknown>) => void;
const off: Trace = () => {};

/** A JSONL trace file (`<dir>/<YYYY-MM-DD>/<name>.jsonl`), or a no-op when tracing is off. */
export function trace(name: string): Trace {
  const root = process.env.AGENT_TRACE_DIR;
  if (!root) return off;
  const dir = join(root, new Date().toISOString().slice(0, 10));
  const file = join(dir, `${name.replace(/[^\w.-]/g, "_")}.jsonl`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return off;
  }
  return (event) => {
    try {
      appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), ...(scrub(event) as object) })}\n`);
    } catch {
      // tracing never breaks a run
    }
  };
}

/** Large strings truncated, image and file payloads replaced by their size. */
export function scrub(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}… [${v.length} chars]` : v;
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `[${v.byteLength} bytes]`;
  if (v instanceof Error) return { error: v.name, message: v.message, stack: v.stack, cause: scrub((v as any).cause, depth + 1) };
  if (!v || typeof v !== "object" || depth > 12) return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    // MCP image content ({ type: "image", data }) and AI SDK file parts ({ data: { type: "data", data } })
    if (k === "data" && typeof x === "string" && (o.type === "image" || o.type === "data")) out[k] = `[image, ${x.length} base64 chars]`;
    else out[k] = scrub(x, depth + 1);
  }
  return out;
}
