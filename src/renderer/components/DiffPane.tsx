/**
 * The right-hand pane of the Diff tab: renders the selected entry's `git:diff-sides` state, treating state that
 * belongs to another entry as still loading so a stale diff is never shown under a new selection (spec AC17, AC20,
 * AC23, AC30).
 */
import { DIFF_COPY } from '@renderer/diff-tab-copy';
import { entryKey, type DiffEntry } from '@renderer/diff/diff-selection';
import type { DiffSidesState } from '@renderer/diff/diff-load-state';
import { SplitDiffView } from './SplitDiffView';

interface DiffPaneProps {
  entry: DiffEntry | null;
  sides: DiffSidesState;
}

/** Centred, muted message block for the Diff tab's loading, empty and error states. */
export function CenteredMessage({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[--text-muted]" data-testid={testId}>
      {children}
    </div>
  );
}

/** The selected entry's diff: loading until state for this entry arrives, then too-large, the error text, or the side-by-side view (spec AC17, AC20, AC23). */
export function DiffPane({ entry, sides }: DiffPaneProps) {
  const current = entry !== null && 'key' in sides && sides.key === entryKey(entry) ? sides : null;
  if (entry === null) return null;
  if (current === null || current.status === 'loading') {
    return <CenteredMessage><p role="status">{DIFF_COPY.loadingDiff}</p></CenteredMessage>;
  }
  if (current.status === 'too-large') return <CenteredMessage><p>{DIFF_COPY.tooLarge}</p></CenteredMessage>;
  if (current.status === 'error') {
    return <CenteredMessage><p role="alert" className="text-[--danger] whitespace-pre-wrap break-words">{current.message}</p></CenteredMessage>;
  }
  return (
    <SplitDiffView
      diff={current.diff}
      oldPath={entry.origPath ?? entry.path}
      newPath={entry.path}
      oldSide={current.oldSide}
      newSide={current.newSide}
    />
  );
}
