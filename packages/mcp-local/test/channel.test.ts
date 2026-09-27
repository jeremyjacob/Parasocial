import { describe, expect, test } from "bun:test";
import { noteEvent } from "../src/channel";

const note = (reason: object) => ({ id: "n1", number: 3, document: { id: "d1", name: "Bracket" }, messages: [{ kind: "message", from: "Ada", text: "Make it\n 5 mm   thick" }], reason });

describe("noteEvent", () => {
  test("new note: summary line from the first message, full note after", () => {
    const e = noteEvent(note({ created: true }));
    expect(e.meta).toEqual({ document_id: "d1", note_id: "n1", kind: "created" });
    expect(e.content.split("\n")[0]).toBe("New note #3 in Bracket from Ada: Make it 5 mm thick");
    expect(JSON.parse(e.content.slice(e.content.indexOf("\n\n") + 2))).toMatchObject({ id: "n1", reason: { created: true } });
  });

  test("replies: latest reply, with a count of the rest", () => {
    const e = noteEvent(note({ replies: [{ author: "Ada", text: "a" }, { author: null, text: "b" }] }));
    expect(e.meta.kind).toBe("reply");
    expect(e.content.split("\n")[0]).toBe("Someone replied on note #3 in Bracket: b (+1 more)");
  });

  test("meta keys are identifiers (Claude Code drops others)", () => {
    for (const k of Object.keys(noteEvent(note({ created: true })).meta)) expect(k).toMatch(/^[A-Za-z0-9_]+$/);
  });
});
