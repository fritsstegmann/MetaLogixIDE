import { useEffect, useRef, useState } from 'react';
import { ShellTab } from './ShellTab';
import { api } from '../api';
import { Reveal } from './Reveal';
import { XIcon } from './shell-icons';

export function ShellSplit({
  projectId, projectName,
  leftIndex, rightIndex,
  ratio, onRatioChange,
  isPoppedLeft, isPoppedRight,
  onCloseSplit, onOpenFile,
}: {
  projectId: number;
  projectName: string;
  leftIndex: number;
  rightIndex: number | null;           // null = single shell, no split
  ratio: number;                       // 0..1, share of horizontal space for LEFT
  onRatioChange: (r: number) => void;
  isPoppedLeft: boolean;
  isPoppedRight: boolean;
  onCloseSplit: () => void;
  onOpenFile: (relPath: string, line: number | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Keep rendering the last right shell while its pane animates out.
  const lastRight = useRef(rightIndex);
  if (rightIndex != null) lastRight.current = rightIndex;
  const shownRight = rightIndex ?? lastRight.current;

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const r = (e.clientX - rect.left) / rect.width;
      // Clamp so neither pane collapses.
      onRatioChange(Math.max(0.15, Math.min(0.85, r)));
    }
    function onUp() { setDragging(false); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onRatioChange]);

  const leftPercent = `${(ratio * 100).toFixed(2)}%`;
  // The left pane is always the same element with the same ShellTab key, so
  // opening or closing the split never remounts its terminal. It only takes
  // `--split-left` while the right pane is present (see .split-left in CSS).
  return (
    <div ref={wrapRef} className="h-full w-full flex min-h-0">
      <div className="split-left min-h-0 min-w-0 relative" style={{ '--split-left': leftPercent } as React.CSSProperties}>
        {isPoppedLeft
          ? <PoppedPlaceholder projectId={projectId} shellIndex={leftIndex} name={projectName} />
          : <ShellTab
              key={`${projectId}:${leftIndex}`}
              projectId={projectId}
              shellIndex={leftIndex}
              primary
              onOpenFile={onOpenFile}
            />
        }
      </div>
      {/* Split toggles are click-only, so they always animate. */}
      <Reveal show={rightIndex != null} animate className="flex-1 flex min-h-0 min-w-0">
        {/* Draggable divider — 4 px hit target, 1 px visible line. */}
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={() => setDragging(true)}
          className={`shrink-0 w-1 cursor-col-resize ${dragging ? 'bg-[color:var(--accent)]/60' : 'bg-[--surface-hover] hover:bg-[color:var(--accent)]/40'}`}
        />
        {shownRight != null && (
          <div className="flex-1 min-h-0 min-w-0 relative" data-testid="split-right">
            <button
              onClick={onCloseSplit}
              title="Close split (returns to single shell view)"
              className="absolute top-1 right-1 z-10 w-6 h-6 flex items-center justify-center rounded-md text-[--text-muted] hover:text-[--danger] hover:bg-[--panel-strong]"
            >
              <XIcon />
            </button>
            {isPoppedRight
              ? <PoppedPlaceholder projectId={projectId} shellIndex={shownRight} name={projectName} />
              : <ShellTab
                  key={`${projectId}:${shownRight}:right`}
                  projectId={projectId}
                  shellIndex={shownRight}
                  onOpenFile={onOpenFile}
                />
            }
          </div>
        )}
      </Reveal>
    </div>
  );
}

function PoppedPlaceholder({ projectId, shellIndex, name }: { projectId: number; shellIndex: number; name: string }) {
  return (
    <div className="h-full flex items-center justify-center p-8 text-center">
      <div className="max-w-md space-y-3">
        <div className="text-sm text-[--text-muted]">Shell is running in a separate window</div>
        <div className="text-lg font-semibold">{name}</div>
        <button
          onClick={async () => { await api.invoke('windows:return-shell', { projectId, shellIndex }); }}
          className="text-sm px-4 py-1.5 rounded-md pressable bg-[color:var(--accent)] text-[--accent-text] hover:brightness-110"
          data-testid="return-popout"
        >
          Bring back to this window
        </button>
      </div>
    </div>
  );
}
