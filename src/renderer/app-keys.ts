/** Pure app-level shortcut routing for App's global keydown, FilesTab save and GitPanel commit. */
import type { AppShortcutActionFn, ShortcutPredicateFn } from './shortcut-contract';

export const appShortcutAction: AppShortcutActionFn = () => {
  throw new Error('not implemented');
};

export const isSaveShortcut: ShortcutPredicateFn = () => {
  throw new Error('not implemented');
};

export const isCommitShortcut: ShortcutPredicateFn = () => {
  throw new Error('not implemented');
};
