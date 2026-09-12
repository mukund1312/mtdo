import type { Page } from "@playwright/test";

/**
 * Signal Deck now keeps destinations inside the selected navigation launcher.
 * Tests use the same visible interaction as a user: open Menu, then choose a
 * destination. Keeping this in one helper makes the launcher an explicit
 * contract rather than relying on a retired always-open dock.
 */
export async function openSignalDeckDestination(page: Page, destination: string) {
  const navigation = page.getByRole("navigation", { name: "Signal deck navigation" });
  await navigation.getByRole("button", { name: /open navigation menu/i }).click();
  await navigation.getByRole("button", { name: new RegExp(`^${destination}$`, "i") }).click();
}
