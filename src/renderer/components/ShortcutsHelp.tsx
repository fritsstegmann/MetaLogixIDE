import { useId } from 'react';
import { MODAL_CLASSES } from '@renderer/modal-glass';
import { ModalFrame } from './ModalFrame';
import { XIcon } from './shell-icons';

interface ShortcutRow {
  /** The shortcut first, then any alternatives that do the same thing. */
  readonly keys: readonly string[];
  readonly label: string;
}

const SHORTCUT_GROUPS: ReadonlyArray<{ readonly title: string; readonly rows: readonly ShortcutRow[] }> = [
  { title: 'Go', rows: [
    { keys: ['⌘K', '⌘⇧P'], label: 'Command palette' },
    { keys: ['⌘P'], label: 'Find file in project' },
    { keys: ['⌘⇧F'], label: 'Find in project' },
  ] },
  { title: 'Views', rows: [
    { keys: ['⌘B'], label: 'Toggle sidebar' },
    { keys: ['⌘,'], label: 'Settings' },
    { keys: ['⌘/'], label: 'This cheat sheet' },
  ] },
  { title: 'Project', rows: [
    { keys: ['⌘⇧N'], label: 'New project' },
    { keys: ['⌘T'], label: 'New terminal' },
    { keys: ['⌘⇧T'], label: 'New terminal in a new window' },
  ] },
  { title: 'Shell', rows: [
    { keys: ['⌘F'], label: 'Find in terminal' },
    { keys: ['⌘⇧O'], label: 'Search all shells' },
    { keys: ['⌘⇧K'], label: 'Prompt library' },
    { keys: ['⌘='], label: 'Zoom in' },
    { keys: ['⌘-'], label: 'Zoom out' },
    { keys: ['⌘0'], label: 'Reset zoom' },
  ] },
];

/**
 * Keyboard shortcut cheat sheet (⌘/), on the shared modal frame and glass sheet. Each row is a
 * dt/dd pair: the label, then the shortcut and its alternatives. A click on the scrim, the close
 * button or Escape (handled by App) calls `onClose`.
 */
export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId();
  if (!open) return null;
  return (
    <ModalFrame testId="shortcuts-help" tier="modal" motion="none" layerClassName="flex items-center justify-center" onDismiss={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={`${MODAL_CLASSES.sheet} w-[560px] max-w-[92vw] overflow-hidden`}>
        <div className="px-4 py-3 border-b border-[--modal-hairline] flex items-center justify-between">
          <h2 id={titleId} className="font-semibold text-sm">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-[--modal-text-muted] hover:text-[--text] hover:bg-[--surface-hover]"
            title="Close (Esc)"
            aria-label="Close shortcuts"
          >
            <XIcon />
          </button>
        </div>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h3 className="text-[10px] uppercase tracking-wider text-[--modal-text-muted] font-semibold mb-2">{g.title}</h3>
              <dl className="space-y-1.5">
                {g.rows.map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-4 text-sm">
                    <dt className="text-[--modal-text-muted]">{row.label}</dt>
                    <dd className="flex items-center gap-1">{row.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-[--modal-hairline] text-[11px] text-[--modal-text-muted] text-right">
          <kbd>Esc</kbd> to close
        </div>
      </div>
    </ModalFrame>
  );
}
