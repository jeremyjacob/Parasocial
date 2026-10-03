// Pieces of a write's result: which scripts a change reaches (so only their parts regenerate),
// imports of files that don't exist, names that pack in details, and a short line diff for stale-version errors.
import { importsOf } from "./awareness";

/** An import target as the loader finds it (`x.ts`, else `x/index.ts`); the `.ts` path when neither exists. */
const resolveImport = (p: string, has: (p: string) => boolean) => (has(p) ? p : has(`${p.slice(0, -3)}/index.ts`) ? `${p.slice(0, -3)}/index.ts` : p);

/**
 * The scripts a change to `changed` can affect: those paths, and every script that imports one of
 * them, transitively (a missing import counts: creating it changes its importers). `missing`: the
 * affected scripts' imports of files that don't exist.
 */
export function affectedScripts(scripts: ReadonlyMap<string, string>, changed: readonly string[]) {
  const has = (p: string) => scripts.has(p);
  const imports = new Map([...scripts].map(([path, content]) => [path, importsOf(path, content).map((p) => resolveImport(p, has))]));
  const affected = new Set(changed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [path, deps] of imports) if (!affected.has(path) && deps.some((d) => affected.has(d))) affected.add(path), (grew = true);
  }
  const missing = new Map<string, string[]>();
  for (const path of affected) {
    const gone = imports.get(path)?.filter((d) => !has(d));
    if (gone?.length) missing.set(path, gone);
  }
  return { affected, missing };
}

/**
 * Line changes from `a` to `b` as unified-diff hunks without context (`@@ -12,2 +12,3 @@`, `-old`,
 * `+new`), at most `max` lines (long lines cut). Common head and tail are skipped; the rest is an
 * LCS diff, or one hunk when that would be large.
 */
export function lineDiff(a: string, b: string, max = 40): string {
  const x = a.split("\n"), y = b.split("\n");
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail), ys = y.slice(head, y.length - tail);
  // ops: [kind, line] with " " for a kept line
  let ops: [string, string][];
  const n = xs.length, m = ys.length;
  if (n * m > 250_000) ops = [...xs.map((l) => ["-", l] as [string, string]), ...ys.map((l) => ["+", l] as [string, string])];
  else {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = xs[i] === ys[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    ops = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xs[i] === ys[j]) ops.push([" ", xs[i++]!]), j++;
      else if (j < m && (i === n || L[i]![j + 1]! >= L[i + 1]![j]!)) ops.push(["+", ys[j++]!]);
      else ops.push(["-", xs[i++]!]);
    }
  }
  const out: string[] = [];
  let ai = head, bi = head, k = 0;
  while (k < ops.length) {
    if (ops[k]![0] === " ") (ai++, bi++, k++);
    else {
      const start = k;
      while (k < ops.length && ops[k]![0] !== " ") k++;
      const hunk = ops.slice(start, k);
      const del = hunk.filter((o) => o[0] === "-").length, add = hunk.length - del;
      out.push(`@@ -${ai + 1},${del} +${bi + 1},${add} @@`, ...hunk.filter((o) => o[0] === "-").concat(hunk.filter((o) => o[0] === "+")).map(([s, l]) => s + (l.length > 160 ? `${l.slice(0, 160)}…` : l)));
      ai += del;
      bi += add;
    }
  }
  return out.length > max ? [...out.slice(0, max), `… ${out.length - max} more diff lines (read_script)`].join("\n") : out.join("\n");
}

/** Past this, a name is a sentence: the Parts tree truncates it and it's hard to scan. */
const NAME_MAX = 32;
/** Separators that tack details onto a name: dashes, parentheses, colons. */
const PACKED = /[—–]|\s-\s|[(:]/;

/**
 * Hints for studio, part and assembly names in `files` that pack in details (a dash and a part
 * number, a material, a status) or run long; those belong in description, partNumber or material.
 */
export function nameHints(
  parts: readonly { file: string; name: string; studio: string }[],
  assemblies: readonly { file: string; name: string; studio: string }[],
  files: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const check = (name: string, what: string, file: string) => {
    const key = `${what}\u0000${file}\u0000${name}`;
    if (typeof name !== "string" || seen.has(key) || !(name.length > NAME_MAX || PACKED.test(name))) return;
    seen.add(key);
    const where = what === "studio" ? "export const description" : `${what}(name, body, { description, partNumber${what === "part" ? ", material" : ""} })`;
    out.push(`${file}: ${what} name "${name}" packs in details; keep names to 1–4 words and move the rest to ${where}`);
  };
  for (const x of [...parts, ...assemblies]) if (files.has(x.file)) check(x.studio, "studio", x.file);
  for (const p of parts) if (files.has(p.file)) check(p.name, "part", p.file);
  for (const a of assemblies) if (files.has(a.file)) check(a.name, "assembly", a.file);
  return out;
}
