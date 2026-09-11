import { expect, test } from "@playwright/test";

type Rect = { left: number; top: number; right: number; bottom: number };

function overlaps(first: Rect, second: Rect) {
  return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
}

async function closeWalkthroughIfPresent(page: import("@playwright/test").Page) {
  const close = page.getByRole("button", { name: /close walkthrough/i });
  if (await close.count()) await close.click();
}

test("Signal Deck persistent controls share a collision-free mobile safe area", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/architecture-02?deck=listen");
  await closeWalkthroughIfPresent(page);
  await page.getByRole("tab", { name: "Radio" }).click();

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    };

    return {
      audio: rect(".a02-audio"),
      dock: rect(".a02-dock"),
      feedback: rect('[aria-label="Send feedback"]'),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });

  expect(geometry.horizontalOverflow).toBe(false);
  expect(geometry.audio).not.toBeNull();
  expect(geometry.dock).not.toBeNull();
  expect(geometry.feedback).not.toBeNull();
  expect(overlaps(geometry.audio!, geometry.dock!)).toBe(false);
  expect(overlaps(geometry.feedback!, geometry.audio!)).toBe(false);
  expect(overlaps(geometry.feedback!, geometry.dock!)).toBe(false);
  expect(await page.getByRole("button", { name: /ask anything|open tutor copilot/i }).count()).toBe(0);
});

test("Onboarding keeps Feedback in the header and opens it as a modal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/architecture-02/onboarding");

  const trigger = page.getByRole("button", { name: "Send feedback" });
  await expect(trigger).toBeVisible();
  const triggerBottom = await trigger.evaluate((element) => element.getBoundingClientRect().bottom);
  expect(triggerBottom).toBeLessThan(70);

  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Send feedback" })).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("button", { name: "Close feedback form" }).first()).toBeVisible();
});
