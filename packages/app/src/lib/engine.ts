// The engine (cross-origin iframe + worker). One per tab, created on demand and kept across
// client-side navigation, so hovering a document in the list warms it (§9).
import { EngineClient } from "@parasocial/runtime/browser/client";

let client: EngineClient | null = null;
let url = "";

export function configureEngine(engineURL: string) {
  url = engineURL;
}

export function engine(): EngineClient {
  if (!url) throw new Error("engine URL not configured");
  client ??= new EngineClient({ engineUrl: url });
  return client;
}

/** Start loading the kernel in the background (idempotent). */
export function warmEngine() {
  if (typeof window === "undefined" || !url) return;
  engine();
}
