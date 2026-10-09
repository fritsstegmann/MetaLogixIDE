/**
 * The app's icon size scale. Every UI icon takes its width and height from
 * `ICON_SIZE`, never from a numeric literal. Pick the size from the icon's
 * context: xs in a 16 px control, sm in a 20-24 px button or beside 11-12 px
 * text, md (the default) in a 28-32 px button or beside 13-14 px text, lg in
 * a 36 px button, xl in a 40 px tile.
 */
export const ICON_SIZE = { xs: 10, sm: 12, md: 14, lg: 16, xl: 20 } as const;

/** A size on the scale; an icon `size` prop typed with it rejects off-scale values such as 13. */
export type IconSize = (typeof ICON_SIZE)[keyof typeof ICON_SIZE];

/**
 * Stroke widths for outline icons: 2 by default, 2.5 for icons drawn at xs so
 * they stay legible, 3 for the shared selected check (`CheckIcon`).
 */
export const ICON_STROKE = { outline: 2, xs: 2.5, check: 3 } as const;

/** The outline stroke for an icon drawn at `size`: 2.5 at xs, otherwise 2. */
export function iconStroke(size: IconSize): number {
  return size === ICON_SIZE.xs ? ICON_STROKE.xs : ICON_STROKE.outline;
}
