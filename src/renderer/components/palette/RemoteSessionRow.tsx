/**
 * A paired machine's live project in the palette's In use group: its agent status dot, the project
 * name, the machine it runs on in place of the root folder, the severity label and the trailing
 * open / Ctrl+<n> column, laid out like `ProjectRow` so the group reads as one list.
 */
import { PALETTE_COPY, PALETTE_TESTIDS } from '@renderer/command-palette-contract';
import type { RemoteInUseRow } from '@renderer/fleet-in-use';
import { ICON_SIZE, ICON_STROKE } from '../icon-size';
import { StatusDot } from '../StatusDot';
import { RING_NEEDED, RowTrail, STATUS_TONE } from './ProjectRow';

interface RemoteSessionRowProps {
  readonly session: RemoteInUseRow;
  readonly active: boolean;
  readonly jump?: number;
}

export function RemoteSessionRow({ session, active, jump }: RemoteSessionRowProps): React.JSX.Element {
  return (
    <>
      <span className="flex w-3.5 shrink-0 justify-center">
        <StatusDot state={session.state} ring={active && RING_NEEDED} className="!h-[7px] !w-[7px]" />
      </span>
      <span className="shrink-0 truncate font-medium max-w-[45%]">{session.name}</span>
      <span className="sr-only">, {PALETTE_COPY.remoteLabel(session.deviceName)}</span>
      <span data-testid={PALETTE_TESTIDS.remoteMachine} aria-hidden="true" title={session.deviceName}
        className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-normal text-[--modal-text-muted]">
        <MachineGlyph />
        <span className="truncate">{session.deviceName}</span>
      </span>
      <span data-testid={PALETTE_TESTIDS.projectStatus} aria-hidden="true" className={`shrink-0 text-[12.5px] ${STATUS_TONE[session.state]}`}>
        {PALETTE_COPY.projectStatus[session.state]}
      </span>
      <RowTrail active={active} jump={jump} />
    </>
  );
}

/** A small monitor outline marking the machine name, in the slot where local rows show their root folder. */
function MachineGlyph(): React.JSX.Element {
  return (
    <svg aria-hidden="true" width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}
