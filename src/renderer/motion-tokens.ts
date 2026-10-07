/**
 * Durations (seconds, as motion takes them) and easings for the pane folds
 * and menus. The spec bounds each value; tune within the bound.
 */

/** In-out sine: even, not front-loaded, so half the duration ≈ half the distance (AC42, AC43). */
export const PANE_EASE = [0.37, 0, 0.63, 1] as const;
/** Pane fold enter; AC43 requires ≤ 0.32. */
export const PANE_ENTER_S = 0.28;
/** Pane fold exit; AC43 requires 0.18–0.32. */
export const PANE_EXIT_S = 0.26;
/** Opacity fade for panes and menus under reduced motion; AC56 requires ≥ 0.15. */
export const REDUCED_FADE_S = 0.18;

/** Equals --ease-out in styles.css (AC50). */
export const MENU_EASE = [0.23, 1, 0.32, 1] as const;
/** Menu enter; AC50 requires ≤ 0.2. */
export const MENU_ENTER_S = 0.16;
/** Menu exit; AC50 requires ≤ 0.2. */
export const MENU_EXIT_S = 0.14;
/** Menu opacity under reduced motion; AC56 requires ≥ 0.15. */
export const MENU_FADE_MIN_S = 0.16;
/** Menu start/end scale; AC50 requires ≥ 0.95. */
export const MENU_SCALE_FROM = 0.97;
