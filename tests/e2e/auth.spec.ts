import { test, expect } from "@playwright/test";
import { addAuthenticator, signUp, hydrated, uniqueName } from "./fixtures";

test.describe("passkey accounts", () => {
  test("sign up with a name and a passkey, sign out, sign back in with the passkey", async ({ page }) => {
    await addAuthenticator(page);
    const name = await signUp(page, uniqueName("Ada"));
    await expect(page).toHaveURL("/");
    await page.getByTestId("account-menu").click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/signin/);
    await hydrated(page);
    // sign-in is one button; the virtual authenticator holds the passkey
    await expect(page.getByTestId("name")).toHaveCount(0);
    await page.getByTestId("signin-passkey").click();
    await page.waitForURL("/");
    const res = await page.request.get("/api/auth/session");
    expect((await res.json()).user.name).toBe(name);
  });

  test("the workspace requires sign-in", async ({ page }) => {
    const res = await page.goto("/d/does-not-matter");
    await expect(page).toHaveURL(/\/signin\?next=/);
    expect(res?.ok()).toBe(true);
  });

  test("a second passkey can be added in settings (from another device)", async ({ page }) => {
    const first = await addAuthenticator(page);
    await signUp(page);
    // the same authenticator is excluded (it already holds a passkey): switch to a second device
    await first.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: first.authenticatorId });
    await addAuthenticator(page);
    await page.goto("/settings");
    await hydrated(page);
    await expect(page.getByTestId("passkeys").locator("li")).toHaveCount(1);
    await page.getByRole("button", { name: "Add passkey" }).click();
    await expect(page.getByTestId("passkeys").locator("li")).toHaveCount(2);
  });
});
