export interface ViewedShellKey {
  projectId: number;
  shellIndex: number;
}

export interface ViewedShellsInput {
  selectedProjectId: number | null;
  mainTab: 'shell' | 'files';
  activeShellIndex: number;
  rightShellIndex: number | null;
}

/**
 * Derives which shells the renderer is currently showing, for suppression of
 * Claude notifications (spec Definitions "Viewing the shell", D5). Returns an
 * empty list when no project is selected or the Files tab is showing;
 * otherwise the active shell plus the right split pane when one is open,
 * deduped so a shell shown in both panes appears once.
 */
export function viewedShellsFor(input: ViewedShellsInput): ViewedShellKey[] {
  const { selectedProjectId, mainTab, activeShellIndex, rightShellIndex } = input;
  if (selectedProjectId == null || mainTab !== 'shell') return [];
  const indexes = new Set<number>([activeShellIndex]);
  if (rightShellIndex != null) indexes.add(rightShellIndex);
  return [...indexes].map((shellIndex) => ({ projectId: selectedProjectId, shellIndex }));
}
