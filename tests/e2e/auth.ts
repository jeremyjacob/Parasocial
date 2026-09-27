// Passkeys in Playwright: a CDP virtual authenticator (resident keys, auto user verification).
import type { BrowserContext, Page } from "playwright";

export async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

export async function signUp(page: Page, name: string, base = "http://localhost:5173") {
  await page.goto(`${base}/signin`);
  if (await page.getByTestId("to-signup").isVisible().catch(() => false)) await page.getByTestId("to-signup").click();
  await page.getByTestId("name").fill(name);
  await page.getByTestId("create-account").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 20000 });
}

export async function signIn(page: Page, base = "http://localhost:5173") {
  await page.goto(`${base}/signin`);
  await page.getByTestId("signin-passkey").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 20000 });
}

export type { BrowserContext };
