import type { KeyboardEvent } from 'react';
import { nextOptionIndex } from '@renderer/components/settings/option-keys';

export interface SegmentedRadioGroupProps<T extends string> {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  disabled?: boolean;
  testId?: string;
  onChange: (value: T) => void;
}

const SEGMENT = 'h-[30px] rounded-lg px-3.5 text-[13px] transition-colors focus-visible:rounded-lg disabled:cursor-not-allowed';
const CHECKED = 'bg-[--accent-soft] font-medium text-[--accent-soft-text]';
const UNCHECKED = 'text-[--text] hover:bg-[--surface-hover]';
const DISABLED = 'text-[--text-muted]';

/**
 * Generic keyboard-operable radiogroup with roving focus and arrow keys, extracted from the
 * `ModeControl` pattern for any `T extends string` option set. `disabled` keeps every option
 * readable but un-interactive and out of the tab order.
 */
export function SegmentedRadioGroup<T extends string>({
  label,
  options,
  labels,
  value,
  disabled = false,
  testId,
  onChange,
}: SegmentedRadioGroupProps<T>) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;
    const currentIndex = options.indexOf(value);
    const nextIndex = nextOptionIndex(currentIndex, options.length, event.key);
    if (nextIndex === null) return;
    event.preventDefault();
    const next = options[nextIndex]!;
    onChange(next);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-option="${next}"]`)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className="inline-flex gap-0.5 rounded-[11px] bg-[--surface-field] p-[3px]"
    >
      {options.map((option) => {
        const checked = value === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={disabled}
            disabled={disabled}
            tabIndex={!disabled && checked ? 0 : -1}
            data-option={option}
            onClick={() => { if (!disabled) onChange(option); }}
            onKeyDown={onKeyDown}
            className={`${SEGMENT} ${disabled ? DISABLED : checked ? CHECKED : UNCHECKED}`}
          >
            {labels[option]}
          </button>
        );
      })}
    </div>
  );
}
