import { test, expect, openExample, addAuthenticator, signUp, hydrated } from "./fixtures";

test("a view-only link opens the model read-only, signed out or not, until it's turned off", async ({ page, user, browser }) => {
  void user;
  const id = await openExample(page, "bracket", ["bracket"]);

  // turn link sharing on: the link is copied and shown
  await page.getByTestId("share-button").click();
  await page.getByTestId("share-dialog").getByRole("switch").click();
  const url = (await page.getByTestId("share-url").textContent())!.trim();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);

  // its link preview names the document
  const html = await (await page.request.get(url)).text();
  expect(html).toContain('property="og:title" content="Bracket"');

  // signed out: the model, read-only (no notes, history or edit tools)
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await anon.newPage();
  await guest.goto(url);
  await expect(guest.getByTestId("view-only")).toBeVisible();
  await guest.waitForFunction(() => (globalThis as any).__ws?.results?.bracket?.ok, null, { timeout: 45_000 });
  await expect(guest.getByRole("tab", { name: "History" })).toHaveCount(0);
  await expect(guest.getByRole("tab", { name: "Notes" })).toHaveCount(0);
  await expect(guest.getByRole("button", { name: "Note" })).toHaveCount(0);
  await expect(guest.getByTestId("share-sign-in")).toBeVisible();

  // a member opening the link lands in the full workspace
  await page.goto(url);
  await page.waitForURL(new RegExp(`/d/${id}$`));

  // off: the open guest sees the link die, and a fresh visit finds nothing
  await page.getByTestId("share-button").click();
  await page.getByTestId("share-dialog").getByRole("switch").click();
  await expect(guest.getByText("This link doesn't work anymore")).toBeVisible();
  await guest.goto(url);
  await expect(guest.getByTestId("share-not-found")).toBeVisible();
  await anon.close();
});

test("a signed-in non-member gets the view-only workspace", async ({ page, user, browser }) => {
  void user;
  await openExample(page, "bracket", ["bracket"]);
  await page.getByTestId("share-button").click();
  await page.getByTestId("share-dialog").getByRole("switch").click();
  const url = (await page.getByTestId("share-url").textContent())!.trim();

  const other = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:5173" });
  const bob = await other.newPage();
  await addAuthenticator(bob);
  await signUp(bob);
  await bob.goto(url);
  await hydrated(bob);
  await expect(bob.getByTestId("view-only")).toBeVisible();
  await expect(bob.getByRole("button", { name: "Account" })).toBeVisible();
  await bob.waitForFunction(() => (globalThis as any).__ws?.results?.bracket?.ok, null, { timeout: 45_000 });
  await other.close();
});
