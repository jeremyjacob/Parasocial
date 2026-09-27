import { test, expect, openExample, hydrated } from "./fixtures";

test("empty documents list offers examples; an example opens as a new document", async ({ page, user }) => {
  void user;
  await expect(page.getByTestId("examples")).toBeVisible();
  await openExample(page, "flange", ["flange"]);
  await page.goto("/");
  await hydrated(page);
  await expect(page.getByTestId("document-card")).toHaveCount(1);
});

test("create an empty document, add a part", async ({ page, user }) => {
  void user;
  await page.getByTestId("new-document").click();
  await page.getByTestId("new-document-name").fill("Widget");
  await page.getByTestId("create-document").click();
  await page.waitForURL(/\/d\//);
  await expect(page.getByTestId("empty-document")).toBeVisible();
  await page.getByTestId("add-part").click();
  await page.waitForFunction(() => (globalThis as any).__ws?.results?.part1?.ok, null, { timeout: 45_000 });
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
