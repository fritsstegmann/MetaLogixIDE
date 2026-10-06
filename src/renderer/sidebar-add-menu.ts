/**
 * The sidebar "+" menu: a pure builder for its three items, plus the add-root
 * and rescan flows it triggers, each taking its IPC and refresh calls as
 * injected dependencies so they run without a DOM or preload bridge.
 */
import type { ContextMenuItem } from '@renderer/components/ContextMenu';
import type { Toast } from '@renderer/hooks/useToasts';
import { SIDEBAR_COPY, SIDEBAR_TESTIDS } from '@renderer/sidebar-copy';

export interface AddMenuOptions {
  rescanning: boolean;
  onNewProject: () => void;
  onAddRoot: () => void;
  onRescan: () => void;
}

/** Items for the "+" menu, in order: New project…, Add root folder…, Rescan roots (disabled and relabelled while `rescanning`). */
export function buildAddMenuItems({ rescanning, onNewProject, onAddRoot, onRescan }: AddMenuOptions): ContextMenuItem[] {
  return [
    {
      label: SIDEBAR_COPY.menuNewProject,
      hint: SIDEBAR_COPY.menuNewProjectHint,
      testId: SIDEBAR_TESTIDS.menuNewProject,
      onClick: onNewProject,
    },
    { label: SIDEBAR_COPY.menuAddRoot, testId: SIDEBAR_TESTIDS.menuAddRoot, onClick: onAddRoot },
    {
      label: rescanning ? SIDEBAR_COPY.menuRescanning : SIDEBAR_COPY.menuRescan,
      testId: SIDEBAR_TESTIDS.menuRescan,
      disabled: rescanning,
      onClick: onRescan,
    },
  ];
}

export interface AddRootDeps {
  pickDirectory: () => Promise<string | null>;
  addRoot: (path: string) => Promise<unknown>;
  refreshRoots: () => Promise<unknown>;
  refreshProjects: () => Promise<unknown>;
}

/** Asks for a folder and, unless cancelled, adds it as a root and refreshes the root and project lists. */
export async function addRootFromPicker(d: AddRootDeps): Promise<void> {
  const path = await d.pickDirectory();
  if (!path) return;
  await d.addRoot(path);
  await d.refreshRoots();
  await d.refreshProjects();
}

export interface RescanDeps {
  rootIds: readonly number[];
  rescanRoot: (id: number) => Promise<number>;
  refreshProjects: () => Promise<unknown>;
  notify: (title: string, opts: Partial<Pick<Toast, 'kind' | 'detail'>>) => void;
  setRescanning: (running: boolean) => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Rescans every root in turn, refreshes projects and toasts the outcome; `setRescanning` brackets the run even on failure. */
export async function rescanRoots(d: RescanDeps): Promise<void> {
  d.setRescanning(true);
  let total = 0;
  try {
    for (const id of d.rootIds) total += await d.rescanRoot(id);
    await d.refreshProjects();
    d.notify(`Rescanned ${plural(d.rootIds.length, 'root')}`, { kind: 'success', detail: `${plural(total, 'project folder')} on disk` });
  } catch (e) {
    d.notify('Rescan failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
  } finally {
    d.setRescanning(false);
  }
}
