import { useEffect, useMemo, useState } from 'react';
import { DIFF_COPY, DIFF_TESTIDS } from '@renderer/diff-tab-copy';
import {
  entryKey,
  groupChanges,
  reconcileSelection,
  type ChangeLists,
  type DiffEntry,
} from '@renderer/diff/diff-selection';
import type { DiffSidesState } from '@renderer/diff/diff-load-state';
import { useGitChanges } from '@renderer/hooks/useGitChanges';
import { useDiffSides } from '@renderer/hooks/useDiffSides';
import { DiffFileList } from './DiffFileList';
import { SplitDiffView } from './SplitDiffView';

interface Props {
  projectId: number;
}

interface ChangesViewProps {
  projectId: number;
  lists: ChangeLists;
  reloadToken: number;
  onRefresh: () => void;
}

interface DiffPaneProps {
  entry: DiffEntry | null;
  sides: DiffSidesState;
}

const FOCUS_RING = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]';

function RefreshButton({ onRefresh }: { onRefresh: () => void }) {
  return (
    <button
      type="button"
      onClick={onRefresh}
      data-testid={DIFF_TESTIDS.refresh}
      className={`text-xs px-2.5 py-1 rounded-md border border-[--border] text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong] ${FOCUS_RING}`}
    >
      {DIFF_COPY.refresh}
    </button>
  );
}

function CenteredMessage({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[--text-muted]" data-testid={testId}>
      {children}
    </div>
  );
}

function DiffPane({ entry, sides }: DiffPaneProps) {
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

function ChangesView({ projectId, lists, reloadToken, onRefresh }: ChangesViewProps) {
  const groups = useMemo(() => groupChanges(lists), [lists]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = reconcileSelection(selectedKey, groups.flatMap((g) => g.entries));
  const reconciledKey = selected ? entryKey(selected) : null;
  useEffect(() => setSelectedKey(reconciledKey), [reconciledKey]);
  const sides = useDiffSides(projectId, selected, reloadToken);

  if (groups.length === 0) {
    return (
      <CenteredMessage testId={DIFF_TESTIDS.empty}>
        <p>{DIFF_COPY.clean}</p>
        <RefreshButton onRefresh={onRefresh} />
      </CenteredMessage>
    );
  }
  return (
    <div className="h-full flex flex-col md:flex-row min-h-0">
      <div className="max-h-[40%] md:max-h-none md:w-[280px] shrink-0 flex flex-col min-h-0 border-b md:border-b-0 md:border-r border-[--border] bg-[--panel]/40">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[--border] shrink-0">
          <h2 className="flex-1 text-xs font-medium text-[--text]">{DIFF_COPY.listLabel}</h2>
          <RefreshButton onRefresh={onRefresh} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <DiffFileList groups={groups} selectedKey={reconciledKey} onSelect={(e) => setSelectedKey(entryKey(e))} />
        </div>
      </div>
      <div className="flex-1 min-w-0 min-h-0">
        <DiffPane entry={selected} sides={sides} />
      </div>
    </div>
  );
}

/**
 * The Diff tab body: polls the project's changes while mounted and shows the grouped file list beside the
 * selected file's side-by-side diff, or the loading, not-a-repository, clean and status-failed states
 * (spec AC7–AC13, AC17, AC21–AC30). Mount it keyed by project id so a project switch starts fresh.
 */
export function DiffTab({ projectId }: Props) {
  const { state, reloadToken, refresh } = useGitChanges(projectId);
  return (
    <section className="h-full min-h-0" aria-label={DIFF_COPY.tabLabel} data-testid={DIFF_TESTIDS.panel}>
      {state.phase === 'loading' && <CenteredMessage><p role="status">{DIFF_COPY.loadingList}</p></CenteredMessage>}
      {state.phase === 'not-repo' && <CenteredMessage testId={DIFF_TESTIDS.empty}><p>{DIFF_COPY.notRepo}</p></CenteredMessage>}
      {state.phase === 'error' && (
        <CenteredMessage testId={DIFF_TESTIDS.error}>
          <p role="alert" className="font-medium text-[--text]">{DIFF_COPY.statusFailed}</p>
          {state.message && <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-xs text-[--danger]">{state.message}</pre>}
          <RefreshButton onRefresh={refresh} />
        </CenteredMessage>
      )}
      {state.phase === 'ready' && (
        <ChangesView projectId={projectId} lists={state.lists} reloadToken={reloadToken} onRefresh={refresh} />
      )}
    </section>
  );
}
