import type { Locator, Page } from "@playwright/test";

// Native HTML5 drag-and-drop (calendar-deck.tsx's draggable=true elements,
// onDragStart/onDragOver/onDrop) driven through Playwright's own dragTo() --
// which simulates a real OS-level mouse gesture and relies on the browser's
// internal native-DnD recognition -- has been observed unreliable
// specifically in CI's headless Chromium: the whole gesture silently fails
// to register at all (confirmed via CI screenshot/video artifacts -- the
// dragged block stays in Unscheduled, the grid stays empty, no [calendar]
// console log ever fires), not merely slow. Not reproducible locally, where
// the same interaction consistently works.
//
// This dispatches the four DragEvents the app's own handlers listen for
// directly, against a single real DataTransfer instance shared across all
// four -- the same recipe Playwright's own docs recommend for HTML5 DnD
// reliability (playwright.dev/docs/input#dragging-manually). It bypasses
// the browser's native drag-gesture recognition entirely, so it doesn't
// depend on however that behaves under a loaded, headless CI runner.
export async function dragAndDrop(page: Page, source: Locator, target: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await source.dispatchEvent("dragend", { dataTransfer });
}
