import { readFileSync } from "node:fs";
import { test, expect, openExample } from "./fixtures";

test("the export dialog makes a drawing, as PDF and SVG", async ({ page, user }) => {
  void user;
  await openExample(page, "bracket", ["bracket"]);
  await page.keyboard.press("ControlOrMeta+e");
  const dialog = page.getByTestId("export-dialog");
  await dialog.getByRole("radio", { name: "Drawing" }).click();
  await expect(dialog).toContainText("isometric views");
  await page.screenshot({ path: "test-results/export-drawing.png" });

  // PDF (the default), with a section
  await dialog.getByRole("button", { name: "Section view" }).click();
  await page.getByRole("option", { name: "Section parallel to the front" }).click();
  let download = page.waitForEvent("download");
  await page.getByTestId("export-go").click();
  let file = await download;
  expect(file.suggestedFilename()).toBe("Bracket drawing.pdf");
  const pdf = readFileSync((await file.path())!);
  expect(pdf.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");

  // SVG
  await page.keyboard.press("ControlOrMeta+e");
  await dialog.getByRole("radio", { name: "Drawing" }).click();
  await dialog.getByRole("radio", { name: "SVG" }).click();
  download = page.waitForEvent("download");
  await page.getByTestId("export-go").click();
  file = await download;
  expect(file.suggestedFilename()).toBe("Bracket drawing.svg");
  const svg = readFileSync((await file.path())!, "utf8");
  expect(svg).toContain("<svg");
  expect(svg).toContain(">Bracket<");
  await page.setContent(svg);
  await page.screenshot({ path: "test-results/export-drawing-svg.png" });
});

test("BOM as CSV from the export dialog", async ({ page, user }) => {
  void user;
  await openExample(page, "bracket", ["bracket"]);
  await page.keyboard.press("ControlOrMeta+e");
  const dialog = page.getByTestId("export-dialog");
  await dialog.getByRole("radio", { name: "BOM" }).click();
  const download = page.waitForEvent("download");
  await page.getByTestId("export-go").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/BOM\.csv$/);
  const csv = readFileSync((await file.path())!, "utf8").split("\r\n");
  expect(csv[0]).toMatch(/^Item,Part number,Name,/);
  expect(csv[1]).toContain(",Bracket,");
});
