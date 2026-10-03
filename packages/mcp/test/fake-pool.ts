// The engine pool's job protocol over an in-process runtime Engine, one per pool document (like
// the real pool). Renders are recorded, not drawn (no WebGPU here).
import { Engine } from "@parasocial/runtime";
import { drawPart } from "@parasocial/runtime/drawing";
import { computeBom } from "@parasocial/runtime/bom-engine";

export class FakePool {
  renders: any[] = [];
  private slots = new Map<string, { e: Engine; scripts: string; overrides: Record<string, Record<string, string | number>> }>();
  async run(job: { document: string; scripts: Record<string, string>; overrides?: Record<string, Record<string, string | number>>; ops: any[] }) {
    let slot = this.slots.get(job.document);
    const scripts = JSON.stringify(job.scripts);
    if (!slot || slot.scripts !== scripts) {
      const e = new Engine();
      e.setDocument({ scripts: job.scripts, overrides: job.overrides ?? {} });
      this.slots.set(job.document, (slot = { e, scripts, overrides: job.overrides ?? {} }));
    } else {
      const o = job.overrides ?? {};
      for (const part of new Set([...Object.keys(o), ...Object.keys(slot.overrides)])) slot.e.setOverrides(part, o[part] ?? {});
      slot.overrides = o;
    }
    const e = slot.e;
    return job.ops.map((op) => {
      try {
        return { ok: true as const, value: this.op(e, op) };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    });
  }
  private op(e: Engine, op: any): unknown {
    switch (op.op) {
      case "parts":
        return e.partInfos();
      case "regenerate": {
        const { mesh, ...meta } = e.regenerate(op.part);
        return meta;
      }
      case "assemblies":
        return e.assemblies();
      case "setPoses":
        return void e.setPoses(op.poses);
      case "interferences":
        if (op.poses) e.setPoses(op.poses);
        return e.interferences(op.parts, op.ignore).map(({ mesh, ...x }) => x);
      case "interference":
        return e.interference(op.a, op.b);
      case "interferencePairs":
        return op.pairs.map(([a, b]: [string, string]) => e.interference(a, b));
      case "distancePairs":
        return e.distances(op.pairs, op.within);
      case "measure":
        return e.measure(op.a, op.b);
      case "check":
        return e.check(op.part);
      case "describe":
        return e.describe(op.part, op.kind, op.index);
      case "describeAll":
        return e.describeAll(op.part);
      case "query":
        return e.query(op.part, op.expr, op.kind);
      case "indexOfName":
        return e.indexOfName(op.part, op.kind, op.name);
      case "resolve":
        return op.targets.map((t: any) => e.resolve(op.part, t, op.tolerance));
      case "resolveOne":
        return e.resolveOne(op.part, op.kind, op.candidates, op.point, op.neighbors);
      case "bom":
        return computeBom(e, { assembly: op.assembly, documentName: op.documentName });
      case "drawing": {
        const { pdf, ...rest } = drawPart(e, op.part, op.options);
        return pdf ? { ...rest, base64: Buffer.from(pdf).toString("base64") } : rest;
      }
      case "export": {
        const bytes = e.exportParts(op.parts ?? [op.part], op.format);
        return { base64: Buffer.from(bytes).toString("base64"), bytes: bytes.length };
      }
      case "evaluate":
        return e.evaluate(op.script, op.expr, op.part);
      case "render":
        this.renders.push(op);
        return { png: "" };
      default:
        throw new Error(`fake pool: ${op.op}`);
    }
  }
}
