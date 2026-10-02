// Compare benchmark medians and verify that the saved responses still agree.
// bun packages/mcp/bench/compare.ts <baseline.json> <optimized.json> <report.json>
import sharp from "sharp";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";

const [beforeFile, afterFile, reportFile] = process.argv.slice(2);
if (!beforeFile || !afterFile || !reportFile) throw new Error("Expected baseline.json, optimized.json, report.json");
const before = await Bun.file(beforeFile).json(), after = await Bun.file(afterFile).json();
const responses = (file: string) => file.replace(/\.json$/, "") + "-responses";
async function payload(file: string, label: string) {
  const response = await Bun.file(join(responses(file), `${label}.json`)).json();
  return JSON.parse(response.content.find((c: any) => c.type === "text").text);
}
const verification: Record<string, boolean> = {};
for (const label of ["describe_model.cold", "describe_model", "describe_model.part", "get_params", "query", "measure", "list_problems", "bom", "check"]) {
  verification[label] = isDeepStrictEqual(await payload(beforeFile, label), await payload(afterFile, label));
}
for (const label of ["render.full", "render.part", "render.changed_view"]) {
  const a = await sharp(join(responses(beforeFile), `${label}.png`)).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(join(responses(afterFile), `${label}.png`)).raw().toBuffer({ resolveWithObject: true });
  verification[`${label}.pixels`] = isDeepStrictEqual(a.info, b.info) && a.data.equals(b.data);
}
for (const label of ["drawing", "export"]) {
  const a = await payload(beforeFile, label), b = await payload(afterFile, label);
  // Downloads are content addressed. Document ids and signatures differ each run.
  a.url = new URL(a.url).pathname;
  b.url = new URL(b.url).pathname;
  verification[`${label}.contentHash`] = isDeepStrictEqual(a, b);
}
for (const file of [beforeFile, afterFile]) {
  const notes = (await payload(file, "list_notes.100")).notes;
  verification[file === beforeFile ? "baseline.notes" : "optimized.notes"] = notes.length === 100 && notes.every((n: any, i: number) => n.number === i + 1 && n.messages.length === 1 && n.messages[0].text === `Benchmark thread ${i}`);
}
const measurements = Object.fromEntries(Object.entries(after.measurements).map(([label, a]: [string, any]) => {
  const b = before.measurements[label];
  return [label, { baselineMs: b?.ms, optimizedMs: a.ms, baselineMedianMs: b?.medianMs, optimizedMedianMs: a.medianMs, speedup: b?.medianMs && a.medianMs ? b.medianMs / a.medianMs : undefined, baselineError: b?.error, optimizedError: a.error }];
}));
await Bun.write(reportFile, JSON.stringify({ project: after.project, samples: after.samples, measurements, verification }, null, 2));
console.log(JSON.stringify({ verification, errors: Object.entries(measurements).filter(([, m]) => m.baselineError || m.optimizedError) }, null, 2));
if (Object.values(verification).some((ok) => !ok) || Object.values(measurements).some((m) => m.optimizedError)) process.exitCode = 1;
