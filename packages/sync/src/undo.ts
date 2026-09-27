/**
 * Undo support (PLAN §8 Undo): ⌘Z undoes *your own recent mutations* in this
 * session by issuing an inverse mutation, which syncs like any other change.
 *
 * Usage on the client (read = zero.run bound to the Zero instance):
 *
 *   const mr = mutators.param.set({...});
 *   const inverse = await captureInverse(read, mr);   // BEFORE mutating
 *   zero.mutate(mr);
 *   if (inverse) undoStack.push({ redo: [mr], undo: inverse });
 *
 *   // ⌘Z: capture the redo *before* applying the undo, so redo is exact too
 *   const entry = undoStack.pop();
 *   const redo = await captureInverseAll(read, entry.undo);
 *   for (const m of entry.undo) zero.mutate(m);
 *   redoStack.push({ undo: redo ?? [], redo: entry.undo });
 *
 * `captureInverse` reads the pre-mutation state it needs (the old override,
 * the old name, ...) from the local store. Mutations that aren't undoable
 * (script writes, which go through Restore; presence; agent-only actions)
 * return null.
 */
import type { Query } from "@rocicorp/zero";
import { mutators, type Mutators } from "./mutators.ts";
import { zql, type Schema } from "./schema.ts";
import type { ParamValue } from "./types.ts";

/** A mutate request as accepted by `zero.mutate(...)` / `runMutator(...)`. */
export type AnyMR = MutateRequestOf<Mutators>;
type MutateRequestOf<T> = T extends (...a: any[]) => infer R
  ? R
  : T extends object
    ? { [K in Exclude<keyof T, "~">]: MutateRequestOf<T[K]> }[Exclude<keyof T, "~">]
    : never;
/** Runs a query against local state. On the client: `(q) => zero.run(q)`; on the server: `(q) => db.zql.run(q)`. */
export type Reader = <TTable extends keyof Schema["tables"] & string, TReturn>(q: Query<TTable, Schema, TReturn>) => Promise<any>;

// Zero's Mutator<any, …> callable type doesn't accept concrete mutators, so inverters are typed
// loosely inside this module and cast once in captureInverse.
type Inverter = (read: Reader, args: any) => Promise<unknown[] | null>;

const overrideKey = (o: { part: string; name: string }) => `${o.part}\u0000${o.name}`;

/** Inverse of a param change: restore the previous override for every key touched, or reset keys that had none. */
async function invertParams(
  read: Reader,
  documentID: string,
  configurationID: string,
  keys: { part: string; name: string }[],
): Promise<unknown[]> {
  const before: { part: string; name: string; expression: string; value: ParamValue }[] = await read(
    zql.paramOverrides.where("configurationID", configurationID),
  );
  const prev = new Map(before.map((o) => [overrideKey(o), o]));
  const set: { part: string; name: string; expression: string; value: ParamValue }[] = [];
  const reset: { part: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    const key = overrideKey(k);
    if (seen.has(key)) continue;
    seen.add(key);
    const p = prev.get(key);
    if (p) set.push({ part: p.part, name: p.name, expression: p.expression, value: p.value });
    else reset.push({ part: k.part, name: k.name });
  }
  return [mutators.param.apply({ documentID, configurationID, set, reset })];
}

const inverters: Record<string, Inverter> = {
  "param.apply": (read, a) =>
    invertParams(read, a.documentID, a.configurationID, [...(a.set ?? []), ...(a.reset ?? [])]),
  "param.set": (read, a) => invertParams(read, a.documentID, a.configurationID, [a]),
  "param.reset": (read, a) => invertParams(read, a.documentID, a.configurationID, [a]),
  "param.resetAll": async (read, a) => {
    const all: { part: string; name: string }[] = await read(zql.paramOverrides.where("configurationID", a.configurationID));
    return invertParams(read, a.documentID, a.configurationID, all.filter((o) => !a.part || o.part === a.part));
  },

  "configuration.create": async (_read, a) => [mutators.configuration.delete({ id: a.id })],
  "configuration.duplicate": async (_read, a) => [mutators.configuration.delete({ id: a.id })],
  "configuration.rename": async (read, a) => {
    const cfg = await read(zql.configurations.where("id", a.id).one());
    return cfg ? [mutators.configuration.rename({ id: a.id, name: cfg.name })] : null;
  },
  "configuration.delete": async (read, a) => {
    const cfg = await read(zql.configurations.where("id", a.id).related("overrides").one());
    if (!cfg) return null;
    return [
      mutators.configuration.create({
        id: cfg.id,
        documentID: cfg.documentID,
        name: cfg.name,
        overrides: cfg.overrides.map((o: any) => ({ part: o.part, name: o.name, expression: o.expression, value: o.value })),
      }),
    ];
  },

  "note.create": async (_read, a) => [mutators.note.remove({ noteID: a.id })],
  "note.remove": async (read, a) => {
    const n = await read(zql.notes.where("id", a.noteID).one());
    return n && !n.removedAt ? [mutators.note.restore({ noteID: a.noteID })] : null;
  },
  "note.restore": async (read, a) => {
    const n = await read(zql.notes.where("id", a.noteID).one());
    return n && n.removedAt ? [mutators.note.remove({ noteID: a.noteID })] : null;
  },
  "note.reply": async (read, a) => {
    const n = await read(zql.notes.where("id", a.noteID).one());
    const out: unknown[] = [mutators.note.deleteMessage({ id: a.id })];
    // A human reply may have reopened the note; put the status back.
    if (n && n.status !== "Open" && n.status !== "AgentWorking" && (a.kind ?? "message") === "message")
      out.push(mutators.note.setStatus({ noteID: a.noteID, status: n.status }));
    return out;
  },
  "note.deleteMessage": async (read, a) => {
    const m = await read(zql.noteMessages.where("id", a.id).one());
    if (!m) return null;
    return [
      mutators.note.reply({
        id: m.id,
        noteID: m.noteID,
        text: m.text,
        kind: m.kind,
        ...(m.versionID ? { versionID: m.versionID } : {}),
        ...(m.data ? { data: m.data } : {}),
      }),
    ];
  },
  "note.setStatus": async (read, a) => {
    const n = await read(zql.notes.where("id", a.noteID).one());
    // AgentWorking can only be re-entered by the agent claiming again.
    if (!n || n.status === "AgentWorking" || n.status === a.status) return null;
    return [mutators.note.setStatus({ noteID: a.noteID, status: n.status })];
  },
  "note.reanchor": async (read, a) => {
    const n = await read(zql.notes.where("id", a.noteID).one());
    if (!n) return null;
    const out: unknown[] = [mutators.note.reanchor({ noteID: a.noteID, anchor: n.anchor })];
    if (n.orphaned) out.push(mutators.note.setOrphaned({ noteID: a.noteID, orphaned: true }));
    return out;
  },

  "markup.add": async (_read, a) => [mutators.markup.remove({ id: a.id })],
  "markup.remove": async (read, a) => {
    const s = await read(zql.markupStrokes.where("id", a.id).one());
    if (!s) return null;
    return [
      mutators.markup.add({
        id: s.id,
        documentID: s.documentID,
        noteID: s.noteID ?? null,
        part: s.part,
        points: s.points,
        color: s.color,
        width: s.width,
      }),
    ];
  },
};

/** Names of mutators that ⌘Z can undo. */
export const UNDOABLE = new Set(Object.keys(inverters));

export function isUndoable(mr: AnyMR): boolean {
  return UNDOABLE.has(mr.mutator.mutatorName);
}

/**
 * Computes the inverse of `mr` from the current local state. Call it *before*
 * issuing `mr`. Returns the mutations that undo it (in order), or null when
 * `mr` isn't undoable or there's nothing to undo.
 */
export async function captureInverse(read: Reader, mr: AnyMR): Promise<AnyMR[] | null> {
  const inv = inverters[mr.mutator.mutatorName];
  if (!inv) return null;
  return (await inv(read, mr.args)) as AnyMR[] | null;
}

/** Inverse of a sequence (e.g. an undo entry), in reverse order. Null if any step isn't invertible. */
export async function captureInverseAll(read: Reader, mrs: AnyMR[]): Promise<AnyMR[] | null> {
  const out: AnyMR[] = [];
  for (const mr of [...mrs].reverse()) {
    const inv = await captureInverse(read, mr);
    if (!inv) return null;
    out.push(...inv);
  }
  return out;
}
