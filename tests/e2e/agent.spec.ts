import { test, expect, openExample, viewportPoint, wsEval } from "./fixtures";

// Built-in agent: provider settings, per-document auto hand-off, and handing a note over. The
// provider points at a closed port, so the run fails fast and says so in the thread.

test("set up the built-in agent, hand it a note, and see the run report back", async ({ page, user }) => {
  void user;
  await page.goto("/settings");
  const section = page.getByTestId("builtin-agent");
  await expect(section).toBeVisible();
  await section.getByRole("button", { name: "Provider" }).click();
  await page.getByRole("option", { name: /OpenAI-compatible/ }).click();
  await section.getByPlaceholder(/qwen3-coder/).fill("test-model");
  await section.getByPlaceholder("http://localhost:11434/v1").fill("http://127.0.0.1:9/v1");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("button", { name: "Test connection" })).toBeVisible();

  await page.goto("/");
  await openExample(page, "bracket", ["bracket"]);

  // Properties > Document: the auto hand-off switch
  await expect(page.getByText("Agent pickup")).toBeVisible();

  // post a note, then hand it over from its menu
  await page.keyboard.press("c");
  const p = await viewportPoint(page, 0.62, 0.55);
  await page.mouse.click(p.x, p.y);
  await page.getByTestId("note-text").fill("Make the wall 4 mm");
  await page.keyboard.press("Enter");
  await expect.poll(() => wsEval<number>(page, "ws.notes.length")).toBe(1);
  const card = page.getByTestId("note-card").first();
  await card.getByRole("button", { name: "Note actions" }).click();
  await page.getByRole("menuitem", { name: "Hand to agent" }).click();
  await expect.poll(() => wsEval<string | null>(page, "ws.notes[0].agentAssignedBy")).toBeTruthy();

  // the built-in agent claims it, can't reach the provider, and gives it back with the reason
  await expect(card.getByText(/Stopped on an error from the model provider/)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => wsEval<string>(page, "ws.notes[0].status")).toBe("Open");

  await card.getByRole("button", { name: "Note actions" }).click();
  await page.getByRole("menuitem", { name: "Take back from agent" }).click();
  await expect.poll(() => wsEval<string | null>(page, "ws.notes[0].agentAssignedBy ?? null")).toBeNull();
});
