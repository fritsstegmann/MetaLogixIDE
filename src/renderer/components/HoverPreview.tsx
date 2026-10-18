import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import type { IpcResponse } from '@shared/ipc-contract';
import { PEEK_COPY, PEEK_TESTIDS, peekOpenAction, peekOpenRequest, type PeekOpenAction } from '@renderer/peek-open';

export interface HoverPreviewState {
  x: number;
  y: number;
  projectId: number;
  path: string;
  line: number | null;
}

type PeekData = IpcResponse<'files:peek'>;

/**
 * Floating card that peeks a terminal path and shows the first ~40 lines of the file. Positioned relative to the cursor;
 * clamps to viewport. Not dismissible from inside — the parent controls open/close via its own hover / leave logic on the
 * terminal link. `popout` marks a popout window, where a file from another project previews but cannot be opened.
 */
export function HoverPreview({ state, popout = false, onOpen }: { state: HoverPreviewState | null; popout?: boolean; onOpen: HoverPreviewOpen }) {
  const [data, setData] = useState<PeekData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!state) { setData(null); return; }
    let cancelled = false;
    setLoading(true);
    setData(null);
    (async () => {
      try {
        const res = await api.invoke('files:peek', { projectId: state.projectId, relPath: state.path });
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setData({ relPath: state.path, projectId: null, found: false, kind: 'text', head: '', sizeBytes: 0, totalLines: null });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [state]);

  if (!state) return null;
  return <HoverPreviewCard state={state} data={data} loading={loading} popout={popout} onOpen={onOpen} />;
}

/** Opens a previewed file; `projectId` is set only when the file belongs to a project other than the terminal's. */
export type HoverPreviewOpen = (relPath: string, line: number | null, projectId?: number) => void;

/** The preview card for a fetched (or loading) peek result, with its click affordance decided by {@link peekOpenAction}. */
export function HoverPreviewCard({ state, data, loading, popout, onOpen }: {
  state: HoverPreviewState;
  data: PeekData | null;
  loading: boolean;
  popout: boolean;
  onOpen: HoverPreviewOpen;
}) {
  const maxX = window.innerWidth  - 480 - 8;
  const maxY = window.innerHeight - 280 - 8;
  const left = Math.min(state.x + 14, Math.max(8, maxX));
  const top  = Math.min(state.y + 14, Math.max(8, maxY));

  const action = peekOpenAction({ found: data?.found ?? false, projectId: data?.projectId ?? null, currentProjectId: state.projectId, popout });
  const clickable = action.kind !== 'disabled';
  const open = () => {
    const req = data ? peekOpenRequest(action, data.relPath, state.line) : null;
    if (req) onOpen(req.relPath, req.line, req.projectId);
  };
  return (
    <div
      className={`popover fixed z-50 w-[480px] max-h-[300px] rounded-md border border-[--border] bg-[--panel-strong] shadow-2xl backdrop-blur-md overflow-hidden text-[12px] pointer-events-auto ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
      style={{ left, top, transformOrigin: `${state.x - left}px ${state.y - top}px` }}
      onClick={open}
      onMouseDown={(e) => e.preventDefault()}
      role="tooltip"
      data-testid={PEEK_TESTIDS.card}
      data-open-action={action.kind}
    >
      <div className="px-3 py-1.5 border-b border-[--border] flex items-center justify-between bg-[--panel]/60">
        <span className="font-mono truncate" title={data?.relPath ?? state.path}>{data?.relPath ?? state.path}</span>
        {state.line != null && <span className="text-[--text-muted]">line {state.line}</span>}
      </div>
      <div className="max-h-[240px] overflow-hidden">
        {loading && <div className="p-4 text-[--text-muted]">Loading…</div>}
        {!loading && data && !data.found && (
          <div className="p-3 text-[--text-muted]">File not found in this project.</div>
        )}
        {!loading && data?.found && data.kind === 'binary' && (
          <div className="p-3 text-[--text-muted]">Binary file — no preview.</div>
        )}
        {!loading && data?.found && data.kind === 'text' && (
          <pre className="px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre overflow-hidden">{data.head}</pre>
        )}
      </div>
      {data?.found && (
        <div data-testid={PEEK_TESTIDS.footer} className="px-3 py-1.5 border-t border-[--border] text-[10px] text-[--text-muted] bg-[--panel]/60 flex justify-between gap-3">
          <PeekFooterHint action={action} />
          {data.totalLines != null && <span className="shrink-0">{data.totalLines} lines · {formatBytes(data.sizeBytes)}</span>}
        </div>
      )}
    </div>
  );
}

/** The footer's left slot: what a click does, or the note saying why it does nothing. */
function PeekFooterHint({ action }: { action: PeekOpenAction }) {
  if (action.kind === 'open-here') return <span>{PEEK_COPY.openHere}</span>;
  if (action.kind === 'switch-project') return <span>{PEEK_COPY.switchProject}</span>;
  if (!action.note) return <span />;
  return <span data-testid={PEEK_TESTIDS.note} className="text-[--text]">{action.note}</span>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
