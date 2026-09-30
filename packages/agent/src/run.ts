// One built-in agent run: a single note, worked to Resolved or left Open with a reply. The agent is
// an ordinary agent session (avatar, claims, activity log, version attribution) whose tools are
// the MCP tools over an in-process connection.
import { generateText, isStepCount, type LanguageModel } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mutators, newID } from "@parasocial/sync";
import { runMutator } from "@parasocial/sync/server";
import { createSessionServer } from "@parasocial/mcp/server";
import { trace, type Trace } from "@parasocial/mcp/trace";
import type { Session, ToolDeps } from "@parasocial/mcp/tools";
import { mcpToolSet } from "./tools";
import { languageModel, ProviderSetupError } from "./providers";
import { loadAgentCredentials } from "./settings";

export const BUILTIN_CLIENT_NAME = "Agent";
export const MAX_STEPS = 80;
/** How often a run checks that its note wasn't taken back. */
const CLAIM_POLL_MS = 3_000;

export type RunOutcome =
  /** the agent resolved the note */
  | "resolved"
  /** left Open with a reply, a question, or a stop reason */
  | "open"
  /** a person took the note back, or it was removed, mid-run */
  | "taken-back"
  /** another agent holds it */
  | "claimed"
  /** no provider or key configured */
  | "setup"
  | "error";

export type RunOptions = {
  documentID: string;
  noteID: string;
  /** whose provider runs it, and who it acts as */
  userID: string;
  /** for tests: skips the user's provider settings */
  model?: LanguageModel;
  maxSteps?: number;
  signal?: AbortSignal;
  /** how often to check the note wasn't taken back (ms) */
  claimPollMs?: number;
};

const ADDENDUM = `Built-in agent
You are the agent built into Parasocial, working one note that a person handed to you (it is already claimed for you). Other runs of you may be working other notes in this document at the same time: stick to your note, and if a write fails on a stale baseVersion, re-read and redo your edit on top of the newer version. Your tools act on this document only; their document argument is filled in for you. Nobody watches this run live and you can't wait for answers: never ask for permission. If you need a decision or information from a person, reply_to_note with status "Open" and a short, specific question, then stop. When the work is done and verified, resolve the note (set_note_status "Resolved", or reply_to_note if there's something worth saying) and stop.
Keep note replies short: a sentence or two, three at most, in plain words. Say what changed or what you need, not how you did it; the linked version already shows the details. No headings, lists, or step-by-step recaps.`;

/**
 * The user's built-in agent session for one note, created on first use. Each note gets its own
 * session (avatar, status, claim), so several notes in a document can be worked at once; a note
 * the agent comes back to reuses the session that worked it before.
 */
export async function builtinSession(deps: Pick<ToolDeps, "db">, userID: string, documentID: string, noteID: string, label?: string) {
  const [prior] = await deps.db.sql`
    SELECT a.id FROM agent_sessions a
     WHERE a.user_id = ${userID} AND a.document_id = ${documentID} AND a.builtin
       AND (a.id = (SELECT claimed_by FROM notes WHERE id = ${noteID})
            OR EXISTS (SELECT 1 FROM note_messages m WHERE m.note_id = ${noteID} AND m.author_agent_id = a.id))
     ORDER BY a.last_seen_at DESC LIMIT 1`;
  const id: string = prior?.id ?? crypto.randomUUID();
  const r = await runMutator(deps.db, mutators.agent.start({ id, clientName: BUILTIN_CLIENT_NAME, label, documentID } as any), { userID });
  if (!r.ok) throw new Error(r.message);
  await deps.db.sql`UPDATE agent_sessions SET builtin = true WHERE id = ${id}`;
  return id;
}

export async function runNote(deps: ToolDeps, opts: RunOptions): Promise<RunOutcome> {
  // the whole run for debugging (off unless AGENT_TRACE_DIR is set); its tool calls are also in tools-<session>.jsonl
  const t = trace(`run-${new Date().toISOString().replace(/[:.]/g, "-")}-${opts.noteID}`);
  t({ event: "start", note: opts.noteID, document: opts.documentID, user: opts.userID });
  try {
    const outcome = await work(deps, opts, t);
    t({ event: "end", outcome });
    return outcome;
  } catch (e) {
    t({ event: "end", outcome: "exception", error: e });
    throw e;
  }
}

async function work(deps: ToolDeps, opts: RunOptions, t: Trace): Promise<RunOutcome> {
  const { db } = deps;
  const { documentID, noteID, userID } = opts;
  const creds = opts.model ? null : await loadAgentCredentials(db, deps.config.secret, userID);
  const modelName = opts.model ? undefined : creds?.model;
  const sessionID = await builtinSession(deps, userID, documentID, noteID, modelName);
  const as = { userID, agentSessionID: sessionID };
  // why a run stopped is a message (people need to see it); routine entries are collapsed activity
  const post = (text: string, kind: "message" | "activity" = "activity", data?: Record<string, unknown>) =>
    runMutator(db, mutators.note.reply({ id: newID(), noteID, text, kind, ...(data ? { data } : {}) } as any), as);

  let model: LanguageModel;
  try {
    if (opts.model) model = opts.model;
    else if (!creds) throw new ProviderSetupError("Set up the agent in Settings to hand notes to it.");
    else model = languageModel(creds);
  } catch (e) {
    if (!(e instanceof ProviderSetupError)) throw e;
    t({ event: "setup", error: e.message, provider: creds?.provider, model: modelName });
    await post(e.message, "message");
    return "setup";
  }

  const session: Session = {
    id: sessionID,
    userID,
    clientID: "builtin",
    clientName: BUILTIN_CLIENT_NAME,
    label: modelName,
    defaultDocument: documentID,
    activeConfig: new Map(),
    lastVersion: new Map(),
    calls: [],
    noteCursors: new Map(),
    startedAt: Date.now(),
  };
  t({ event: "session", session: sessionID, provider: creds?.provider ?? "test", model: modelName, baseURL: creds?.baseURL });
  const server = await createSessionServer(session, deps);
  const client = new Client({ name: "parasocial-builtin", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const abort = new AbortController();
  const onOuterAbort = () => abort.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onOuterAbort);
  let takenBack = false;
  // set_note_status / reply_to_note / release_note settle the note (and release the claim): the run ends there
  let settled = false;
  let replied = false;
  let poll: ReturnType<typeof setInterval> | undefined;

  const noteState = async () => (await db.sql`SELECT status, claimed_by, removed_at FROM notes WHERE id = ${noteID}`)[0] as { status: string; claimed_by: string | null; removed_at: unknown } | undefined;

  try {
    const claim = await client.callTool({ name: "claim_note", arguments: { document: documentID, id: noteID } });
    if (claim.isError) {
      t({ event: "claim-failed", result: claim.content });
      return "claimed";
    }

    poll = setInterval(async () => {
      const n = await noteState().catch(() => undefined);
      if (!n || n.removed_at || (n.claimed_by !== sessionID && n.status !== "Resolved" && !settled)) {
        takenBack = true;
        abort.abort(new Error("taken back"));
      }
    }, opts.claimPollMs ?? CLAIM_POLL_MS);
    (poll as any).unref?.();

    const note = await client.callTool({ name: "get_note", arguments: { document: documentID, id: noteID } });
    const noteContent = note.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    const noteText = noteContent.find((c) => c.type === "text")?.text ?? "";
    // images pasted into the thread go to the model as images
    const noteImages = noteContent.filter((c) => c.type === "image" && c.data).map((c) => ({ type: "file" as const, mediaType: c.mimeType ?? "image/png", data: c.data! }));
    const tools = await mcpToolSet(client, documentID);

    for (const name of ["set_note_status", "reply_to_note", "release_note"]) {
      const t = tools[name];
      if (!t?.execute) continue;
      const execute = t.execute;
      t.execute = async (input: any, o: any) => {
        const r = (await execute(input, o)) as { isError?: boolean };
        if (!r?.isError && (input?.id ?? noteID) === noteID) {
          settled = true;
          if (name === "reply_to_note") replied = true;
        }
        return r;
      };
    }

    const instructions = `${client.getInstructions() ?? ""}\n\n${ADDENDUM}`;
    const prompt = `You've been handed note ${noteID}. Here it is:\n\n${noteText}${noteImages.length ? `\n\nThe ${noteImages.length === 1 ? "image" : `${noteImages.length} images`} pasted into the thread follow, in order.` : ""}`;
    t({ event: "prompt", instructions, prompt, images: noteImages.length, tools: Object.keys(tools) });
    let result;
    try {
      result = await generateText({
        model,
        instructions,
        messages: [{ role: "user", content: noteImages.length ? [{ type: "text", text: prompt }, ...noteImages] : prompt }],
        tools,
        stopWhen: [isStepCount(opts.maxSteps ?? MAX_STEPS), () => settled],
        abortSignal: abort.signal,
        maxRetries: 2,
        onStepEnd: (step) => {
          // content: text, reasoning, tool calls and their results / errors, in order
          t({ event: "step", n: step.stepNumber, finishReason: step.finishReason, usage: step.usage, content: step.content, settled });
          db.sql`UPDATE agent_sessions SET last_seen_at = ${Date.now()} WHERE id = ${sessionID}`.catch(() => {});
        },
      });
    } catch (e) {
      t({ event: "error", error: e, takenBack, aborted: !!opts.signal?.aborted });
      if (takenBack) {
        await post("Stopped: the note was taken back.");
        return "taken-back";
      }
      if (opts.signal?.aborted) {
        await release();
        await post("Stopped: the server is shutting down. The note is open again.");
        return "open";
      }
      await release();
      await post(`Stopped on an error from the model provider: ${errorText(e)}`, "message");
      return "error";
    }

    const usage = { inputTokens: result.totalUsage.inputTokens, outputTokens: result.totalUsage.outputTokens, steps: result.steps.length };
    const n = await noteState();
    t({ event: "finished", usage, finishReason: result.finishReason, text: result.text, settled, replied, note: n });
    if (n?.status === "Resolved") return "resolved";
    if (takenBack || !n || n.removed_at) return "taken-back";
    if (!settled) {
      // stopped without settling: say why, and give the note back
      await release();
      const text = result.text.trim();
      if (text) await post(text, "message", { usage });
      else await post(result.steps.length >= (opts.maxSteps ?? MAX_STEPS) ? `Stopped after ${result.steps.length} steps without finishing.` : "Stopped without finishing.", "message", { usage });
    } else if (!replied) {
      await post("Left the note open.", "activity", { usage });
    }
    return "open";
  } finally {
    clearInterval(poll);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await runMutator(db, mutators.agent.setStatus({ id: sessionID, status: "idle", detail: null } as any), { userID }).catch(() => {});
  }

  /** Give the note back (Open, unclaimed) if this run still holds it. */
  async function release() {
    const n = await noteState();
    if (n?.claimed_by === sessionID) await runMutator(db, mutators.note.setStatus({ noteID, status: "Open" } as any), as);
  }
}

function errorText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
}
