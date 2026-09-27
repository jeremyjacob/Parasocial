// App-side engine client: creates the cross-origin engine iframe, connects a MessageChannel,
// validates everything that comes back, and exposes a typed RPC.
import type { EngineRequest, EngineInfo, PartResult, EntityDescription, DocumentState, MeasureRef } from "../protocol";
import { validateEngineMessage, validatePartResult } from "../protocol";
import type { EntityKind, MeshQuality, Vec3 } from "@parasocial/kernel";
import type { AnchorTargetRef, Resolution } from "@parasocial/naming";

export type EngineClientOptions = {
  /** e.g. https://engine.example.com or http://localhost:5181 */
  engineUrl: string;
  /** Where to attach the hidden iframe (default document.body). */
  container?: HTMLElement;
  onProgress?: (phase: string, value: number) => void;
};

export class EngineClient {
  readonly iframe: HTMLIFrameElement;
  private port: MessagePort | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; op: string }>();
  readonly ready: Promise<EngineInfo>;
  info?: EngineInfo;

  constructor(private o: EngineClientOptions) {
    const origin = new URL(o.engineUrl).origin;
    const iframe = document.createElement("iframe");
    iframe.src = o.engineUrl;
    iframe.title = "Parasocial engine";
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("tabindex", "-1");
    // cross-origin isolation must be delegated for threads (SharedArrayBuffer) in the iframe
    iframe.allow = "cross-origin-isolated";
    iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    this.iframe = iframe;
    this.ready = new Promise((resolve, reject) => {
      const onLoaded = (ev: MessageEvent) => {
        if (ev.origin !== origin || ev.source !== iframe.contentWindow || ev.data?.type !== "engine-loaded") return;
        window.removeEventListener("message", onLoaded);
        const ch = new MessageChannel();
        this.port = ch.port1;
        ch.port1.onmessage = (e) => this.onMessage(e.data, resolve, reject);
        iframe.contentWindow!.postMessage({ type: "connect" }, origin, [ch.port2]);
      };
      window.addEventListener("message", onLoaded);
    });
    (o.container ?? document.body).appendChild(iframe);
  }

  private onMessage(raw: unknown, resolveReady: (i: EngineInfo) => void, rejectReady: (e: Error) => void) {
    const m = validateEngineMessage(raw);
    if (!m) return console.warn("engine: dropped invalid message");
    if (m.type === "ready") {
      this.info = m.info;
      resolveReady(m.info);
    } else if (m.type === "progress") this.o.onProgress?.(m.phase, m.value);
    else if (m.type === "result") {
      if (m.id === 0 && !m.ok) return rejectReady(new Error(m.error));
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (!m.ok) return p.reject(Object.assign(new Error(m.error), { timeout: !!m.timeout }));
      if ((p.op === "regenerate" || p.op === "regenerateSnapshot") && m.value !== null) {
        const r = validatePartResult(m.value);
        if (!r) return p.reject(new Error("engine returned a malformed regeneration result"));
        return p.resolve(r);
      }
      p.resolve(m.value);
    }
  }

  private call<T>(req: EngineRequest): Promise<T> {
    return this.ready.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const id = this.nextId++;
          this.pending.set(id, { resolve, reject, op: req.op });
          this.port!.postMessage({ id, req });
        }),
    );
  }

  setDocument(doc: DocumentState) {
    return this.call<string[]>({ op: "setDocument", doc });
  }
  setScript(path: string, content: string | null) {
    return this.call<string[]>({ op: "setScript", path, content });
  }
  setOverrides(part: string, overrides: Record<string, string | number>) {
    return this.call<boolean>({ op: "setOverrides", part, overrides });
  }
  /** Latest-wins: resolves `null` if a newer request for the same part superseded this one. */
  regenerate(part: string, quality: MeshQuality = "fine") {
    return this.call<PartResult | null>({ op: "regenerate", part, quality });
  }
  names(part: string) {
    return this.call<Record<EntityKind, string[]>>({ op: "names", part });
  }
  describe(part: string, kind: EntityKind, index: number) {
    return this.call<EntityDescription>({ op: "describe", part, kind, index });
  }
  fromOperation(part: string, opId: string) {
    return this.call<{ kind: EntityKind; indices: number[] }[]>({ op: "fromOperation", part, opId });
  }
  query(part: string, expr: string, kind?: EntityKind) {
    return this.call<number[]>({ op: "query", part, expr, kind });
  }
  resolve(part: string, targets: AnchorTargetRef[], tolerance?: number) {
    return this.call<Resolution[]>({ op: "resolve", part, targets, tolerance });
  }
  resolveOne(part: string, kind: EntityKind, candidates: number[], point?: Vec3, neighbors?: string[]) {
    return this.call<number>({ op: "resolveOne", part, kind, candidates, point, neighbors });
  }
  indexOfName(part: string, kind: EntityKind, name: string) {
    return this.call<number[]>({ op: "indexOfName", part, kind, name });
  }
  measure(a: MeasureRef, b: MeasureRef) {
    return this.call<{ distance: number; a: Vec3; b: Vec3 }>({ op: "measure", a, b });
  }
  /** Regenerate a part of another version (separate engine instance, own cache). */
  regenerateSnapshot(key: string, doc: DocumentState, part: string) {
    return this.call<PartResult>({ op: "regenerateSnapshot", key, doc, part });
  }
  closestPoint(part: string, kind: EntityKind, index: number, point: Vec3) {
    return this.call<Vec3>({ op: "closestPoint", part, kind, index, point });
  }
  check(part: string) {
    return this.call<unknown[]>({ op: "check", part });
  }
  dispose() {
    this.port?.close();
    this.iframe.remove();
    for (const p of this.pending.values()) p.reject(new Error("engine disposed"));
    this.pending.clear();
  }
}
