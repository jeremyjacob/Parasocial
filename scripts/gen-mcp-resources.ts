// Generates packages/mcp/src/resources.ts: the modeling API's .d.ts (from packages/api, with doc
// comments), an index of its declarations for the api_reference tool, and the example parts,
// served to agents as MCP resources (§5 Designed for agents).
//   bun scripts/gen-mcp-resources.ts          write resources.ts
//   bun scripts/gen-mcp-resources.ts --check  exit 1 if resources.ts is stale (used by tests)
import { $ } from "bun";
import { Glob } from "bun";
import { join } from "node:path";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import ts from "typescript";

const root = join(import.meta.dir, "..");
const check = process.argv.includes("--check");
const out = join(root, `.data/api-dts${check ? `-check-${process.pid}` : ""}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await $`bunx tsc ${join(root, "packages/api/src/index.ts")} --declaration --emitDeclarationOnly --stripInternal --outDir ${out} --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --strict --lib ES2022,DOM --types bun`.quiet().nothrow();

/** Section order of the d.ts; each file is an api_reference topic (index.ts's is the cheat sheet). */
const files = ["index", "part", "assembly", "connector", "sketch", "path3d", "solid", "selection", "plane", "units", "types", "std/index", "std/parts", "std/holes", "std/tables"];

/** `[start, end)` of a declaration (with its doc comment) in API_DTS. */
type Span = [number, number];
type Topic = { name: string; file: string; span: Span; doc?: Span; symbols: string[] };
/** `text`: a declaration documented here but not in the d.ts (span unused). */
type Decl = { topic: string; span: Span; text?: string; public: boolean; members?: string[]; parent?: string };

const MODULE_DOC = /\/\*\*(?:(?!\*\/)[\s\S])*?@module(?:(?!\*\/)[\s\S])*?\*\/\n?/;

let dts = `// The \`parasocial\` module studio scripts import. Generated from packages/api (doc comments included).\n`;
const topics: Topic[] = [];
const decls: Record<string, Decl> = {};
let publicNames = new Set<string>();

for (const f of files) {
  const p = [...new Glob(`**/${f}.d.ts`).scanSync(out)].sort((a, b) => a.length - b.length)[0];
  if (!p) continue;
  const body = readFileSync(join(out, p), "utf8").replace(MODULE_DOC, "").replace(/^import .*$/gm, "").replace(/^export \{\};$/gm, "").replace(/^\n+/, "");
  const src = readFileSync(join(root, "packages/api/src", `${f}.ts`), "utf8");
  const doc = MODULE_DOC.exec(src)?.[0].trimEnd();
  const start = dts.length;
  dts += `\n// ───── ${f}.ts ─────\n`;
  let docSpan: Span | undefined;
  if (doc) {
    docSpan = [dts.length, dts.length + doc.length];
    dts += `${doc}\n`;
  }
  const bodyAt = dts.length;
  dts += body;
  const topic: Topic = { name: f === "index" ? "cheatsheet" : f === "std/index" ? "std" : f, file: `${f}.ts`, span: [start + 1, dts.length], doc: docSpan, symbols: [] };
  topics.push(topic);
  const sf = ts.createSourceFile(`${f}.d.ts`, body, ts.ScriptTarget.ES2022, true);
  if (f === "index") publicNames = exportedNames(sf);
  else collect(sf, body, bodyAt, topic);
}

/** Names `index.ts` exports (values and types): the public API. */
function exportedNames(sf: ts.SourceFile) {
  const names = new Set<string>();
  for (const s of sf.statements) if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) names.add(e.name.text);
  return names;
}

/** Declaration text start: its doc comment, without the blank lines before it. */
function spanOf(text: string, offset: number, nodes: ts.Node[]): Span {
  let s = nodes[0].getFullStart();
  while (/\s/.test(text[s] ?? "")) s++;
  return [offset + s, offset + nodes[nodes.length - 1].getEnd()];
}

function memberName(m: ts.Node): string | undefined {
  const n = (m as any).name as ts.PropertyName | undefined;
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  return undefined;
}

function collect(sf: ts.SourceFile, text: string, offset: number, topic: Topic) {
  const add = (name: string, nodes: ts.Node[], parent?: string) => {
    const span = spanOf(text, offset, nodes);
    const prev = decls[name];
    // overloads: one span from the first signature to the last
    if (prev && prev.topic === topic.name) prev.span = [Math.min(prev.span[0], span[0]), Math.max(prev.span[1], span[1])];
    else if (!prev) {
      decls[name] = { topic: topic.name, span, public: !parent && publicNames.has(name), ...(parent ? { parent } : {}) };
      if (!parent) topic.symbols.push(name);
    }
    return decls[name];
  };
  /** Whether a type literal has methods (directly or in a nested literal): worth listing in the index. */
  const hasFns = (lit: ts.TypeLiteralNode | ts.InterfaceDeclaration): boolean =>
    lit.members.some((m) => ts.isMethodSignature(m) || (ts.isPropertySignature(m) && !!m.type && (ts.isFunctionTypeNode(m.type) || (ts.isTypeLiteralNode(m.type) && hasFns(m.type)))));
  const addMembers = (owner: string, members: readonly ts.Node[], listed = true) => {
    const names: string[] = [];
    for (const m of members) {
      if (ts.isConstructorDeclaration(m) || ts.isIndexSignatureDeclaration(m) || ts.isCallSignatureDeclaration(m)) continue;
      if (ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Private) continue;
      const n = memberName(m);
      if (!n || n.startsWith("#") || n.startsWith("_")) continue;
      add(`${owner}.${n}`, [m], owner);
      if (!names.includes(n)) names.push(n);
    }
    if (listed) decls[owner].members = names;
  };
  /** Members of `{ ... }` or `Readonly<{ ... }>`. */
  const literal = (t?: ts.TypeNode): ts.TypeLiteralNode | undefined => {
    if (!t) return undefined;
    if (ts.isTypeLiteralNode(t)) return t;
    if (ts.isTypeReferenceNode(t) && t.typeArguments?.length === 1) return literal(t.typeArguments[0]);
    return undefined;
  };
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) add(s.name.text, [s]);
    else if (ts.isClassDeclaration(s) && s.name) {
      add(s.name.text, [s]);
      addMembers(s.name.text, s.members);
    } else if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) {
      add(s.name.text, [s]);
      const lit = ts.isTypeAliasDeclaration(s) ? literal(s.type) : s;
      if (lit) addMembers(s.name.text, lit.members, hasFns(lit));
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        add(d.name.text, [s]);
        const lit = literal(d.type);
        if (lit) addMembers(d.name.text, lit.members, hasFns(lit));
      }
    } else if (ts.isEnumDeclaration(s)) add(s.name.text, [s]);
  }
}

// public names re-exported from outside packages/api (Vec3 comes from the kernel): documented here,
// not added to the d.ts (the editor declares them itself)
const externals: Record<string, string> = { Vec3: "/** A world point or direction `[x, y, z]` in mm. */\nexport type Vec3 = [number, number, number];" };
for (const [name, text] of Object.entries(externals)) {
  if (decls[name] || !publicNames.has(name)) continue;
  decls[name] = { topic: "types", span: [0, 0], text, public: true };
  topics.find((t) => t.name === "types")!.symbols.push(name);
}
const missing = [...publicNames].filter((n) => !decls[n]?.public);
if (missing.length) {
  console.error(`api d.ts: no declaration for public export(s) ${missing.join(", ")}`);
  process.exit(1);
}

let ex = "# Example parts\n\nReal scripts from Parasocial's example documents.\n";
for (const f of [...new Glob("*/{studios,lib}/*.ts").scanSync(join(root, "examples"))].sort()) ex += `\n## examples/${f}\n\n\`\`\`ts\n${readFileSync(join(root, "examples", f), "utf8").trim()}\n\`\`\`\n`;

const index = { topics, decls };
const file = `// Generated by scripts/gen-mcp-resources.ts — do not edit.
export const API_DTS = ${JSON.stringify(dts)};
/** Declarations in API_DTS by name (\`Solid.fillet\`), as [start, end) spans, grouped by topic (the d.ts sections). */
export const API_INDEX: {
  topics: { name: string; file: string; span: [number, number]; doc?: [number, number]; symbols: string[] }[];
  decls: Record<string, { topic: string; span: [number, number]; text?: string; public: boolean; members?: string[]; parent?: string }>;
} = ${JSON.stringify(index)};
export const EXAMPLES = ${JSON.stringify(ex)};
`;
const target = join(root, "packages/mcp/src/resources.ts");
if (check) {
  rmSync(out, { recursive: true, force: true });
  if (readFileSync(target, "utf8") !== file) {
    console.error("packages/mcp/src/resources.ts is stale: run `bun scripts/gen-mcp-resources.ts`");
    process.exit(1);
  }
  console.log("resources.ts is up to date");
} else {
  writeFileSync(target, file);
  console.log(`api d.ts ${dts.length} chars (${Object.keys(decls).length} declarations), examples ${ex.length} chars`);
}
