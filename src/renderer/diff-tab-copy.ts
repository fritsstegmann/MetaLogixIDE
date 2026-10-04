/** Exact user-facing strings and test ids for the Diff tab. */
export const DIFF_COPY = {
  tabLabel: 'Diff',
  /** aria-label of the tab button when n > 0. */
  tabCountLabel: (n: number) => `Diff, ${n} changed ${n === 1 ? 'file' : 'files'}`,
  paletteTitle: 'Switch to Diff tab',
  listLabel: 'Changed files',
  group: { staged: 'Staged', unstaged: 'Changes', untracked: 'Untracked' },
  notRepo: 'Not a git repository.',
  clean: 'No changes — working tree clean.',
  loadingList: 'Loading changes…',
  loadingDiff: 'Loading diff…',
  noChanges: '(no changes)',
  tooLarge: 'Diff too large to show',
  statusFailed: 'Could not read git status',
  refresh: 'Refresh',
  renamedFrom: (orig: string) => `Renamed from ${orig}`,
  binary: 'Binary file — not shown',
  modeChanged: (from: string, to: string) => `File mode changed: ${from} → ${to}`,
  highlightOff: 'Syntax highlighting is off because the file is large.',
  hiddenLines: 'Unchanged lines hidden',
  sideOld: 'Before',
  sideNew: 'After',
} as const;

export const DIFF_TESTIDS = {
  tabBar: 'main-tab-bar',
  tab: 'main-tab-diff',
  tabCount: 'main-tab-diff-count',
  panel: 'diff-panel',
  list: 'diff-file-list',
  /** Carries data-group="staged|unstaged|untracked". */
  group: 'diff-group',
  /** Carries data-path and data-group; aria-current when selected. */
  row: 'diff-row',
  rowStatus: 'diff-row-status',
  /** The single vertical scroll container. */
  pane: 'diff-pane',
  refresh: 'diff-refresh',
  /** Not-repo and clean states. */
  empty: 'diff-empty',
  /** Status-failed state. */
  error: 'diff-error',
  sideOld: 'diff-side-old',
  sideNew: 'diff-side-new',
  /** Per-side cell; data-type="context|removed|added|filler". */
  line: 'diff-line',
  /** Line-number cell. */
  gutter: 'diff-gutter',
  separator: 'diff-separator',
  binary: 'diff-binary',
  mode: 'diff-mode',
  noChanges: 'diff-no-changes',
  highlightOff: 'diff-highlight-off',
} as const;
