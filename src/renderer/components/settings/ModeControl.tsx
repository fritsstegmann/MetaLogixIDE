import type { KeyboardEvent } from 'react';
import type { ThemeMode } from '@renderer/hooks/useTheme';
import { MODE_ORDER, modeAfterKey } from '@renderer/components/settings/mode-keys';

interface Props {
  readonly mode: ThemeMode;
  readonly effective: 'light' | 'dark';
  readonly onChange: (mode: ThemeMode) => void;
}

const LABELS: Readonly<Record<ThemeMode, string>> = { system: 'System', light: 'Light', dark: 'Dark' };

const SEGMENT = 'h-[30px] rounded-lg px-3.5 text-[13px] transition-colors focus-visible:rounded-lg';
const CHECKED = 'bg-[--accent-soft] font-medium text-[--accent-soft-text]';
const UNCHECKED = 'text-[--text] hover:bg-[--surface-hover]';

/**
 * Appearance mode radiogroup ("Mode"): System / Light / Dark as roving-tabindex radios.
 * Clicking or arrowing applies the mode through `onChange` and moves focus with it; the
 * System radio names the `effective` theme in a suffix that inherits the segment colour.
 */
export function ModeControl({ mode, effective, onChange }: Props) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    const next = modeAfterKey(mode, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  }

  return (
    <div role="radiogroup" aria-label="Mode" className="inline-flex gap-0.5 rounded-[11px] bg-[--surface-field] p-[3px]">
      {MODE_ORDER.map((m) => {
        const checked = mode === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-mode={m}
            onClick={() => onChange(m)}
            onKeyDown={onKeyDown}
            className={`${SEGMENT} ${checked ? CHECKED : UNCHECKED}`}
          >
            {LABELS[m]}
            {m === 'system' && <span className="font-normal">{` · ${effective}`}</span>}
          </button>
        );
      })}
    </div>
  );
}
