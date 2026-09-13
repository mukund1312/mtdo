import { expect, test, type Page } from "@playwright/test";

// ONE shared page/anonymous session for the whole file (test.describe.serial
// + a manually created page -- the pattern phase6b-calendar-editing.spec.ts
// and session-rpc-contract.spec.ts already established) rather than two
// fresh sign-ins. Neither test here depends on plan/account state, so
// sharing costs nothing -- both are pure layout checks on a fresh
// anonymous visit, just to different routes with different viewport setup,
// which a shared page can still do per-test.

type Rect = { left: number; top: number; right: number; bottom: number };

function overlaps(first: Rect, second: Rect) {
  return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
}

async function closeWalkthroughIfPresent(page: Page) {
  const close = page.getByRole("button", { name: /close walkthrough/i });
  if (await close.count()) await close.click();
}

test.describe.serial("Fixed-layer safety", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("Signal Deck persistent controls share a collision-free mobile safe area", async () => {
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
        dock: rect(".a02-radial-menu-trigger"),
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

  test("Onboarding keeps Feedback in the header and opens it as a modal", async () => {
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
});
