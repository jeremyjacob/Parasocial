/** Isomorphic helpers shared by client, server and MCP. */

const STUDIO_RE = /^studios\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts$/;
const LIB_RE = /^lib\/([A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts$/;

/**
 * Script paths: `studios/<name>.ts` (one level; each studio exports one or more parts) or
 * `lib/**\/<name>.ts`. No `..`, no hidden segments, no absolute paths.
 * Mirrors the CHECK constraint on scripts.path.
 */
export function validateScriptPath(path: string): string | null {
  if (typeof path !== "string" || path.length === 0) return "path is required";
  if (path.length > 256) return "path is too long (max 256 characters)";
  if (path.includes("..")) return "path must not contain '..'";
  if (STUDIO_RE.test(path) || LIB_RE.test(path)) return null;
  if (path.startsWith("studios/") && path.slice("studios/".length).includes("/"))
    return `"${path}": studios/ is flat (e.g. studios/bracket.ts)`;
  if (!path.endsWith(".ts")) return `"${path}": scripts must be .ts files`;
  return `"${path}": scripts must live under studios/ (studios/<name>.ts) or lib/ (lib/**/<name>.ts)`;
}

export function isValidScriptPath(path: string): boolean {
  return validateScriptPath(path) === null;
}

/** sha256 hex via WebCrypto (works in browsers, workers and Bun). */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function newID(): string {
  return crypto.randomUUID();
}

export const SHA256_RE = /^[0-9a-f]{64}$/;
