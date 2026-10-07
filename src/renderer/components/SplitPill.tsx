import { Tooltip } from './Tooltip';
import { SplitIcon } from './shell-icons';
import { SPLIT_COPY, SPLIT_TESTIDS } from '../split-copy';

const BASE = 'shrink-0 h-7 px-2.5 inline-flex items-center gap-[7px] rounded-[7px] text-xs focus-visible:rounded-[7px]';
const ON = 'bg-[--accent-soft] text-[color:var(--accent)]';
const OFF = 'text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover]';

interface Props {
  on: boolean;
  onToggle: () => void;
}

/**
 * Right-aligned "Split" toggle for the shell tab strip. The visible label is the accessible name in
 * both states; `aria-pressed` carries the state and the tooltip says what a click does.
 */
export function SplitPill({ on, onToggle }: Props) {
  return (
    <Tooltip label={on ? SPLIT_COPY.tooltipOn : SPLIT_COPY.tooltipOff}>
      <button
        type="button"
        aria-pressed={on}
        onClick={onToggle}
        className={`${BASE} ${on ? ON : OFF}`}
        data-testid={SPLIT_TESTIDS.toggle}
      >
        <SplitIcon />
        {SPLIT_COPY.pill}
      </button>
    </Tooltip>
  );
}
