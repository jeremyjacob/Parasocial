// Selector strings (PLAN §5 Selection):
//   name patterns      `base.side`, `bore`, `corners`, `base.cap.end`
//   CadQuery-style     `>Z` `<X` `>Z[1]` `|Z` `#Z` `+Z` `-Z` `%plane` `%circle` `*`
//   set operations     `a & b`, `a | b`, `a - b`, `not a`, parentheses; `and`/`or` also accepted
//   history            `@finUnion` or `createdBy(finUnion)`: entities that operation created (see created.ts)
// Pattern semantics: a face matches when its own name segment contains the pattern's tokens
// contiguously; an edge or vertex matches when it (or any face around it) does. So
// `base.cap.end & bore` on edges is the edge where the end cap meets the bore.
import type { EntityKind, Vec3 } from "@parasocial/kernel";
import { entityCount, type OpRecord } from "./record";
import { entityName, tokenize } from "./names";
import { centerOf, directionOf, dot, edgeOf, faceOf, norm } from "./info";
import { createdBy, resolveOps } from "./created";

export class SelectorError extends Error {}

type Node =
  | { t: "all" }
  | { t: "pattern"; tokens: string[]; raw: string }
  | { t: "minmax"; max: boolean; axis: Vec3; index: number }
  | { t: "parallel" | "perp" | "dir"; axis: Vec3 }
  | { t: "type"; name: string }
  | { t: "bin"; op: "&" | "|" | "-"; a: Node; b: Node }
  | { t: "not"; a: Node }
  | { t: "created"; op: string };

const AXES: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

export function parseSelector(src: string): Node {
  let i = 0;
  const s = src.trim();
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const err = (m: string): never => {
    throw new SelectorError(`selector "${src}": ${m} at column ${i + 1}`);
  };
  const axis = (): Vec3 => {
    ws();
    const c = s[i]?.toUpperCase();
    if (c && AXES[c]) {
      i++;
      return AXES[c];
    }
    if (s[i] === "(") {
      const end = s.indexOf(")", i);
      if (end < 0) err("unclosed vector");
      const v = s.slice(i + 1, end).split(",").map(Number);
      if (v.length !== 3 || v.some(isNaN)) err("expected (x, y, z)");
      i = end + 1;
      return norm(v as Vec3);
    }
    return err("expected an axis X, Y, Z or (x, y, z)");
  };
  const word = () => {
    const m = /^[A-Za-z0-9_*\-.\/:]+/.exec(s.slice(i));
    return m ? m[0] : "";
  };
  const term = (): Node => {
    ws();
    const c = s[i];
    if (c === undefined) return err("unexpected end");
    if (c === "(") {
      i++;
      const n = orExpr();
      ws();
      if (s[i] !== ")") err("expected )");
      i++;
      return n;
    }
    if (c === ">" || c === "<") {
      i++;
      const ax = axis();
      let index = 0;
      if (s[i] === "[") {
        const end = s.indexOf("]", i);
        index = Number(s.slice(i + 1, end));
        if (end < 0 || isNaN(index)) err("bad index");
        i = end + 1;
      }
      return { t: "minmax", max: c === ">", axis: ax, index };
    }
    if (c === "|") {
      i++;
      return { t: "parallel", axis: axis() };
    }
    if (c === "#") {
      i++;
      return { t: "perp", axis: axis() };
    }
    if ((c === "+" || c === "-") && /[XYZxyz(]/.test(s[i + 1] ?? "")) {
      i++;
      const a = axis();
      return { t: "dir", axis: c === "-" ? ([-a[0], -a[1], -a[2]] as Vec3) : a };
    }
    if (c === "%") {
      i++;
      const w = word();
      if (!w) err("expected a type after %");
      i += w.length;
      return { t: "type", name: w.toLowerCase() };
    }
    if (c === "*") {
      i++;
      return { t: "all" };
    }
    if (c === "@") {
      i++;
      const w = word();
      if (!w) err("expected an operation tag after @, e.g. @finUnion");
      i += w.length;
      return { t: "created", op: w };
    }
    const w = word();
    if (!w) err(`unexpected "${c}"`);
    if (w === "createdBy" && s[i + w.length] === "(") {
      const end = s.indexOf(")", i);
      if (end < 0) err("unclosed createdBy(");
      const op = s.slice(i + w.length + 1, end).trim().replace(/^["']|["']$/g, "");
      if (!op) err("createdBy() needs an operation tag, e.g. createdBy(finUnion)");
      i = end + 1;
      return { t: "created", op };
    }
    if (w === "not") {
      i += 3;
      return { t: "not", a: term() };
    }
    i += w.length;
    return { t: "pattern", tokens: tokenize(w), raw: w };
  };
  const peekOp = (ops: string[]): string | null => {
    ws();
    for (const o of ops) {
      if (o.length > 1) {
        if (s.startsWith(o, i) && /\s/.test(s[i + o.length] ?? " ")) return o;
      } else if (s[i] === o) return o;
    }
    return null;
  };
  const andExpr = (): Node => {
    let a = term();
    for (;;) {
      const o = peekOp(["&", "and"]);
      if (!o) return a;
      i += o.length;
      a = { t: "bin", op: "&", a, b: term() };
    }
  };
  const minusExpr = (): Node => {
    let a = andExpr();
    for (;;) {
      ws();
      // binary minus must be followed by whitespace, so `-Z` stays a direction selector
      if (s[i] === "-" && /\s/.test(s[i + 1] ?? "")) {
        i++;
        a = { t: "bin", op: "-", a, b: andExpr() };
      } else if (s.startsWith("exc ", i)) {
        i += 3;
        a = { t: "bin", op: "-", a, b: andExpr() };
      } else return a;
    }
  };
  const orExpr = (): Node => {
    let a = minusExpr();
    for (;;) {
      const o = peekOp(["|", "or"]);
      if (!o) return a;
      i += o.length;
      a = { t: "bin", op: "|", a, b: minusExpr() };
    }
  };
  const n = orExpr();
  ws();
  if (i < s.length) err(`unexpected "${s.slice(i)}"`);
  return n;
}

function containsSeq(hay: string[], needle: string[]) {
  if (!needle.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j].toLowerCase() !== needle[j].toLowerCase()) continue outer;
    return true;
  }
  return false;
}

const PAR = 1 - 1e-6;
const PERP = 1e-6;

/** Evaluate a selector against `r`'s entities of `kind`, optionally within `domain`. Returns sorted indices. */
export function select(r: OpRecord, kind: EntityKind, selector: string, domain?: number[]): number[] {
  const node = parseSelector(selector);
  // seam edges (a periodic face's parametrization boundary) are never what people mean
  const all = domain ?? [...Array(entityCount(r, kind)).keys()].filter((i) => kind !== "edge" || !isSeamEdge(r, i) || /seam/.test(selector));
  const res = evalNode(r, kind, node, all);
  return [...res].sort((a, b) => a - b);
}

function evalNode(r: OpRecord, kind: EntityKind, n: Node, domain: number[]): Set<number> {
  switch (n.t) {
    case "all":
      return new Set(domain);
    case "bin": {
      const a = evalNode(r, kind, n.a, domain);
      const b = evalNode(r, kind, n.b, domain);
      if (n.op === "&") return new Set([...a].filter((x) => b.has(x)));
      if (n.op === "|") return new Set([...a, ...b]);
      return new Set([...a].filter((x) => !b.has(x)));
    }
    case "not": {
      const a = evalNode(r, kind, n.a, domain);
      return new Set(domain.filter((x) => !a.has(x)));
    }
    case "pattern":
      return new Set(domain.filter((i) => matchesPattern(r, kind, i, n.tokens)));
    case "created":
      return new Set(createdBy(r, kind, resolveOps(r, n.op), domain));
    case "type":
      return new Set(
        domain.filter((i) => {
          if (kind === "face") return faceOf(r, i).surface === n.name;
          if (kind === "edge") return edgeOf(r, i).curve === n.name;
          return n.name === "vertex";
        }),
      );
    case "parallel":
    case "perp":
    case "dir":
      return new Set(
        domain.filter((i) => {
          const d = directionOf(r, kind, i);
          if (!d) return false;
          const c = dot(d, n.axis);
          if (n.t === "parallel") return Math.abs(c) > PAR;
          if (n.t === "perp") return Math.abs(c) < PERP;
          return kind === "face" && faceOf(r, i).surface === "plane" && c > PAR;
        }),
      );
    case "minmax": {
      const proj = domain.map((i) => ({ i, v: dot(centerOf(r, kind, i), n.axis) }));
      if (!proj.length) return new Set();
      // group by projected value with tolerance, then pick the index-th group from the end
      const tol = 1e-4;
      proj.sort((a, b) => (n.max ? b.v - a.v : a.v - b.v));
      const groups: number[][] = [];
      let last = NaN;
      for (const p of proj) {
        if (groups.length && Math.abs(p.v - last) <= tol) groups[groups.length - 1].push(p.i);
        else groups.push([p.i]);
        last = p.v;
      }
      const g = groups[n.index < 0 ? groups.length + n.index : n.index];
      return new Set(g ?? []);
    }
  }
}

export function matchesPattern(r: OpRecord, kind: EntityKind, i: number, tokens: string[]): boolean {
  const own = entityName(r, kind, i);
  if (containsSeq(own.head, tokens)) return true;
  if (kind === "face") return false;
  if (kind === "edge") return (r.topo.edgeFaces[i] ?? []).some((f) => containsSeq(entityName(r, "face", f).head, tokens));
  const faces = new Set<number>();
  for (const e of r.topo.vertexEdges[i] ?? []) for (const f of r.topo.edgeFaces[e] ?? []) faces.add(f);
  return [...faces].some((f) => containsSeq(entityName(r, "face", f).head, tokens));
}

/** A seam edge borders a single face (the parametrization boundary of a periodic surface). */
export function isSeamEdge(r: OpRecord, e: number): boolean {
  return (r.topo.edgeFaces[e] ?? []).length === 1;
}
