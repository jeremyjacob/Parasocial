// Draw a part of an example to SVG/PDF (and a BOM), for eyeballing the output:
// bun packages/runtime/scripts/drawing-demo.ts <example> <part> <outdir> [sectionsJSON] [optionsJSON]
import { loadKernel } from "@parasocial/kernel";
import { Engine, drawPart, computeBom, bomToMarkdown } from "../src";
import { Glob } from "bun";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const [example = "bracket", part = "bracket", out = "drawing-out", sections = "[]", extra = "{}"] = process.argv.slice(2);
await loadKernel();
const root = join(import.meta.dir, "../../../examples", example);
const scripts: Record<string, string> = {};
for (const f of new Glob("{studios,lib}/**/*.ts").scanSync(root)) scripts[f] = readFileSync(join(root, f), "utf8");
const e = new Engine();
e.setDocument({ scripts });
mkdirSync(out, { recursive: true });
const opts = { sections: JSON.parse(sections), document: example, version: "v1", ...JSON.parse(extra) };
const t0 = performance.now();
const svg = drawPart(e, part, opts);
console.log(`svg in ${(performance.now() - t0).toFixed(0)} ms`, svg.sheet, svg.scaleLabel, svg.views, svg.warnings);
writeFileSync(join(out, `${part.replace(/[:/@]/g, "_")}.svg`), svg.svg!);
const pdf = drawPart(e, part, { ...opts, format: "pdf" });
writeFileSync(join(out, `${part.replace(/[:/@]/g, "_")}.pdf`), pdf.pdf!);
writeFileSync(join(out, "bom.md"), bomToMarkdown(computeBom(e, { documentName: example })));
