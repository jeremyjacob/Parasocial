// Human follow-ups join the model conversation between tool steps. IDs come from the initial
// get_note snapshot, so replies committed while that snapshot is loading aren't lost.
import type { ModelMessage, UserContent } from "ai";
import type { ToolDeps } from "@parasocial/mcp/tools";

export function noteThread(deps: ToolDeps, documentID: string, noteID: string, initialIDs: string[]) {
  const seen = new Set(initialIDs);

  return async (): Promise<ModelMessage[]> => {
    const rows = await deps.db.sql`
      SELECT m.id, m.text, m.data, u.name AS author
        FROM note_messages m LEFT JOIN users u ON u.id = m.author_user_id
       WHERE m.note_id = ${noteID} AND m.document_id = ${documentID}
         AND m.kind = 'message' AND m.author_agent_id IS NULL
         AND NOT (m.id = ANY(${[...seen]}::text[]))
       ORDER BY m.created_at, m.id`;
    const messages: ModelMessage[] = [];
    for (const row of rows) {
      const content: UserContent = [{ type: "text", text: `New reply on note ${noteID} from ${row.author ?? "someone"}:\n\n${row.text}` }];
      const images: unknown = row.data?.images;
      const hashes = Array.isArray(images) ? images.filter((h): h is string => typeof h === "string").slice(-8) : [];
      for (const hash of hashes) {
        const [blob] = await deps.db.sql`SELECT content_type FROM blobs WHERE hash = ${hash}`;
        const body = blob ? await deps.store.get(hash) : null;
        if (body) content.push({ type: "file", mediaType: blob!.content_type, data: Buffer.from(await new Response(body).arrayBuffer()) });
      }
      messages.push({ role: "user", content });
      seen.add(row.id);
    }
    return messages;
  };
}
