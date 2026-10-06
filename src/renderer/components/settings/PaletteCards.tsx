import type { ThemePalette } from '@renderer/hooks/useTheme';
import { CheckIcon } from '@renderer/components/CheckIcon';
import { PALETTE_SWATCHES } from '@renderer/components/settings/palette-swatches';

interface Props {
  readonly palette: ThemePalette;
  readonly effective: 'light' | 'dark';
  readonly onSelect: (palette: ThemePalette) => void;
}

const PALETTES = Object.keys(PALETTE_SWATCHES) as ThemePalette[];

const CARD = 'pressable flex w-[152px] flex-col items-stretch gap-[9px] rounded-xl p-2.5 text-left text-[13px] transition-colors focus-visible:rounded-xl';
const SELECTED = 'bg-[--accent-soft] shadow-[inset_0_0_0_1.5px_var(--accent)]';
const UNSELECTED = 'bg-[--surface-field] hover:bg-[--surface-active]';

/**
 * Palette picker: one `aria-pressed` button per palette, each previewing its own swatch set for
 * the `effective` theme. The selected card gets the accent-soft fill, an inset accent ring and a
 * decorative check, so its accessible name stays the palette label. Emits `onSelect(palette)`.
 */
export function PaletteCards({ palette, effective, onSelect }: Props) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {PALETTES.map((id) => {
        const selected = palette === id;
        const { label } = PALETTE_SWATCHES[id];
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(id)}
            className={`${CARD} ${selected ? SELECTED : UNSELECTED}`}
          >
            <span aria-hidden="true" className="flex h-[26px] overflow-hidden rounded-[7px]">
              {PALETTE_SWATCHES[id][effective].map((colour) => (
                <span key={colour} className="flex-1" style={{ background: colour }} />
              ))}
            </span>
            {selected ? (
              <span className="flex items-center justify-between font-medium text-[--accent-soft-text]">
                {label}
                <CheckIcon size={13} />
              </span>
            ) : (
              <span className="text-[--text]">{label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
