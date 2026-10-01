// Numeric argument checks at the API boundary. OCCT accepts NaN and Infinity without complaint and
// then builds garbage, hangs or traps on it (out-of-bounds memory access) later, far from the cause:
// a field read from an object that no longer has it (`lib.width` → undefined → NaN) has to fail
// here, as a script error at the user's line, e.g. "translate: y is NaN (fairlead.ts:42)".
import { userError as opError } from "./op";
import { hasContext } from "./context";

/** A script error at the user's call site; outside a part (e.g. a plane built at module top level), a plain error located by the stack. */
export function scriptError(message: string): never {
  if (hasContext()) opError(message);
  throw new Error(message);
}

const AXES = ["x", "y", "z"] as const;
/** Largest magnitude accepted (1e9 mm = 1000 km). */
const MAX = 1e9;

/** What's wrong with a value that should be a finite number, or null if nothing is. */
function badNumber(v: unknown): string | null {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "is NaN";
    if (!Number.isFinite(v)) return `is ${v}`;
    // finite but absurd (1e300): OCCT rejects or overflows it, and meshes (float32) turn it into Infinity
    return Math.abs(v) > MAX ? `is ${v}, outside the modeling range (±${MAX})` : null;
  }
  if (v === undefined) return "is undefined";
  if (v === null) return "is null";
  if (typeof v === "string") return `must be a number (got the string ${JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v)})`;
  return `must be a number (got ${Array.isArray(v) ? "an array" : typeof v})`;
}

/** A finite number. `what` names it in the error: "box width", "translate: y". */
export function num(v: unknown, what: string): number {
  const bad = badNumber(v);
  if (bad) scriptError(`${what} ${bad}`);
  return v as number;
}

/** A finite number, or undefined when the option is left out. */
export function optNum(v: unknown, what: string): number | undefined {
  return v === undefined ? undefined : num(v, what);
}

/** A finite number > 0. */
export function positive(v: unknown, what: string): number {
  num(v, what);
  if (!((v as number) > 0)) scriptError(`${what} must be positive (got ${v})`);
  return v as number;
}

/** A finite number ≥ 0. */
export function nonNegative(v: unknown, what: string): number {
  num(v, what);
  if (!((v as number) >= 0)) scriptError(`${what} must not be negative (got ${v})`);
  return v as number;
}

/** An integer ≥ `min` (counts: pattern copies, polygon sides). */
export function int(v: unknown, what: string, min = 0): number {
  num(v, what);
  if (!Number.isInteger(v) || (v as number) < min) scriptError(`${what} must be a whole number of at least ${min} (got ${v})`);
  return v as number;
}

function vecN(v: unknown, n: 2 | 3, what: string): number[] {
  const shape = n === 2 ? "[x, y]" : "[x, y, z]";
  if (!Array.isArray(v) && !(ArrayBuffer.isView(v) && !(v instanceof DataView))) scriptError(`${what} must be ${shape} (got ${v === undefined ? "undefined" : v === null ? "null" : typeof v})`);
  const a = v as ArrayLike<unknown>;
  if (a.length !== n) scriptError(`${what} must be ${shape} (got ${a.length} value${a.length === 1 ? "" : "s"})`);
  for (let i = 0; i < n; i++) {
    const bad = badNumber(a[i]);
    if (bad) scriptError(`${what}: ${AXES[i]} ${bad}`);
  }
  return Array.from(a as ArrayLike<number>);
}

/** A 2D point/vector [x, y] with finite coordinates (a fresh copy). */
export function vec2(v: unknown, what: string): [number, number] {
  return vecN(v, 2, what) as [number, number];
}

/** A 3D point/vector [x, y, z] with finite coordinates (a fresh copy). */
export function vec3(v: unknown, what: string): [number, number, number] {
  return vecN(v, 3, what) as [number, number, number];
}

/** A list of 2D points; errors name the point (1-based): "polyline: point 3: y is NaN". */
export function points2(v: unknown, what: string): [number, number][] {
  if (!Array.isArray(v)) scriptError(`${what} must be an array of [x, y] points`);
  return (v as unknown[]).map((p, i) => vec2(p, `${what}: point ${i + 1}`));
}

/** A list of 3D points; errors name the point (1-based). */
export function points3(v: unknown, what: string): [number, number, number][] {
  if (!Array.isArray(v)) scriptError(`${what} must be an array of [x, y, z] points`);
  return (v as unknown[]).map((p, i) => vec3(p, `${what}: point ${i + 1}`));
}
