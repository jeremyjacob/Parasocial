// Note activity for agents: new notes and human replies (§7). The note mutators pg_notify on
// commit; one LISTEN connection per process fans the wake-ups out to waiting sessions, which
// then read what happened from the tables (the notification is only a doorbell, so a missed
// one costs latency, never an event).
import { NOTE_EVENTS_CHANNEL, type NoteEvent } from "@parasocial/sync";
import type { Db } from "@parasocial/sync/server";

/** Commits can land out of timestamp order; re-read this far back and dedupe by id. */
const OVERLAP_MS = 5_000;

export type NoteActivity = { noteID: string; documentID: string; created: boolean; replies: { id: string; text: string; author: string | null; at: number }[]; at: number };

/** Per-listener position: events after `since`, minus ones already delivered. */
export class NoteCursor {
  private seen = new Map<string, number>();
  private readonly start: number;
  constructor(public since: number) {
    this.start = since;
  }

  /** Where the next read starts: back by the overlap, but never before the cursor was made. */
  get readFrom() {
    return Math.max(this.start, this.since - OVERLAP_MS);
  }

  /** Keep what hasn't been delivered, mark it delivered, advance. */
  take(events: { id: string; at: number }[]) {
    const fresh = events.filter((e) => !this.seen.has(e.id));
    for (const e of fresh) {
      this.seen.set(e.id, e.at);
      this.since = Math.max(this.since, e.at);
    }
    for (const [id, at] of this.seen) if (at < this.since - OVERLAP_MS) this.seen.delete(id);
    return fresh;
  }
}

export function createNoteEvents(db: Db) {
  const listeners = new Set<(e: NoteEvent) => void>();
  let listening: Promise<unknown> | null = null;

  /** Subscribe to wake-ups (all documents); returns unsubscribe. */
  function on(fn: (e: NoteEvent) => void) {
    // postgres.js keeps a dedicated connection for LISTEN and re-listens after reconnects
    listening ??= db.sql
      .listen(NOTE_EVENTS_CHANNEL, (payload) => {
        let e: NoteEvent;
        try {
          e = JSON.parse(payload);
        } catch {
          return;
        }
        for (const l of listeners) l(e);
      })
      .catch((err) => {
        listening = null;
        console.error("note events: LISTEN failed", err);
      });
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * Activity in documents after the cursor, grouped per note: notes created by anyone but
   * `agentSessionID`, and human replies on notes that are free or held by that session.
   * Removed notes and notes claimed by other agents are skipped.
   */
  async function read(documentIDs: string[], cursor: NoteCursor, agentSessionID: string): Promise<NoteActivity[]> {
    if (!documentIDs.length) return [];
    const after = new Date(cursor.readFrom);
    const rows = await db.sql`
      SELECT n.id AS event_id, n.id AS note_id, n.document_id, n.created_at AS at, true AS created, NULL AS text, NULL AS author
        FROM notes n
       WHERE n.document_id IN ${db.sql(documentIDs)} AND n.removed_at IS NULL AND n.created_at > ${after}
         AND n.author_agent_id IS DISTINCT FROM ${agentSessionID} AND (n.claimed_by IS NULL OR n.claimed_by = ${agentSessionID})
      UNION ALL
      SELECT m.id, m.note_id, m.document_id, m.created_at, false, m.text, u.name
        FROM note_messages m JOIN notes n ON n.id = m.note_id LEFT JOIN users u ON u.id = m.author_user_id
       WHERE m.document_id IN ${db.sql(documentIDs)} AND n.removed_at IS NULL AND m.created_at > ${after}
         AND m.kind = 'message' AND m.author_agent_id IS NULL AND m.created_at <> n.created_at
         AND (n.claimed_by IS NULL OR n.claimed_by = ${agentSessionID})
       ORDER BY at`;
    const fresh = cursor.take(rows.map((r: any) => ({ ...r, id: r.event_id, at: new Date(r.at).getTime() })) as any[]);
    const byNote = new Map<string, NoteActivity>();
    for (const r of fresh as any[]) {
      const a: NoteActivity = byNote.get(r.note_id) ?? { noteID: r.note_id, documentID: r.document_id, created: false, replies: [], at: r.at };
      if (r.created) a.created = true;
      else a.replies.push({ id: r.id, text: r.text, author: r.author, at: r.at });
      a.at = Math.max(a.at, r.at);
      byNote.set(r.note_id, a);
    }
    return [...byNote.values()];
  }

  /**
   * Resolve with the first activity after the cursor, or [] at the deadline / on abort.
   * Re-reads every `pollMs` too, in case the LISTEN connection was down when something landed.
   */
  async function wait(documentIDs: string[], cursor: NoteCursor, agentSessionID: string, opts: { timeoutMs: number; signal?: AbortSignal; pollMs?: number }) {
    const deadline = Date.now() + opts.timeoutMs;
    const docs = new Set(documentIDs);
    let wake = Promise.withResolvers<void>();
    const off = on((e) => docs.has(e.documentID) && wake.resolve());
    const abort = () => wake.resolve();
    opts.signal?.addEventListener("abort", abort);
    try {
      while (true) {
        const found = await read(documentIDs, cursor, agentSessionID);
        const left = deadline - Date.now();
        if (found.length || left <= 0 || opts.signal?.aborted) return found;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([wake.promise, new Promise<void>((r) => (timer = setTimeout(r, Math.min(left, opts.pollMs ?? 30_000))))]);
        clearTimeout(timer);
        wake = Promise.withResolvers<void>();
      }
    } finally {
      off();
      opts.signal?.removeEventListener("abort", abort);
    }
  }

  return { on, read, wait };
}

export type NoteEvents = ReturnType<typeof createNoteEvents>;
