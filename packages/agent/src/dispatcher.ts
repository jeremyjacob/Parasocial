// Hands notes to the built-in agent: notes a person handed over (agent_assigned_by), and every open
// note in documents with auto hand-off on (settings.agent). One run per note, up to
// MAX_RUNS_PER_DOCUMENT at a time in each document, oldest notes first. A note goes back to the agent only after new human activity (a reply, or handing it
// over again) since the agent last wrote in its thread, so a note the agent left open with a
// question waits for the answer instead of looping.
import type { ToolDeps } from "@parasocial/mcp/tools";
import { runNote, type RunOptions, type RunOutcome } from "./run";

/** Notes worked at once in one document; the rest wait their turn. */
export const MAX_RUNS_PER_DOCUMENT = 8;

export type DispatcherOptions = {
  /** re-scan everything this often, in case a wake-up was missed (ms; 0 disables) */
  sweepMs?: number;
  /** for tests */
  run?: (deps: ToolDeps, opts: RunOptions) => Promise<RunOutcome>;
  log?: (msg: string, err?: unknown) => void;
  /** defaults to MAX_RUNS_PER_DOCUMENT */
  maxPerDocument?: number;
};

type Running = { documentID: string; abort: AbortController; done: Promise<void> };

export function createAgentDispatcher(deps: ToolDeps, opts: DispatcherOptions = {}) {
  const { db } = deps;
  const run = opts.run ?? runNote;
  const log = opts.log ?? ((m, e) => (e ? console.error(`agent: ${m}`, e) : console.log(`agent: ${m}`)));
  const maxPerDocument = opts.maxPerDocument ?? MAX_RUNS_PER_DOCUMENT;
  /** note id → its run */
  const running = new Map<string, Running>();
  let stopped = false;
  // scans run one after another, so two can't start the same note
  let chain: Promise<void> = Promise.resolve();
  // notes whose run a restart cut off: they go again even though the agent already wrote in them
  const resume = new Set<string>();

  /** Notes waiting for the agent, oldest first (in every document, or just `documentID`). */
  async function candidates(documentID: string | null) {
    return (await db.sql`
      SELECT n.id, n.document_id, COALESCE(n.agent_assigned_by, d.settings->'agent'->>'runAs') AS run_as
        FROM notes n JOIN documents d ON d.id = n.document_id
       WHERE n.status = 'Open' AND n.claimed_by IS NULL AND n.removed_at IS NULL
         AND (${documentID}::text IS NULL OR n.document_id = ${documentID})
         AND (n.agent_assigned_by IS NOT NULL OR (d.settings->'agent'->>'autoHandoff' = 'true' AND n.author_agent_id IS NULL
                  -- pickup is on by default: it waits for runAs to set up a provider instead of nagging on every note
                  AND EXISTS (SELECT 1 FROM user_agent_settings u WHERE u.user_id = d.settings->'agent'->>'runAs')))
         AND EXISTS (SELECT 1 FROM document_members m WHERE m.document_id = n.document_id AND m.role IN ('editor', 'owner')
                      AND m.user_id = COALESCE(n.agent_assigned_by, d.settings->'agent'->>'runAs'))
         AND (n.id = ANY(${[...resume]}::text[]) OR NOT EXISTS (
           SELECT 1 FROM note_messages b JOIN agent_sessions a ON a.id = b.author_agent_id AND a.builtin
            WHERE b.note_id = n.id
              AND b.created_at >= GREATEST(
                COALESCE(n.agent_assigned_at, n.created_at),
                COALESCE((SELECT max(h.created_at) FROM note_messages h WHERE h.note_id = n.id AND h.author_agent_id IS NULL AND h.kind = 'message'), n.created_at))))
       ORDER BY n.created_at, n.id`) as unknown as { id: string; document_id: string; run_as: string }[];
  }

  function scan(documentID: string | null = null): Promise<void> {
    chain = chain.then(async () => {
      if (stopped) return;
      const perDocument = new Map<string, number>();
      for (const r of running.values()) perDocument.set(r.documentID, (perDocument.get(r.documentID) ?? 0) + 1);
      for (const c of await candidates(documentID)) {
        if (running.has(c.id)) continue;
        const n = perDocument.get(c.document_id) ?? 0;
        if (n >= maxPerDocument) continue;
        perDocument.set(c.document_id, n + 1);
        resume.delete(c.id);
        start(c.document_id, c.id, c.run_as);
      }
    }).catch((e) => log("scan failed", e));
    return chain;
  }

  function start(documentID: string, noteID: string, userID: string) {
    const abort = new AbortController();
    const done = run(deps, { documentID, noteID, userID, signal: abort.signal })
      .then((outcome) => log(`note ${noteID}: ${outcome}`))
      .catch((e) => log(`note ${noteID} failed`, e))
      .finally(() => {
        running.delete(noteID);
        if (!stopped) void scan(documentID);
      });
    running.set(noteID, { documentID, abort, done });
  }

  /** Runs don't survive a restart: give their notes back so they're picked up again. */
  async function recover() {
    const cut = (await db.sql`UPDATE notes SET claimed_by = NULL, status = CASE WHEN status = 'AgentWorking' THEN 'Open' ELSE status END
                  WHERE claimed_by IN (SELECT id FROM agent_sessions WHERE builtin) RETURNING id`) as unknown as { id: string }[];
    for (const n of cut) resume.add(n.id);
    await db.sql`UPDATE agent_sessions SET status = 'idle', detail = NULL WHERE builtin AND status <> 'idle'`;
  }

  const off = deps.noteEvents.on((e) => void scan(e.documentID));
  const sweepMs = opts.sweepMs ?? 60_000;
  const sweep = sweepMs > 0 ? setInterval(() => void scan(), sweepMs) : undefined;
  (sweep as any)?.unref?.();
  const ready = recover().catch((e) => log("recover failed", e)).then(() => scan());

  return {
    ready,
    scan,
    /** note id → its document, for every note being worked */
    running: () => new Map([...running].map(([n, r]) => [n, r.documentID])),
    async stop() {
      stopped = true;
      off();
      clearInterval(sweep);
      for (const r of running.values()) r.abort.abort(new Error("shutting down"));
      await Promise.allSettled([...running.values()].map((r) => r.done));
    },
  };
}

export type AgentDispatcher = ReturnType<typeof createAgentDispatcher>;
