// A stand-in for the Deno engine host (host.ts), speaking the same line protocol, that misbehaves
// on demand: regenerate "crash" exits, "hang" never answers, "noisy" prints to stdout first.
// A script containing CRASH_ON_LOAD exits while loading the document.
import { LINE_PREFIX } from "../src/pool";

const send = (m: unknown) => process.stdout.write(LINE_PREFIX + JSON.stringify(m) + "\n");
// OCCT-style chatter before anything else
process.stdout.write("******  Transfer Mode = 0  ******\n{not json either\n");
send({ ready: { build: "fake", pid: process.pid } });

let buf = "";
for await (const chunk of process.stdin) {
  buf += chunk.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    const req = m.req ?? {};
    if (req.op === "setDocument" || req.op === "setScript") {
      const scripts = req.op === "setDocument" ? Object.values(req.doc.scripts) : [req.content];
      if (scripts.some((s: any) => String(s).includes("CRASH_ON_LOAD"))) process.exit(4);
      send({ id: m.id, ok: true, value: [] });
    } else if (req.op === "regenerate" && req.part === "crash") process.exit(3);
    else if (req.op === "regenerate" && req.part === "hang") {
      /* never answers */
    } else if (req.op === "regenerate" && req.part === "noisy") {
      process.stdout.write("Step File Name : x.step Write Done\n");
      send({ id: m.id, ok: true, value: { part: "noisy", pid: process.pid } });
    } else send({ id: m.id, ok: true, value: { part: req.part, pid: process.pid } });
  }
}
