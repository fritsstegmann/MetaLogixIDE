/**
 * Sidebar header row: the project filter field and the "+" button whose menu
 * offers New project…, Add root folder… and Rescan roots.
 */
import { useCallback, useRef, useState } from 'react';
import type { Root } from '@shared/types';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { SIDEBAR_COPY, SIDEBAR_TESTIDS } from '@renderer/sidebar-copy';
import { addRootFromPicker, buildAddMenuItems, rescanRoots } from '@renderer/sidebar-add-menu';
import { AnimatePresence } from 'motion/react';
import { ContextMenu } from './ContextMenu';
import { ICON_SIZE } from './icon-size';

interface Props {
  filter: string;
  onFilterChange: (value: string) => void;
  onNewProject?: () => void;
  roots: Root[];
  refreshRoots: () => Promise<unknown>;
  refreshProjects: () => Promise<unknown>;
}

/**
 * Renders the filter and "+" menu. The menu opens below "+" with keyboard
 * focus on its first item and hands focus back to "+" when it closes; add-root
 * and rescan call the main process and then the given refreshers.
 */
export function SidebarHeader({ filter, onFilterChange, onNewProject, roots, refreshRoots, refreshProjects }: Props) {
  const addRef = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const closeMenu = useCallback(() => {
    setMenuAt(null);
    addRef.current?.focus();
  }, []);

  function openMenu() {
    const rect = addRef.current?.getBoundingClientRect();
    if (rect) setMenuAt({ x: rect.left, y: rect.bottom + 4 });
  }

  const items = buildAddMenuItems({
    rescanning,
    onNewProject: () => onNewProject?.(),
    onAddRoot: () => void addRootFromPicker({
      pickDirectory: async () => (await api.invoke('dialogs:pick-directory', undefined as never)).path,
      addRoot: (path) => api.invoke('roots:add', { path }),
      refreshRoots,
      refreshProjects,
    }),
    onRescan: () => void rescanRoots({
      rootIds: roots.map((r) => r.id),
      rescanRoot: async (id) => (await api.invoke('roots:rescan', { id })).discovered,
      refreshProjects,
      notify: toast,
      setRescanning,
    }),
  });

  return (
    <div className="flex items-center gap-2">
      <FilterField value={filter} onChange={onFilterChange} />
      <button
        ref={addRef}
        onClick={openMenu}
        aria-label={SIDEBAR_COPY.addButtonLabel}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        data-testid={SIDEBAR_TESTIDS.addButton}
        className="shrink-0 w-9 h-9 rounded-[10px] flex items-center justify-center bg-[--surface-field] hover:bg-[--surface-active] text-[--text-muted] hover:text-[--text] pressable"
      >
        <PlusIcon />
      </button>
      <AnimatePresence>
        {menuAt && <ContextMenu key="context-menu" x={menuAt.x} y={menuAt.y} items={items} onClose={closeMenu} autoFocus />}
      </AnimatePresence>
    </div>
  );
}

function FilterField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex-1 min-w-0 h-9 rounded-[10px] bg-[--surface-field] flex items-center gap-2 px-2.5 text-[--text-muted] focus-within:ring-1 focus-within:ring-[--accent]/60">
      <SearchIcon />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={SIDEBAR_COPY.filterPlaceholder}
        aria-label={SIDEBAR_COPY.filterLabel}
        data-testid={SIDEBAR_TESTIDS.filter}
        className="flex-1 min-w-0 bg-transparent text-sm text-[--text] placeholder:text-[--text-muted] focus:outline-none"
      />
    </label>
  );
}

function SearchIcon() {
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="shrink-0">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
