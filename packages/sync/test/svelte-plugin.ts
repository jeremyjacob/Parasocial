/**
 * Lets `bun test` import `*.svelte.ts` rune modules: strip TypeScript with
 * Bun's transpiler, then compile with svelte/compiler's `compileModule` for
 * the client runtime. Imported by the adapter test before it imports the
 * adapter.
 */
import { plugin } from "bun";

plugin({
  name: "svelte-runes-for-tests",
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const { compileModule } = await import("svelte/compiler");
      const js = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text());
      const out = compileModule(js, { filename: path, generate: "client", dev: false });
      return { contents: out.js.code, loader: "js" };
    });
  },
});
