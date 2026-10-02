import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { ENV_COPY, ENV_TESTIDS } from '@renderer/project-env-copy';
import {
  addRow,
  canSave,
  removeRow,
  rowProblems,
  rowsFromEnv,
  rowsToEnv,
  updateRow,
  type EnvRow,
  type EnvRowProblem,
} from '@renderer/project-env-rows';
import { nextFocusIndex } from './permission-mode-keys';

interface Props {
  projectId: number;
  projectName: string;
  onClose: () => void;
}

interface RowProps {
  row: EnvRow;
  index: number;
  problem: EnvRowProblem | null;
  onChange: (key: number, patch: Partial<Omit<EnvRow, 'key'>>) => void;
  onRemove: (key: number) => void;
}

type LoadState = 'loading' | 'ready' | 'failed';
type PendingFocus = { kind: 'row'; key: number } | { kind: 'add' } | null;

function focusTarget(row: EnvRow | undefined): PendingFocus {
  return row ? { kind: 'row', key: row.key } : { kind: 'add' };
}

const TITLE_ID = 'project-env-title';
const NOTICES_ID = 'project-env-notices';
const FOCUSABLE = 'input, button:not([disabled])';
const INPUT_CLASS =
  'w-full min-w-0 font-mono bg-[--panel] text-[--text] border rounded-md px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[--accent]/60';

function errorDetail(e: unknown): string {
  return String(e).replace(/^Error:\s*/, '');
}

function EnvRowEditor({ row, index, problem, onChange, onRemove }: RowProps) {
  const n = index + 1;
  const reasonId = `project-env-reason-${row.key}`;
  const nameBad = problem !== null && problem !== 'nul';
  const border = (bad: boolean) => (bad ? 'border-[--danger]' : 'border-[--border]');
  return (
    <li className="space-y-1" data-testid={ENV_TESTIDS.row}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={row.name}
          onChange={(e) => onChange(row.key, { name: e.target.value })}
          aria-label={ENV_COPY.nameLabel(n)}
          aria-invalid={nameBad || undefined}
          aria-describedby={nameBad ? reasonId : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-row-key={row.key}
          className={`${INPUT_CLASS} ${border(nameBad)} sm:w-[38%] sm:flex-none`}
          data-testid={ENV_TESTIDS.name}
        />
        <input
          value={row.value}
          onChange={(e) => onChange(row.key, { value: e.target.value })}
          aria-label={ENV_COPY.valueLabel(n)}
          aria-invalid={problem === 'nul' || undefined}
          aria-describedby={problem === 'nul' ? reasonId : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={`${INPUT_CLASS} ${border(problem === 'nul')} sm:flex-1`}
          data-testid={ENV_TESTIDS.value}
        />
        <button
          type="button"
          onClick={() => onRemove(row.key)}
          aria-label={ENV_COPY.removeLabel(n)}
          className="self-end sm:self-auto shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-[--text-muted] hover:text-[--danger] hover:bg-[--panel] focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]"
          data-testid={ENV_TESTIDS.remove}
        >
          <RemoveIcon />
        </button>
      </div>
      {problem && (
        <p id={reasonId} className="text-xs text-[--danger]" data-testid={ENV_TESTIDS.reason}>
          {ENV_COPY.reason[problem]}
        </p>
      )}
    </li>
  );
}

/** Loads the project's saved env as rows fresh from main on mount; `load` reports progress and failure. */
function useSavedRows(projectId: number): {
  rows: EnvRow[];
  setRows: (r: EnvRow[]) => void;
  load: LoadState;
} {
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  useEffect(() => {
    let live = true;
    api
      .invoke('projects:list', undefined as never)
      .then(({ projects }) => {
        const project = projects.find((p) => p.id === projectId);
        if (!live) return;
        if (!project) throw new Error(`project ${projectId} not found`);
        setRows(rowsFromEnv(project.config.env));
        setLoad('ready');
      })
      .catch((e: unknown) => {
        if (!live) return;
        setLoad('failed');
        toast(ENV_COPY.loadFailed, { kind: 'error', detail: errorDetail(e) });
      });
    return () => {
      live = false;
    };
  }, [projectId]);
  return { rows, setRows, load };
}

/**
 * Traps Tab inside `container` and owns every keydown while mounted (capture
 * phase, so app shortcuts never fire under the dialog): Escape calls
 * `onCancel`, Enter typed in an input is swallowed so it neither closes the
 * dialog nor discards edits, everything else keeps its native behaviour.
 */
function useDialogKeys(container: React.RefObject<HTMLElement>, onCancel: () => void): void {
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRef.current();
      } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
        e.preventDefault();
      } else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const els = Array.from(container.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
        const idx = nextFocusIndex(
          els.indexOf(document.activeElement as HTMLElement),
          els.length,
          e.shiftKey,
        );
        els[idx]?.focus();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [container]);
}

/**
 * Modal editor for one project's environment variables. Reads the saved map
 * fresh via `projects:list` on mount, edits rows locally, and persists only
 * on Save through `projects:update-config` with `{ env }` alone, then calls
 * `onClose`. Cancel, the close button and Escape call `onClose` without
 * saving. A failed save toasts the main-process reason (key names only,
 * never values) and keeps the dialog open with the edits intact.
 */
export function ProjectEnvTab({ projectId, projectName, onClose }: Props) {
  const { rows, setRows, load } = useSavedRows(projectId);
  const [saving, setSaving] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const focusedOnLoad = useRef(false);
  useDialogKeys(panelRef, onClose);

  useLayoutEffect(() => {
    if (load !== 'ready' || focusedOnLoad.current) return;
    focusedOnLoad.current = true;
    setPendingFocus(focusTarget(rows[0]));
  }, [load, rows]);

  useLayoutEffect(() => {
    if (!pendingFocus) return;
    if (pendingFocus.kind === 'add') addRef.current?.focus();
    else
      panelRef.current
        ?.querySelector<HTMLInputElement>(`input[data-row-key="${pendingFocus.key}"]`)
        ?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  const problems = rowProblems(rows);
  const saveEnabled = load === 'ready' && !saving && canSave(rows);

  function onAdd() {
    const next = addRow(rows);
    setRows(next);
    setPendingFocus(focusTarget(next.at(-1)));
  }

  function onRemove(key: number) {
    const at = rows.findIndex((r) => r.key === key);
    const next = removeRow(rows, key);
    setRows(next);
    setPendingFocus(focusTarget(next[Math.min(at, next.length - 1)]));
  }

  async function onSave() {
    if (!saveEnabled) return;
    setSaving(true);
    try {
      await api.invoke('projects:update-config', {
        id: projectId,
        config: { env: rowsToEnv(rows) },
      });
      onClose();
    } catch (e) {
      toast(ENV_COPY.saveFailed, { kind: 'error', detail: errorDetail(e) });
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={NOTICES_ID}
        className="modal-panel bg-[--panel-strong] w-[640px] max-w-full max-h-full flex flex-col rounded-xl shadow-2xl border border-[--border] overflow-hidden"
        data-testid={ENV_TESTIDS.panel}
      >
        <div className="px-5 py-4 border-b border-[--border] flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={TITLE_ID} className="font-semibold text-[--text]">
              {ENV_COPY.panelTitle}
            </h2>
            <p className="text-xs text-[--text-muted] truncate mt-0.5">{projectName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={ENV_COPY.discard}
            className="shrink-0 text-[--text-muted] hover:text-[--text] w-8 h-8 flex items-center justify-center rounded hover:bg-[--panel] focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]"
          >
            <RemoveIcon />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <div id={NOTICES_ID} className="space-y-1 text-xs leading-relaxed text-[--text-muted]">
            <p>{ENV_COPY.noticeNewShells}</p>
            <p className="text-[--text]">{ENV_COPY.noticeUnencrypted}</p>
            <p className="font-mono break-words">{ENV_COPY.tokensHint}</p>
          </div>

          {load === 'ready' && rows.length === 0 && (
            <p className="text-sm text-[--text-muted]" data-testid={ENV_TESTIDS.empty}>
              {ENV_COPY.emptyState}
            </p>
          )}
          {rows.length > 0 && (
            <ul className="space-y-2">
              {rows.map((row, i) => (
                <EnvRowEditor
                  key={row.key}
                  row={row}
                  index={i}
                  problem={problems[i] ?? null}
                  onChange={(key, patch) => setRows(updateRow(rows, key, patch))}
                  onRemove={onRemove}
                />
              ))}
            </ul>
          )}
          <button
            ref={addRef}
            type="button"
            onClick={onAdd}
            disabled={load !== 'ready'}
            className="text-sm px-3 py-1.5 rounded-md border border-[--border] text-[--text] hover:bg-[--panel] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]"
            data-testid={ENV_TESTIDS.add}
          >
            <span aria-hidden>+ </span>
            {ENV_COPY.addRow}
          </button>
        </div>

        <div className="px-5 py-3 border-t border-[--border] bg-[--panel]/50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-md hover:bg-[--panel] focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]"
            data-testid={ENV_TESTIDS.discard}
          >
            {ENV_COPY.discard}
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!saveEnabled}
            className="text-sm px-4 py-1.5 rounded-md font-medium pressable bg-[color:var(--accent)] text-white hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-2 focus-visible:ring-offset-[--panel-strong]"
            data-testid={ENV_TESTIDS.save}
          >
            {ENV_COPY.save}
          </button>
        </div>
      </div>
    </div>
  );
}

function RemoveIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
