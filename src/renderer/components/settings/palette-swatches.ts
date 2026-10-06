import type { ThemePalette } from '@renderer/hooks/useTheme';

/** Four preview colours, left to right: base, accent, green, highlight. */
export type SwatchSet = readonly [string, string, string, string];

/**
 * Palette card preview data (spec AC15a). These literals are data, not chrome:
 * each card previews its own palette whichever palette is active, so they
 * cannot be read from the live theme tokens.
 */
export const PALETTE_SWATCHES: Readonly<
  Record<ThemePalette, { readonly label: string; readonly dark: SwatchSet; readonly light: SwatchSet }>
> = {
  default: {
    label: 'Default',
    dark: ['#1c2028', '#3b82f6', '#22c55e', '#fbbf24'],
    light: ['#eceef3', '#2563eb', '#16a34a', '#d97706'],
  },
  catppuccin: {
    label: 'Catppuccin',
    dark: ['#1e1e2e', '#89b4fa', '#a6e3a1', '#f5c2e7'],
    light: ['#eff1f5', '#1e66f5', '#40a02b', '#ea76cb'],
  },
  'rose-pine': {
    label: 'Rosé Pine',
    dark: ['#191724', '#c4a7e7', '#9ccfd8', '#f6c177'],
    light: ['#faf4ed', '#907aa9', '#56949f', '#ea9d34'],
  },
};
