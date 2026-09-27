// Accessibility pass (M7): axe-core WCAG 2.1 A/AA checks on the main screens, light and dark.
import AxeBuilder from "@axe-core/playwright";
import { test, expect, openExample, hydrated } from "./fixtures";
import type { Page } from "@playwright/test";

async function audit(page: Page, label: string) {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    // the WebGL canvas and the engine iframe are not document content
    .exclude("canvas")
    .exclude("iframe[title='Parasocial engine']")
    .analyze();
  for (const v of r.violations) console.log(`${label}: ${v.id} (${v.impact}) ${v.help}\n  ${v.nodes.slice(0, 6).map((n) => n.target.join(" ") + " — " + (n.any[0]?.message ?? n.failureSummary ?? "").split("\n")[0].slice(0, 160)).join("\n  ")}`);
  return r.violations;
}

for (const scheme of ["light", "dark"] as const) {
  test(`a11y (${scheme}): sign-in, documents, workspace`, async ({ page, user }) => {
    void user;
    await page.emulateMedia({ colorScheme: scheme });
    const v: unknown[] = [];
    await page.goto("/");
    await hydrated(page);
    v.push(...(await audit(page, `${scheme} documents`)));
    await openExample(page, "bracket", ["bracket"]);
    v.push(...(await audit(page, `${scheme} workspace`)));
    await page.getByRole("tab", { name: "Params" }).click();
    v.push(...(await audit(page, `${scheme} params`)));
    await page.getByRole("tab", { name: "Notes" }).click();
    v.push(...(await audit(page, `${scheme} notes`)));
    await page.context().clearCookies();
    await page.goto("/signin");
    await hydrated(page);
    v.push(...(await audit(page, `${scheme} sign-in`)));
    expect(v.length).toBe(0);
  });
}
