import { useId, type ChangeEvent, type JSX } from 'react';
import { TERMINAL_FONT_WEIGHTS, parseTerminalFontWeight } from '@shared/terminal-font-weight';
import { FONT_COPY, FONT_TEST_IDS } from '@renderer/fonts/font-contract';
import { useTerminalFontWeight } from '@renderer/fonts/terminal-font-weight-context';
import { SettingRow } from '@renderer/components/settings/primitives';

const SELECT_CLASS =
  'h-[34px] shrink-0 rounded-[9px] bg-[--surface-field] px-2.5 text-[13px] tabular-nums text-[--text] focus:outline-none focus:ring-2 focus:ring-[--accent]/60 focus-visible:rounded-[9px]';

/** Settings row for the one shared integrated-terminal font weight: a native select named "Terminal font weight" offering the nine CSS weights by name and number. Choosing a weight saves it immediately through the shared store (which ignores the already-current weight); a value outside the nine is ignored. Follows the shared weight from other windows and reverted failed saves. */
export function TerminalFontWeightControl(): JSX.Element {
  const { weight, setWeight } = useTerminalFontWeight();
  const id = useId();

  function handleChange(e: ChangeEvent<HTMLSelectElement>): void {
    const parsed = parseTerminalFontWeight(Number(e.target.value));
    if (parsed.ok) setWeight(parsed.value);
  }

  return (
    <SettingRow label={FONT_COPY.terminalWeightLabel} hint={FONT_COPY.terminalWeightHint} htmlFor={id}>
      <select
        id={id}
        value={weight}
        data-testid={FONT_TEST_IDS.terminalWeightSelect}
        onChange={handleChange}
        className={SELECT_CLASS}
      >
        {TERMINAL_FONT_WEIGHTS.map((w) => (
          <option key={w} value={w}>
            {FONT_COPY.terminalWeightOptionLabel(w)}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}
