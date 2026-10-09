import { useEffect, useId, useState } from 'react';
import { TERMINAL_FONT_SIZE } from '@shared/terminal-font-size';
import { FONT_COPY, FONT_TEST_IDS } from '@renderer/fonts/font-contract';
import { useTerminalFontSize } from '@renderer/fonts/terminal-font-size-context';
import { NUMBER_FIELD_CLASS, SettingRow } from '@renderer/components/settings/primitives';
import { initialDraft, onCommit, onExternalUpdate, onInput, type DraftState } from '@renderer/components/settings/font-size-draft';

/** Settings row for the one shared integrated-terminal font size: a 9..28 px number spinbutton with a "px" readout, named "Terminal font size". Saves in-range whole numbers as typed, clamps out-of-range whole numbers on blur or Enter, reverts anything else, and follows the shared size (keyboard zoom, other windows) while the field is not mid-edit. */
export function TerminalFontSizeControl(): React.JSX.Element {
  const { size, setSize } = useTerminalFontSize();
  const id = useId();
  const [state, setState] = useState<DraftState>(() => initialDraft(size));

  useEffect(() => {
    setState((prev) => onExternalUpdate(prev, size));
  }, [size]);

  function commit(raw: string): void {
    const result = onCommit(raw, size);
    setState(result.state);
    if (result.commit !== null) setSize(result.commit);
  }

  return (
    <SettingRow label={FONT_COPY.terminalSizeLabel} hint={FONT_COPY.terminalSizeHint} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          min={TERMINAL_FONT_SIZE.min}
          max={TERMINAL_FONT_SIZE.max}
          step={TERMINAL_FONT_SIZE.step}
          value={state.draft}
          data-testid={FONT_TEST_IDS.terminalSizeInput}
          onChange={(e) => {
            const result = onInput(e.target.value);
            setState(result.state);
            if (result.commit !== null) setSize(result.commit);
          }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
          }}
          className={NUMBER_FIELD_CLASS}
        />
        <span className="text-[13px] text-[--text-muted]">{FONT_COPY.terminalSizeUnit}</span>
      </div>
    </SettingRow>
  );
}
