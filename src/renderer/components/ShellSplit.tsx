import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ShellTab } from './ShellTab';
import { api } from '../api';
import { Reveal } from './Reveal';
import { SplitGutter } from './SplitGutter';
import { SplitPaneHeader } from './SplitPaneHeader';
import { clampRatio } from '../split-ratio';
import { SPLIT_TESTIDS } from '../split-copy';

/** One pane's shell: its index, chip label, status-dot node, and whether it runs in a popout window. */
export interface SplitPane {
  index: number;
  label: string;
  dot: ReactNode;
  popped: boolean;
}

/** What the split shows and does: left pane, right pane (null = single shell), project path for the headers, and the right pane's actions. */
export interface SplitPanes {
  left: SplitPane;
  right: SplitPane | null;
  path: string;
  onMoveToTab: () => void;
  onClose: () => void;
}

interface Props {
  projectId: number;
  projectName: string;
  panes: SplitPanes;
  ratio: number;
  onRatioChange: (r: number) => void;
  onOpenFile: (relPath: string, line: number | null) => void;
}

type Side = 'left' | 'right';

const CARD = 'rounded-[10px] bg-[--surface-pane]';
const RING = 'shadow-[inset_0_0_0_1px_var(--pane-ring)]';

/** Left share of the row's content box (inside its padding) at a pointer x. */
function ratioAt(row: HTMLElement, clientX: number): number {
  const rect = row.getBoundingClientRect();
  const cs = getComputedStyle(row);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  return clampRatio((clientX - rect.left - padL) / (rect.width - padL - padR));
}

/** Window-level pointer tracking for a gutter drag; returns the dragging flag and its starter. */
function useDividerDrag(rowRef: RefObject<HTMLDivElement | null>, onRatioChange: (r: number) => void) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      if (rowRef.current) onRatioChange(ratioAt(rowRef.current, e.clientX));
    }
    function onUp() { setDragging(false); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onRatioChange, rowRef]);
  return { dragging, startDrag: () => setDragging(true) };
}

/**
 * Pane-mode bookkeeping. Pane mode lasts while a right pane is rendered, including its fold-out,
 * so `exiting` holds it on until the Reveal reports the exit. The focused-pane mark resets to the
 * left whenever a split opens; it is local and never persisted.
 */
function usePaneMode(right: SplitPane | null) {
  const [prevRight, setPrevRight] = useState(right?.index ?? null);
  const [exiting, setExiting] = useState(false);
  const [focused, setFocused] = useState<Side>('left');
  const lastRight = useRef(right);
  if (right) lastRight.current = right;
  const rightIndex = right?.index ?? null;
  if (prevRight !== rightIndex) {
    setPrevRight(rightIndex);
    setExiting(prevRight != null && rightIndex == null);
    if (prevRight == null) setFocused('left');
  }
  return {
    paneMode: right != null || exiting,
    shownRight: right ?? lastRight.current,
    focused,
    markFocused: (side: Side) => { if (focused !== side) setFocused(side); },
    onExited: () => setExiting(false),
  };
}

function PaneBody({ projectId, projectName, pane, primary, rightKey, onOpenFile }: {
  projectId: number;
  projectName: string;
  pane: SplitPane;
  primary: boolean;
  rightKey: boolean;
  onOpenFile: Props['onOpenFile'];
}) {
  return (
    <div className="flex-1 min-h-0 relative">
      {pane.popped
        ? <PoppedPlaceholder projectId={projectId} shellIndex={pane.index} name={projectName} />
        : <ShellTab
            key={`${projectId}:${pane.index}${rightKey ? ':right' : ''}`}
            projectId={projectId}
            shellIndex={pane.index}
            primary={primary}
            onOpenFile={onOpenFile}
          />
      }
    </div>
  );
}

/**
 * The shell area: the left pane alone, or the left and right panes as two cards split by a
 * resizable gutter. The left pane is always the same `.split-left` element with the same child
 * positions and ShellTab key, so opening or closing the split never remounts its terminal; cards,
 * headers, the row inset and the focused-pane ring exist only in pane mode.
 */
export function ShellSplit({ projectId, projectName, panes, ratio, onRatioChange, onOpenFile }: Props) {
  const rowRef = useRef<HTMLDivElement>(null);
  const { dragging, startDrag } = useDividerDrag(rowRef, onRatioChange);
  const { paneMode, shownRight, focused, markFocused, onExited } = usePaneMode(panes.right);
  const focusAttr = (side: Side) => (paneMode ? String(focused === side) : undefined);
  const cardClass = (side: Side) => (paneMode ? `${CARD} ${focused === side ? RING : ''}` : '');
  const body = { projectId, projectName, onOpenFile };

  return (
    <div ref={rowRef} className={`h-full w-full flex min-h-0 ${paneMode ? 'p-2' : ''}`}>
      <div
        className={`split-left min-h-0 min-w-0 relative flex flex-col ${cardClass('left')}`}
        style={{ '--split-left': `${(ratio * 100).toFixed(2)}%` } as React.CSSProperties}
        data-pane-focused={focusAttr('left')}
        onFocus={() => markFocused('left')}
      >
        {paneMode && (
          <SplitPaneHeader label={panes.left.label} path={panes.path} focused={focused === 'left'} dot={panes.left.dot} />
        )}
        <PaneBody {...body} pane={panes.left} primary rightKey={false} />
      </div>
      {/* Split toggles are click-only, so they always animate. */}
      <Reveal show={panes.right != null} animate className="flex-1 flex min-h-0 min-w-0" onExited={onExited}>
        <SplitGutter ratio={ratio} dragging={dragging} onDragStart={startDrag} onRatioChange={onRatioChange} />
        {shownRight && (
          <section
            data-testid={SPLIT_TESTIDS.right}
            className={`flex-1 min-h-0 min-w-0 relative flex flex-col ${cardClass('right')}`}
            data-pane-focused={focusAttr('right')}
            onFocus={() => markFocused('right')}
          >
            <SplitPaneHeader
              label={shownRight.label}
              path={panes.path}
              focused={focused === 'right'}
              dot={shownRight.dot}
              actions={{ onToTab: panes.onMoveToTab, onClose: panes.onClose }}
            />
            <PaneBody {...body} pane={shownRight} primary={false} rightKey />
          </section>
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
