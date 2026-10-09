/**
 * Small geometry helpers for `icon-sizes.spec.ts`
 * (docs/specs/icon-sizes.md AC3, AC5-AC9, AC13).
 *
 * Mirrors the local `box`/`expectPx` helpers already duplicated in
 * `chrome-dimensions.spec.ts`, `settings-board.spec.ts` and
 * `sidebar-add-menu.spec.ts`; factored out here since this is a new spec
 * with no existing local copy to match.
 */
import { expect, type Locator } from '@playwright/test';

/**
 * Waits for every running CSS transition/animation under `root` to finish —
 * the modal open scale/fade (`.modal-panel`, `--ease-out` 200ms, scale from
 * 0.96) and the menu open scale/fade (`menuMotion`, scale from 0.97). A box
 * read mid-transition is interpolated, not the resting size (verified: a
 * 16px icon mid-`.modal-panel` transition measured 16*0.96=15.36; a 20px
 * slot mid-`menuMotion` measured 20*0.97=19.4 — both match the scale
 * factor exactly). Mirrors `settings-board.spec.ts`'s local `settle()`.
 */
export async function settle(root: Locator): Promise<void> {
  await root.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))),
  );
}

export interface Box { x: number; y: number; width: number; height: number }

/** A locator's bounding box in CSS px; throws if the element is not rendered. */
export async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error('element has no bounding box (not rendered)');
  return b;
}

/** Asserts `actual` is within `tolerance` px of `expected` (default 0.5, the spec's rendered-size tolerance). */
export function expectPx(actual: number, expected: number, what: string, tolerance = 0.5): void {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

/**
 * Asserts an icon's box is `size`x`size` (±0.5px on both axes). Polls via
 * `toPass` rather than reading once: `settle()` catches the `.modal-panel`
 * CSS scale transition (a real Web Animation), but the NewShellMenu's
 * `menuMotion` scale is driven by `motion/react`'s own RAF engine, which
 * `Element.getAnimations()` does not always surface — so `settle()` alone is
 * not sufficient there, and this is the belt-and-suspenders fix that works
 * regardless of which engine is driving a given transition.
 */
export async function expectIconSize(icon: Locator, size: number, what: string): Promise<void> {
  await expect(async () => {
    const b = await box(icon);
    expectPx(b.width, size, `${what} width`);
    expectPx(b.height, size, `${what} height`);
  }).toPass({ timeout: 2000 });
}

/** Asserts an icon's centre sits within 0.5px of its containing box's centre, on both axes (AC13). Polled — see `expectIconSize`. */
export async function expectCentred(icon: Locator, container: Locator, what: string): Promise<void> {
  await expect(async () => {
    const i = await box(icon);
    const c = await box(container);
    const iCentreX = i.x + i.width / 2;
    const iCentreY = i.y + i.height / 2;
    const cCentreX = c.x + c.width / 2;
    const cCentreY = c.y + c.height / 2;
    expectPx(iCentreX, cCentreX, `${what} centre x`);
    expectPx(iCentreY, cCentreY, `${what} centre y`);
  }).toPass({ timeout: 2000 });
}
