// Shared E2E helpers: virtual passkeys, a signed-up user, an opened example document.
import { test as base, expect, type Page } from "@playwright/test";

export async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

export const hydrated = (page: Page) => page.locator("html[data-hydrated]").waitFor();

let n = 0;
export const uniqueName = (p = "Tester") => `${p} ${Date.now().toString(36)}${n++}`;

export async function signUp(page: Page, name = uniqueName()) {
  await page.goto("/signin");
  await hydrated(page);
  if (await page.getByTestId("to-signup").isVisible()) await page.getByTestId("to-signup").click();
  await page.getByTestId("name").fill(name);
  await page.getByTestId("create-account").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
  await hydrated(page);
  return name;
}

export async function openExample(page: Page, slug: string, parts: string[]) {
  await page.getByTestId(`example-${slug}`).click();
  await page.waitForURL(/\/d\//);
  await page.waitForFunction((ps) => {
    const ws = (globalThis as any).__ws;
    return ws?.kernelReady && ps.every((p: string) => ws.results?.[p] && !ws.results[p].empty) && Object.values(ws.regen ?? {}).every((s) => s === "idle");
  }, parts, { timeout: 45_000 });
  await page.waitForTimeout(300);
  return page.url().split("/d/")[1];
}

export async function viewportPoint(page: Page, fx: number, fy: number) {
  const b = (await page.getByTestId("viewport").boundingBox())!;
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}

export const ws = <T>(page: Page, fn: (ws: any) => T) => page.evaluate(fn as any, undefined) as Promise<T>;
export const wsEval = <T>(page: Page, src: string): Promise<T> => page.evaluate(`(() => { const ws = globalThis.__ws; return ${src}; })()`);

type Fixtures = { user: string };
export const test = base.extend<Fixtures>({
  user: async ({ page }, use) => {
    await addAuthenticator(page);
    await use(await signUp(page));
  },
});
export { expect };
