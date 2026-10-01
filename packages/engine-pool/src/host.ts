// Engine host (§3): one Deno process per active document. The pool server starts it with read
// access to the engine build and nothing else (no network, env, writes or subprocesses), so a
// script that escapes the loader's scope still can't reach anything. Runs the engine worker
// (same build as the browser) and renders with WebGPU. The server drives it over stdin/stdout,
// one JSON message per line: {id, req} or {id, render} in; {id, ...result} out, each prefixed with
// LINE_PREFIX (OCCT and Emscripten print to stdout too: the server treats anything else as log).
import "./config";
import "./engine";
import { renderPNG } from "./render";
import { LINE_PREFIX } from "./pool";

declare const Deno: any;
const g = globalThis as any;

const out = Deno.stdout.writable.getWriter();
const enc = new TextEncoder();
let writing: Promise<unknown> = Promise.resolve();
const send = (m: unknown) => (writing = writing.then(() => out.write(enc.encode(LINE_PREFIX + JSON.stringify(m) + "\n"))));

async function handle(m: { id: number; req?: unknown; render?: any }) {
  if (m.render) {
    try {
      send({ id: m.id, ok: true, value: { png: await renderPNG(g.poolMeshes, m.render) } });
    } catch (e: any) {
      send({ id: m.id, ok: false, error: String(e?.message ?? e) });
    }
  } else send({ id: m.id, ...(await g.rpc(m.req)) });
}

try {
  send({ ready: await g.poolReady });
} catch (e: any) {
  send({ fatal: String(e?.message ?? e) });
}

let buf = "";
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      console.error(`engine host: unreadable request ${line.slice(0, 200)}`);
      continue;
    }
    handle(m).catch((e) => send({ id: m.id, ok: false, error: String(e?.message ?? e) }));
  }
}
await writing;
Deno.exit(0);
