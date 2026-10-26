// 3MFs handed to a desktop slicer: held in memory just long enough for the slicer to download them
const TTL = 10 * 60_000;
const MAX_FILE = 64 << 20;
const MAX_TOTAL = 512 << 20;

const files = new Map<string, { bytes: Uint8Array; expires: number }>();

function sweep() {
  const now = Date.now();
  for (const [k, f] of files) if (f.expires < now) files.delete(k);
}

/** Stores the file; null when it's too big or the store is full. */
export function putSlicerFile(bytes: Uint8Array): string | null {
  sweep();
  const total = [...files.values()].reduce((n, f) => n + f.bytes.byteLength, 0);
  if (bytes.byteLength > MAX_FILE || total + bytes.byteLength > MAX_TOTAL) return null;
  const token = crypto.randomUUID();
  files.set(token, { bytes, expires: Date.now() + TTL });
  return token;
}

export function getSlicerFile(token: string): Uint8Array | null {
  sweep();
  return files.get(token)?.bytes ?? null;
}
