// Serves the M0 spike on two origins: app (:5180, cross-origin isolated) and engine (:5181).
import { serveEngine } from "@parasocial/runtime/server/serve";
import { Glob } from "bun";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";

const here = import.meta.dir;
const examples = join(here, "../../../examples");
const scripts: Record<string, Record<string, string>> = {};
for (const d of new Glob("*/parasocial.json").scanSync(examples)) {
  const name = dirname(d);
  scripts[name] = {};
  for (const f of new Glob("{studios,lib}/**/*.ts").scanSync(join(examples, name))) scripts[name][f] = readFileSync(join(examples, name, f), "utf8");
}
const build = await Bun.build({ entrypoints: [join(here, "main.ts")], target: "browser", format: "esm", minify: false });
if (!build.success) throw new AggregateError(build.logs);
const mainJs = await build.outputs[0].text();
const artBuild = await Bun.build({ entrypoints: [join(here, "art.ts")], target: "browser", format: "esm" });
if (!artBuild.success) throw new AggregateError(artBuild.logs);
const artJs = await artBuild.outputs[0].text();

const engine = await serveEngine({ port: 5181, allowedParents: ["http://localhost:5180"] });
const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin" };
const app = Bun.serve({
  port: 5180,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/art.js") return new Response(artJs, { headers: { "Content-Type": "text/javascript", ...iso } });
    if (u.pathname === "/art.html") return new Response(`<!doctype html><html><head><meta charset="utf-8"><script src="/scripts.js"></script><script type="module" src="/art.js"></script></head><body></body></html>`, { headers: { "Content-Type": "text/html", ...iso } });
    if (u.pathname === "/main.js") return new Response(mainJs, { headers: { "Content-Type": "text/javascript", ...iso } });
    if (u.pathname === "/scripts.js") return new Response(`window.SCRIPTS=${JSON.stringify(scripts)}`, { headers: { "Content-Type": "text/javascript", ...iso } });
    return new Response(Bun.file(join(here, "index.html")), { headers: { "Content-Type": "text/html", ...iso } });
  },
});
console.log(`spike app http://localhost:${app.port}  engine http://localhost:${engine.port}`);
