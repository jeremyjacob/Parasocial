// Example documents (examples/), offered on the empty documents list and imported with the
// document.import mutator. Read-only files; no user data.
import { json } from "@sveltejs/kit";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readDocumentDir } from "@parasocial/sync/server";

const DIR = process.env.EXAMPLES_DIR ?? resolve(process.cwd(), existsSync(resolve(process.cwd(), "examples")) ? "examples" : "../../examples");
const ORDER = ["bracket", "flange", "enclosure", "knob", "gasket"];
let cache: unknown[] | null = null;

export const GET = async ({ locals }) => {
  if (!locals.user) return json({ message: "Not signed in" }, { status: 401 });
  if (!cache) {
    const names = (await readdir(DIR, { withFileTypes: true })).filter((d) => d.isDirectory() && existsSync(join(DIR, d.name, "parasocial.json"))).map((d) => d.name);
    names.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
    cache = await Promise.all(
      names.map(async (slug) => {
        const p = await readDocumentDir(join(DIR, slug));
        return { slug, name: p.manifest.name, units: p.manifest.units, configurations: p.manifest.configurations, scripts: p.scripts };
      }),
    );
  }
  return json(cache);
};
