/**
 * The command palette's footer: the prefix legend ("@ files", "# projects", "> commands", each prefix
 * in a `kbd`, AC40) on the left and the navigate / open / close key hints on the right. Shown in
 * every mode; wraps onto two lines in a narrow window.
 */
import { PALETTE_COPY, PALETTE_TESTIDS } from '@renderer/command-palette-contract';

const KEY_HINTS = [
  { key: '↑↓', label: PALETTE_COPY.keyHints.navigate },
  { key: '↩', label: PALETTE_COPY.keyHints.open },
  { key: 'Esc', label: PALETTE_COPY.keyHints.close },
] as const;

export function PaletteFooter(): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-[11px] text-[--modal-text-muted] shadow-[inset_0_0.5px_0_var(--modal-hairline)]">
      <div data-testid={PALETTE_TESTIDS.legend} className="flex items-center gap-3">
        {PALETTE_COPY.legend.map(({ prefix, label }) => (
          <span key={prefix} className="flex items-center gap-1">
            <kbd>{prefix}</kbd>
            {label}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-3">
        {KEY_HINTS.map(({ key, label }) => (
          <span key={key} className="flex items-center gap-1">
            <kbd>{key}</kbd>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
