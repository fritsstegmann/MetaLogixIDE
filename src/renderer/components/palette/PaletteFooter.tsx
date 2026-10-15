/**
 * The command palette's footer: the prefix legend ("@ Files", "# Projects", "> Commands", each prefix
 * in a `kbd` tinted with its own hue, AC40) on the left and the navigate / open / close key hints,
 * each key in a chip, on the right. Shown in every mode; wraps onto two lines in a narrow window.
 */
import { PALETTE_COPY, PALETTE_TESTIDS } from '@renderer/command-palette-contract';

const KEY_HINTS = [
  { key: '↑↓', label: PALETTE_COPY.keyHints.navigate },
  { key: '↩', label: PALETTE_COPY.keyHints.open },
  { key: 'esc', label: PALETTE_COPY.keyHints.close },
] as const;

/** One hue per prefix, matching the sidebar's root-folder palette. */
const PREFIX_HUE: Record<string, string> = { '@': 'var(--hue-cyan)', '#': 'var(--hue-purple)', '>': 'var(--hue-yellow)' };

export function PaletteFooter(): React.JSX.Element {
  return (
    <div className="palette-footer flex min-h-[44px] shrink-0 flex-wrap items-center justify-between gap-x-5 gap-y-1 px-[18px] py-2 text-[12.5px] text-[--modal-text-muted]">
      <div data-testid={PALETTE_TESTIDS.legend} className="flex items-center gap-4">
        {PALETTE_COPY.legend.map(({ prefix, label }) => (
          <span key={prefix} className="flex items-center gap-1.5">
            <kbd className="palette-prefix" style={{ color: PREFIX_HUE[prefix] }}>{prefix}</kbd>
            {label}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-4">
        {KEY_HINTS.map(({ key, label }) => (
          <span key={key} className="flex items-center gap-2">
            <kbd>{key}</kbd>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
