import { test, expect, openExample, hydrated } from "./fixtures";

test("empty documents list offers examples; an example opens as a new document", async ({ page, user }) => {
  void user;
  await expect(page.getByTestId("examples")).toBeVisible();
  await openExample(page, "flange", ["flange"]);
  await page.goto("/");
  await hydrated(page);
  await expect(page.getByTestId("document-card")).toHaveCount(1);
});

test("create an empty document, add a studio", async ({ page, user }) => {
  void user;
  await page.getByTestId("new-document").click();
  await page.getByTestId("new-document-name").fill("Widget");
  await page.getByTestId("create-document").click();
  await page.waitForURL(/\/d\//);
  await expect(page.getByTestId("empty-document")).toBeVisible();
  await page.getByTestId("add-studio").click();
  await page.getByTestId("new-studio-blank").click();
  await page.waitForFunction(() => (globalThis as any).__ws?.results?.studio1?.ok, null, { timeout: 45_000 });
  await expect(page.getByTestId("parts-panel")).toContainText("Studio 1");
  await page.getByTestId("parts-panel").getByRole("button", { name: "Expand Studio 1" }).click();
  await expect(page.getByTestId("parts-panel")).toContainText("Part 1");
});

test("export as zip, then import it back", async ({ page, user }) => {
  void user;
  const id = await openExample(page, "bracket", ["bracket"]);
  const zip = await page.request.get(`/api/documents/${id}/export`);
  expect(zip.ok()).toBe(true);
  const bytes = await zip.body();
  const imp = await page.request.post("/api/documents/import", { data: bytes, headers: { "Content-Type": "application/zip" } });
  expect(imp.ok()).toBe(true);
  const body = await imp.json();
  expect(body.id ?? body.documentID).toBeTruthy();
});

test("documents grid: click selects, ⌘/⇧ extend, double-click opens", async ({ page, user }) => {
  void user;
  await openExample(page, "flange", ["flange"]);
  await page.goto("/");
  await hydrated(page);
  await openExample(page, "bracket", ["bracket"]);
  await page.goto("/");
  await hydrated(page);
  const cards = page.getByTestId("document-card");
  await expect(cards).toHaveCount(2);
  await cards.nth(0).click();
  await expect(cards.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(cards.nth(1)).toHaveAttribute("aria-selected", "false");
  await cards.nth(1).click({ modifiers: ["Meta"] });
  await expect(page.locator('[data-testid="document-card"][aria-selected="true"]')).toHaveCount(2);
  await cards.nth(1).click();
  await cards.nth(0).click({ modifiers: ["Shift"] });
  await expect(page.locator('[data-testid="document-card"][aria-selected="true"]')).toHaveCount(2);
  await page.mouse.click(5, 300);
  await expect(page.locator('[data-testid="document-card"][aria-selected="true"]')).toHaveCount(0);
  await cards.nth(0).dblclick();
  await page.waitForURL(/\/d\//);
});

test("context menu renames and deletes documents; examples select like documents", async ({ page, user }) => {
  void user;
  const ex = page.getByTestId("example-bracket");
  await ex.click();
  await expect(ex).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/$/);
  await openExample(page, "bracket", ["bracket"]);
  await page.goto("/");
  await hydrated(page);
  const card = page.getByTestId("document-card");
  await card.click({ button: "right" });
  await expect(card).toHaveAttribute("aria-selected", "true");
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await expect(page.getByTestId("rename-document-name")).toBeFocused();
  await page.keyboard.type("Renamed bracket");
  await page.getByTestId("rename-document").click();
  await expect(card).toContainText("Renamed bracket");
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete 1 document?" });
  await expect(confirmation).toContainText("This can't be undone.");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toHaveCount(1);
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(card).toHaveCount(0);
});

test("documents list shows a render of each document once its geometry settles", async ({ page, user }) => {
  void user;
  const id = await openExample(page, "enclosure", ["enclosure", "enclosure:lid", "mount"]);
  await page.waitForFunction(() => (globalThis as any).__ws?.doc?.thumbLight, null, { timeout: 20_000 });
  await page.goto("/");
  await hydrated(page);
  const img = page.getByTestId("document-card").first().getByTestId("document-thumb");
  await expect(img).toHaveAttribute("src", new RegExp(`/api/blobs/[0-9a-f]{64}\\?doc=${id}`));
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(640);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.getByTestId("document-card").first().screenshot({ path: "test-results/document-thumb-dark.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.getByTestId("document-card").first().screenshot({ path: "test-results/document-thumb.png" });
});

test("workspace deletion dialogs cancel safely and delete only on confirmation", async ({ page, user }) => {
  void user;
  await openExample(page, "bracket", ["bracket"]);
  // the studio row (the part inside it is also named Bracket)
  const studio = page.getByTestId("parts-panel").getByRole("button", { name: "Bracket", exact: true }).first();
  await studio.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete studio", exact: true }).click();
  const confirmation = page.getByRole("dialog");
  await expect(confirmation).toContainText("You can restore it from History.");
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(studio).toBeVisible();
  await studio.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete studio", exact: true }).click();
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(studio).toHaveCount(0);

  const documentMenu = page.locator("header").getByRole("button", { name: "Bracket", exact: true });
  await documentMenu.click();
  await page.getByRole("menuitem", { name: "Delete document", exact: true }).click();
  await expect(confirmation).toContainText("This can't be undone.");
  await confirmation.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/d\//);
  await documentMenu.click();
  await page.getByRole("menuitem", { name: "Delete document", exact: true }).click();
  await confirmation.screenshot({ path: "test-results/delete-confirmation.png" });
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForURL(/\/$/);
  await expect(page.getByTestId("document-card")).toHaveCount(0);
});

test("Delete key confirms the selected documents and Escape cancels", async ({ page, user }) => {
  void user;
  for (const name of ["First", "Second"]) {
    await page.getByTestId("new-document").click();
    await page.getByTestId("new-document-name").fill(name);
    await page.getByTestId("create-document").click();
    await page.waitForURL(/\/d\//);
    await page.getByTestId("home-logo").click();
    await hydrated(page);
  }
  const cards = page.getByTestId("document-card");
  await expect(cards).toHaveCount(2);
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ["Meta"] });
  await page.keyboard.press("Delete");
  const confirmation = page.getByRole("dialog", { name: "Delete 2 documents?" });
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  await cards.nth(1).focus();
  await page.keyboard.press("Delete");
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(cards).toHaveCount(0);
});

test("building a studio with no agent asks for one, then carries on", async ({ page, user }) => {
  void user;
  await page.getByTestId("new-document").click();
  await page.getByTestId("new-document-name").fill("Hook");
  await page.getByTestId("create-document").click();
  await page.waitForURL(/\/d\//);
  await page.getByTestId("add-studio").click();
  await page.getByTestId("new-studio-prompt").fill("A wall hook");
  await page.getByTestId("new-studio-submit").click();
  const setup = page.getByTestId("agent-setup-dialog");
  await expect(setup).toBeVisible();
  await setup.getByRole("button", { name: "Provider" }).click();
  await page.getByRole("option", { name: /OpenAI-compatible/ }).click();
  await setup.getByPlaceholder(/qwen3-coder/).fill("test-model");
  await setup.getByPlaceholder("http://localhost:11434/v1").fill("http://127.0.0.1:9/v1");
  await page.getByTestId("agent-setup-save").click();
  await expect(setup).toBeHidden();
  await expect.poll(() => page.evaluate(() => (globalThis as any).__ws?.notes?.[0]?.agentAssignedBy), { timeout: 45_000 }).toBeTruthy();
  await expect(page.getByTestId("new-studio")).toBeHidden();
});
