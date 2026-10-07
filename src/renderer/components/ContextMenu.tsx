import { useEffect, useRef } from 'react';
import { m, useIsPresent, useReducedMotion } from 'motion/react';
import { menuMotion } from '../menu-motion';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  separatorAfter?: boolean;
  disabled?: boolean;
  /** Muted, right-aligned secondary text such as a shortcut. */
  hint?: string;
  testId?: string;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Opt-in menu keyboard: focus the first enabled item on open; ArrowUp/ArrowDown cycle enabled items. */
  autoFocus?: boolean;
}

/**
 * Index of the next enabled item from `from` in direction `dir`, wrapping at
 * either end; `from` may be -1 (or `items.length`) to start before the list.
 * Returns -1 when no item is enabled.
 */
export function nextEnabledIndex(items: ContextMenuItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    if (!items[i]?.disabled) return i;
  }
  return -1;
}

/** Opt-in menu keyboard for ContextMenu: refs for each item button, initial focus on the first enabled item, and an ArrowUp/ArrowDown handler. */
function useMenuKeyboard(items: ContextMenuItem[], enabled: boolean) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocus = useRef(enabled ? nextEnabledIndex(items, -1, 1) : -1);
  useEffect(() => { itemRefs.current[initialFocus.current]?.focus(); }, []);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (!enabled || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    const from = current === -1 ? (dir === 1 ? -1 : items.length) : current;
    itemRefs.current[nextEnabledIndex(items, from, dir)]?.focus();
  }

  return { itemRefs, onMenuKeyDown };
}

/** Floating menu at (x, y), clamped to the viewport; Escape or an outside click calls `onClose`, and choosing an item closes before running it. */
export function ContextMenu({ x, y, items, onClose, autoFocus = false }: Props) {
  const { itemRefs, onMenuKeyDown } = useMenuKeyboard(items, autoFocus);

  const present = useIsPresent();
  const motionProps = menuMotion(useReducedMotion() ?? false);

  useEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, present]);

  // Clamp so the menu stays inside the viewport.
  const maxX = typeof window !== 'undefined' ? window.innerWidth - 220 : x;
  const maxY = typeof window !== 'undefined' ? window.innerHeight - items.length * 28 - 12 : y;
  const clampedX = Math.min(x, maxX);
  const clampedY = Math.min(y, maxY);

  return (
    <>
      {present && <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />}
      <m.div
        {...motionProps}
        className={`fixed z-50 min-w-[200px] rounded-md border border-[--border] bg-[--panel-strong] shadow-xl backdrop-blur-md py-1 text-sm${present ? '' : ' pointer-events-none'}`}
        // Grow out of the click point, even when clamping shifted the menu.
        style={{ left: clampedX, top: clampedY, transformOrigin: `${x - clampedX}px ${y - clampedY}px` }}
        role={present ? 'menu' : undefined}
        data-testid={present ? 'context-menu' : 'context-menu-leaving'}
        onKeyDown={onMenuKeyDown}
      >
        {items.map((it, i) => (
          <div key={i}>
            <button
              ref={(el) => { itemRefs.current[i] = el; }}
              disabled={it.disabled}
              onClick={() => { onClose(); it.onClick(); }}
              className={`w-full text-left px-3 py-1 flex items-center justify-between gap-3 ${
                it.disabled
                  ? 'text-[--text-muted] cursor-not-allowed opacity-60'
                  : it.danger
                    ? 'text-[--danger] hover:bg-[--danger]/15'
                    : 'text-[--text] hover:bg-[--panel]'
              }`}
              role="menuitem"
              data-testid={it.testId}
            >
              <span>{it.label}</span>
              {it.hint && <span className="text-xs text-[--text-muted]">{it.hint}</span>}
            </button>
            {it.separatorAfter && <div className="my-1 h-px bg-[--border]" />}
          </div>
        ))}
      </m.div>
    </>
  );
}
