/**
 * A project row's content in the command palette (AC7): a 7px Claude status dot when the project has
 * a live shell (a hollow ring otherwise), name, muted path, and on the right the muted "Current"
 * marker for the selected project, replaced by the `↩` hint when the row is highlighted. A component
 * of its own so `useProjectClaudeState` has a stable per-project call site.
 */
import { PALETTE_COPY, PALETTE_TESTIDS } from '@renderer/command-palette-contract';
import { useProjectClaudeState } from '@renderer/hooks/useClaudeStates';
import type { Project } from '@shared/types';
import { StatusDot } from '../StatusDot';

/**
 * Whether the highlighted row's dot keeps the white ring. Decided by `palette-dot-contrast.test.ts`:
 * busy / blocked fall below 3:1 on the soft highlight in default dark, Catppuccin light and Rosé Pine
 * light, so the ring stays (AC7).
 */
export const RING_NEEDED = true;

interface ProjectRowProps {
  readonly project: Project;
  readonly current: boolean;
  readonly active: boolean;
  readonly alive: boolean;
}

export function ProjectRow({ project, current, active, alive }: ProjectRowProps): React.JSX.Element {
  const claudeState = useProjectClaudeState(project.id);
  return (
    <>
      {alive ? (
        <StatusDot state={claudeState} ring={active && RING_NEEDED} className="!h-[7px] !w-[7px]" />
      ) : (
        <span
          data-lead="hollow"
          aria-hidden="true"
          className="inline-block h-[7px] w-[7px] shrink-0 rounded-full border border-[--modal-text-muted]"
        />
      )}
      <span className="shrink-0 truncate font-medium max-w-[60%]">{project.name}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[--modal-text-muted]">{project.path}</span>
      {current && <span className="sr-only">, {PALETTE_COPY.currentLabel}</span>}
      {active ? (
        <kbd>↩</kbd>
      ) : (
        current && (
          <span data-testid={PALETTE_TESTIDS.current} aria-hidden="true" className="shrink-0 text-[12px] text-[--modal-text-muted]">
            {PALETTE_COPY.current}
          </span>
        )
      )}
    </>
  );
}
