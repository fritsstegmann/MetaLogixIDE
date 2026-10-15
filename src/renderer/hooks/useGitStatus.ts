import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitFileStatus } from '@shared/ipc-contract';
import { api } from '@renderer/api';
import { createRequestGate } from '@renderer/diff/diff-load-state';

export interface GitStatusView {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: Record<string, GitFileStatus>;
  dirty: boolean;
}

const EMPTY: GitStatusView = { isRepo: false, branch: null, ahead: 0, behind: 0, files: {}, dirty: false };

/**
 * Polls git status for the current project every 4s while mounted and
 * refetches immediately when the project changes. Cheap enough for the
 * status bar chip and file-tree badges. Only the latest request's response
 * (or failure) is applied, so a slow answer for a previous project or an
 * older poll never overwrites a newer status; a poll tick is skipped while
 * a request is in flight so a slow repo still gets its answer shown.
 */
export function useGitStatus(projectId: number | null, intervalMs = 4000): { status: GitStatusView; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<GitStatusView>(EMPTY);
  const gateRef = useRef(createRequestGate());

  const load = useCallback(async (fromPoll: boolean) => {
    const gate = gateRef.current;
    if (projectId == null) { gate.invalidate(); setStatus(EMPTY); return; }
    if (fromPoll && gate.inFlight) return;
    const seq = gate.begin();
    try {
      const s = await api.invoke('git:status', { projectId });
      if (gate.isLatest(seq)) setStatus(s);
    } catch {
      if (gate.isLatest(seq)) setStatus(EMPTY);
    } finally {
      gate.settle(seq);
    }
  }, [projectId]);

  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (projectId == null) return;
    const id = window.setInterval(() => { void load(true); }, intervalMs);
    return () => window.clearInterval(id);
  }, [projectId, intervalMs, load]);

  return { status, refresh };
}
