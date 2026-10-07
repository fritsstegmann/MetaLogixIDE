import type { ReactNode } from 'react';
import { Tooltip } from './Tooltip';
import { XIcon } from './shell-icons';
import { abbreviatePath } from '../abbreviate-path';
import { SPLIT_COPY, SPLIT_TESTIDS } from '../split-copy';

interface Actions {
  onToTab: () => void;
  onClose: () => void;
}

interface Props {
  label: string;
  path: string;
  focused: boolean;
  dot: ReactNode;
  actions?: Actions;
}

const BUTTON = 'h-6 flex items-center justify-center rounded-[6px] focus-visible:rounded-[6px] text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover]';

function ToTabIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" />
      <path d="M3 15h9M9 12l3 3-3 3" />
    </svg>
  );
}

function PaneActions({ onToTab, onClose }: Actions) {
  return (
    <>
      <Tooltip label={SPLIT_COPY.toTabTooltip}>
        <button type="button" onClick={onToTab} data-testid={SPLIT_TESTIDS.toTab} className={`${BUTTON} px-2 gap-1.5 text-[11.5px]`}>
          <ToTabIcon />
          {SPLIT_COPY.toTab}
        </button>
      </Tooltip>
      <button type="button" onClick={onClose} aria-label={SPLIT_COPY.close} data-testid={SPLIT_TESTIDS.close} className={`${BUTTON} w-6`}>
        <XIcon />
      </button>
    </>
  );
}

/**
 * Header row of a split pane card: the shell's status dot (passed in as a slot), its chip label,
 * the abbreviated project path with the full path as its title, and, on the right pane, the
 * "To tab" and close actions. `focused` emphasises the label and lifts the row out of muted text.
 */
export function SplitPaneHeader({ label, path, focused, dot, actions }: Props) {
  return (
    <div
      data-testid={SPLIT_TESTIDS.header}
      className={`h-[34px] shrink-0 flex items-center pl-[14px] pr-2 gap-2 text-[12px] ${focused ? 'text-[--text]' : 'text-[--text-muted]'}`}
    >
      {dot}
      <span className={`shrink-0 ${focused ? 'font-semibold text-[--text]' : 'font-normal'}`}>{label}</span>
      <span className="min-w-0 truncate text-[--text-muted]" title={path}>{abbreviatePath(path)}</span>
      <div className="flex-1" />
      {actions && <PaneActions {...actions} />}
    </div>
  );
}
