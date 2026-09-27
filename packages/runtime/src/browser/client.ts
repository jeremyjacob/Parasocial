// App-side engine client: creates the cross-origin engine iframe, connects a MessageChannel,
// validates everything that comes back, and exposes a typed RPC.
import type { EngineRequest, EngineInfo, PartResult, PartInfo, EntityDescription, DocumentState, MeasureRef } from "../protocol";
import { validateEngineMessage, validatePartResult, validatePartInfos, validateAssemblies, validateInterferences } from "../protocol";
import type { AssemblyInfo, Interference, PartPose } from "../protocol";
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
      // an engine origin that's down (or a page that fails to boot) never says hello: fail instead of loading forever
      const timer = setTimeout(() => {
        window.removeEventListener("message", onLoaded);
        reject(new Error(`the engine at ${origin} didn't load`));
      }, 30_000);
      const onLoaded = (ev: MessageEvent) => {
        if (ev.origin !== origin || ev.source !== iframe.contentWindow || ev.data?.type !== "engine-loaded") return;
        clearTimeout(timer);
        window.removeEventListener("message", onLoaded);
        const ch = new MessageChannel();
        this.port = ch.port1;
        ch.port1.onmessage = (e) => this.onMessage(e.data, resolve, reject);
        iframe.contentWindow!.postMessage({ type: "connect" }, origin, [ch.port2]);
      };
      window.addEventListener("message", onLoaded);
    });
    this.ready.catch(() => {}); // a warmed engine nobody attached to yet: not an unhandled rejection
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
      if (p.op === "setDocument" || p.op === "setScript" || p.op === "parts" || p.op === "snapshotParts") {
        const parts = validatePartInfos(m.value);
        if (!parts) return p.reject(new Error("engine returned a malformed part list"));
        return p.resolve(parts);
      }
      if (p.op === "assemblies") {
        const a = validateAssemblies(m.value);
        if (!a) return p.reject(new Error("engine returned a malformed assembly list"));
        return p.resolve(a);
      }
      if (p.op === "interferences" && m.value !== null) {
        const a = validateInterferences(m.value);
        if (!a) return p.reject(new Error("engine returned malformed interference results"));
        return p.resolve(a);
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

  /** Returns the parts the scripts export. */
  setDocument(doc: DocumentState) {
    return this.call<PartInfo[]>({ op: "setDocument", doc });
  }
  /** Returns the parts the scripts export. */
  setScript(path: string, content: string | null) {
    return this.call<PartInfo[]>({ op: "setScript", path, content });
  }
  /** The parts of a snapshot (another version), discovered in the snapshot engine. */
  snapshotParts(key: string, doc: DocumentState) {
    return this.call<PartInfo[]>({ op: "snapshotParts", key, doc });
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
  /** Export a part as STEP / STL / 3MF bytes. */
  async exportParts(parts: string[], format: "step" | "stl" | "3mf"): Promise<Uint8Array> {
    const r = await this.call<{ base64: string }>({ op: "export", parts, format });
    const bin = atob(r.base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  tangentChain(part: string, edge: number) {
    return this.call<number[]>({ op: "tangentChain", part, edge });
  }
  loopOf(part: string, edge: number, face?: number) {
    return this.call<number[]>({ op: "loopOf", part, edge, face });
  }
  opsAtLine(part: string, file: string, line: number) {
    return this.call<string[]>({ op: "opsAtLine", part, file, line });
  }
  closestPoint(part: string, kind: EntityKind, index: number, point: Vec3) {
    return this.call<Vec3>({ op: "closestPoint", part, kind, index, point });
  }
  /** The assemblies the studios export. */
  assemblies() {
    return this.call<AssemblyInfo[]>({ op: "assemblies" });
  }
  /** Dragged positions: measure and export use them. */
  setPoses(poses: Record<string, PartPose>) {
    return this.call<boolean>({ op: "setPoses", poses });
  }
  /** Where these parts overlap, at `poses`. Latest-wins: resolves `null` when a newer request superseded it. */
  interferences(parts: string[], ignore: [string, string][], poses: Record<string, PartPose>) {
    return this.call<Interference[] | null>({ op: "interferences", parts, ignore, poses });
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
