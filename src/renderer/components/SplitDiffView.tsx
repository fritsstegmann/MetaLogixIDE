import type { GitSideContent } from '@shared/ipc-contract';

/** Side-by-side, syntax-highlighted view of one file's diff (spec AC14–AC16, AC18, AC34–AC42). */
export interface SplitDiffViewProps {
  /** Unified diff text from git:diff-sides. */
  diff: string;
  /** Path of the old side (origPath for renames); picks the left language. */
  oldPath: string;
  /** Path of the new side; picks the right language. */
  newPath: string;
  oldSide: GitSideContent;
  newSide: GitSideContent;
}

export function SplitDiffView(props: SplitDiffViewProps): JSX.Element | null {
  void props;
  return null;
}
