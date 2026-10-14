/**
 * One 14px stroke icon per command category for the palette's command rows (design contract 7).
 * Decorative: the row's title carries the meaning, so every icon is hidden from assistive tech.
 * `CategoryIcon` picks the icon for a category; `SearchIcon` is the 16px glyph beside the input.
 */
import type { ReactNode } from 'react';
import type { PaletteCategory } from '@renderer/command-palette-contract';

const PATHS: Record<PaletteCategory, ReactNode> = {
  Go: (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  Project: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  View: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  Shell: (
    <>
      <path d="m5 7 5 5-5 5" />
      <path d="M12 17h7" />
    </>
  ),
  Theme: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" />
    </>
  ),
  App: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </>
  ),
  Settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
};

interface IconProps {
  readonly size: number;
  readonly children: ReactNode;
}

function StrokeIcon({ size, children }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-[--modal-text-muted]"
    >
      {children}
    </svg>
  );
}

export function CategoryIcon({ category }: { readonly category: PaletteCategory }): React.JSX.Element {
  return <StrokeIcon size={14}>{PATHS[category]}</StrokeIcon>;
}

export function SearchIcon(): React.JSX.Element {
  return (
    <StrokeIcon size={16}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </StrokeIcon>
  );
}
