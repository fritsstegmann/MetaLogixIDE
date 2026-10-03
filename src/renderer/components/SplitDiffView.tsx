/**
 * Side-by-side, syntax-highlighted view of one file's diff (spec AC14–AC16, AC18, AC34–AC42). It parses and aligns the
 * unified diff, and highlights each side over its full file content, memoised on `(text, lang)` so an unchanged side
 * is never re-highlighted. A side is shown plain when its content is missing, does not match the diff, or either side
 * is over the size limit (the only case that shows the highlight-off note). The scroll container is always the same
 * element, so a reload keeps the scroll position.
 */
import { useMemo } from 'react';
import type { GitSideContent } from '@shared/ipc-contract';
import { parseUnifiedDiff, type ParsedDiff } from '@renderer/diff/unified-diff';
import { alignHunks, sideMatchesContent, type Row } from '@renderer/diff/diff-rows';
import { highlightToLines, type SafeLineHtml } from '@renderer/diff/highlight-lines';
import { langForPath } from '@renderer/diff/highlight-lang';
import { DIFF_COPY, DIFF_TESTIDS } from '@renderer/diff-tab-copy';
import { DiffSideColumn } from './SplitDiffRows';

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

interface SideView {
  lines: SafeLineHtml[] | null;
  lang: string;
}

interface PaneBodyProps {
  parsed: ParsedDiff;
  rows: Row[];
  highlightOff: boolean;
  left: SideView;
  right: SideView;
}

function useSideView(rows: Row[], side: 'left' | 'right', content: string | null, path: string): SideView {
  const lang = langForPath(path);
  const text = lang ? content : null;
  const matches = useMemo(() => text !== null && sideMatchesContent(rows, side, text), [rows, side, text]);
  const lines = useMemo(() => (text !== null && matches ? highlightToLines(text, lang) : null), [text, lang, matches]);
  return { lines, lang };
}

function Notice({ testId, text }: { testId: string; text: string }) {
  return (
    <p data-testid={testId} className="px-4 py-2 font-sans text-xs text-[--text-muted]">
      {text}
    </p>
  );
}

function BinaryNotice() {
  return (
    <div data-testid={DIFF_TESTIDS.binary} className="grid grid-cols-2 divide-x divide-[--border] font-sans text-xs text-[--text-muted]">
      <p className="p-4">{DIFF_COPY.binary}</p>
      <p className="p-4">{DIFF_COPY.binary}</p>
    </div>
  );
}

function PaneBody({ parsed, rows, highlightOff, left, right }: PaneBodyProps) {
  if (parsed.binary) return <BinaryNotice />;
  const mode = parsed.oldMode && parsed.newMode ? DIFF_COPY.modeChanged(parsed.oldMode, parsed.newMode) : null;
  if (parsed.hunks.length === 0 && !mode) {
    return (
      <p data-testid={DIFF_TESTIDS.noChanges} className="p-6 text-center font-sans text-xs text-[--text-muted]">
        {DIFF_COPY.noChanges}
      </p>
    );
  }
  return (
    <>
      {mode && <Notice testId={DIFF_TESTIDS.mode} text={mode} />}
      {highlightOff && <Notice testId={DIFF_TESTIDS.highlightOff} text={DIFF_COPY.highlightOff} />}
      {rows.length > 0 && (
        <div className="grid grid-cols-2 divide-x divide-[--border]">
          <DiffSideColumn side="left" rows={rows} lines={left.lines} lang={left.lang} />
          <DiffSideColumn side="right" rows={rows} lines={right.lines} lang={right.lang} />
        </div>
      )}
    </>
  );
}

/** Renders the split view for one diff; the root is always the `DIFF_TESTIDS.pane` scroll container. */
export function SplitDiffView({ diff, oldPath, newPath, oldSide, newSide }: SplitDiffViewProps): JSX.Element | null {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const rows = useMemo(() => alignHunks(parsed.hunks), [parsed]);
  const highlightOff = oldSide.skipped === 'too-large' || newSide.skipped === 'too-large';
  const left = useSideView(rows, 'left', highlightOff ? null : oldSide.text, oldPath);
  const right = useSideView(rows, 'right', highlightOff ? null : newSide.text, newPath);
  return (
    <div data-testid={DIFF_TESTIDS.pane} className="h-full min-h-0 overflow-y-auto overflow-x-hidden font-mono text-[12px]">
      <PaneBody parsed={parsed} rows={rows} highlightOff={highlightOff} left={left} right={right} />
    </div>
  );
}
