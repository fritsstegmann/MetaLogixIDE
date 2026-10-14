import { XIcon } from './shell-icons';

const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  { title: 'Go',       items: [['⌘K', 'Project switcher'], ['⌘P', 'Find file in project'], ['⌘⇧F', 'Find in project']] },
  { title: 'Views',    items: [['⌘B', 'Toggle sidebar'], ['⌘,', 'Settings'], ['⌘/', 'This cheat sheet']] },
  { title: 'Palette',  items: [['⌘⇧P', 'Command palette'], ['⌘⇧N', 'New project']] },
  { title: 'Shell',    items: [['⌘F', 'Find in terminal'], ['⌘⇧O', 'Search all shells'], ['⌘⇧K', 'Prompt library'], ['⌘=', 'Zoom in'], ['⌘-', 'Zoom out'], ['⌘0', 'Reset zoom']] },
];

/** Keyboard shortcut cheat sheet (⌘/). */
export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      data-testid="shortcuts-help"
    >
      <div
        className="bg-[--panel-strong] w-[560px] max-w-[92vw] rounded-xl shadow-2xl border border-[--border] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[--border] flex items-center justify-between">
          <div className="font-semibold text-sm">Keyboard shortcuts</div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel]"
            title="Close (Esc)"
            aria-label="Close shortcuts"
          >
            <XIcon />
          </button>
        </div>
        <div className="p-5 grid grid-cols-2 gap-x-8 gap-y-4">
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold mb-2">{g.title}</div>
              <div className="space-y-1.5">
                {g.items.map(([keys, desc]) => (
                  <div key={keys} className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-[--text-muted]">{desc}</span>
                    <kbd>{keys}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-[--border] text-[11px] text-[--text-muted] text-right">
          <kbd>Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
