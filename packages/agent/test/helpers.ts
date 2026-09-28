import { MockLanguageModelV4 } from "ai/test";
import { PoolClient } from "@parasocial/engine-pool/client";
import { mutators, sha256Hex } from "@parasocial/sync";
import { FsBlobStore } from "@parasocial/sync/server";
import { createNoteEvents } from "@parasocial/mcp/note-events";
import type { ToolDeps } from "@parasocial/mcp/tools";
import { tmpdir } from "node:os";
import { run, type TestDb } from "../../sync/test/helpers";

export const SECRET = "test-secret-test-secret-test-secret!";

export function toolDeps(db: TestDb): ToolDeps {
  return { db, pool: new PoolClient(), store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: SECRET } };
}

export async function newNote(db: TestDb, userID: string, documentID: string, text = "Make it thicker", assignAgent = false) {
  const noteID = crypto.randomUUID();
  const snapshot = await sha256Hex(`snapshot:${noteID}`);
  await db.sql`INSERT INTO blobs (hash, size, content_type) VALUES (${snapshot}, 8, 'image/png') ON CONFLICT DO NOTHING`;
  await run(db, mutators.note.create({
    id: noteID, documentID, text, assignAgent,
    anchor: {
      targets: [{ kind: "point", name: "point", point: [0, 0, 0] }],
      camera: { position: [10, 10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 45, ortho: false },
      version: "v1", configuration: "Default", snapshot,
    },
  } as any), { userID });
  return noteID;
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

export type Turn = { tool: string; input: Record<string, unknown> } | { text: string };

/** A model that plays `turns` in order, one per step, and records the prompts it was sent. */
export function scriptedModel(turns: Turn[]) {
  const prompts: unknown[] = [];
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options: any) => {
      prompts.push(options.prompt);
      const t = turns[Math.min(i++, turns.length - 1)]!;
      if ("tool" in t)
        return { content: [{ type: "tool-call", toolCallId: `call-${i}`, toolName: t.tool, input: JSON.stringify(t.input) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] } as any;
      return { content: [{ type: "text", text: t.text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] } as any;
    },
  });
  return { model, prompts, calls: () => i };
}
