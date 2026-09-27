// Derived data (§3): a regeneration result packed into one binary blob for the cache —
// JSON metadata (entities, names, params, problems) + the mesh's typed arrays.
// Keyed by hash(script contents, effective params, engine build).
import type { PartResult } from "./engine";

const MAGIC = 0x50534431; // "PSD1"
const ARRAYS = ["positions", "normals", "indices", "faceRanges", "edgePositions", "edgeRanges"] as const;

export type CachedPart = PartResult & { names?: { face: string[]; edge: string[] } };

export function packResult(r: CachedPart): ArrayBuffer {
  const { mesh, ...meta } = r;
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const arrays = mesh ? ARRAYS.map((k) => mesh[k] as Float32Array | Uint32Array) : [];
  const header = 4 * (3 + ARRAYS.length); // magic, jsonLen, hasMesh, lengths
  let size = header + align4(json.length);
  for (const a of arrays) size += a.byteLength;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC);
  dv.setUint32(4, json.length);
  dv.setUint32(8, mesh ? 1 : 0);
  arrays.forEach((a, i) => dv.setUint32(12 + i * 4, a.length));
  new Uint8Array(buf, header, json.length).set(json);
  let o = header + align4(json.length);
  for (const a of arrays) {
    new Uint8Array(buf, o, a.byteLength).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    o += a.byteLength;
  }
  return buf;
}

export function unpackResult(buf: ArrayBuffer): CachedPart | null {
  if (buf.byteLength < 12) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0) !== MAGIC) return null;
  const jsonLen = dv.getUint32(4);
  const hasMesh = dv.getUint32(8) === 1;
  const header = 4 * (3 + ARRAYS.length);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, header, jsonLen)));
  if (!hasMesh) return meta;
  let o = header + align4(jsonLen);
  const mesh: Record<string, Float32Array | Uint32Array> = {};
  ARRAYS.forEach((k, i) => {
    const n = dv.getUint32(12 + i * 4);
    const Ctor = k === "indices" || k === "faceRanges" || k === "edgeRanges" ? Uint32Array : Float32Array;
    mesh[k] = new Ctor(buf.slice(o, o + n * 4));
    o += n * 4;
  });
  return { ...meta, mesh };
}

const align4 = (n: number) => (n + 3) & ~3;

/** Cache key for a part's derived data. */
export async function derivedKey(input: { part: string; scripts: Record<string, string>; overrides: Record<string, string | number>; build: string }): Promise<string> {
  const paths = Object.keys(input.scripts).sort();
  const text = JSON.stringify([input.build, input.part, paths.map((p) => [p, input.scripts[p]]), Object.entries(input.overrides).sort()]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
