import { expect, test } from "@playwright/test";

test("navigation wheel opens on its first click and M toggles it", async ({ page }) => {
  await page.goto("/architecture-02?nav=5");
  const walkthroughClose = page.getByRole("button", { name: /close walkthrough/i });
  if (await walkthroughClose.isVisible().catch(() => false)) await walkthroughClose.click();

  const trigger = page.getByRole("button", { name: /open navigation wheel/i });
  const wheel = page.getByRole("dialog", { name: "Navigation wheel" });

  await trigger.click();
  await expect(wheel).toBeVisible();
  await expect(page.getByRole("button", { name: /close navigation wheel/i })).toBeVisible();

  await page.keyboard.press("m");
  await expect(wheel).toBeHidden();

  await page.keyboard.press("m");
  await expect(wheel).toBeVisible();
  await page.keyboard.press("m");
  await expect(wheel).toBeHidden();
});
