/**
 * Row and cell rendering for one side of the split diff view (spec AC14–AC16, AC35, AC36, AC40). Every row has a
 * fixed height so the two sides stay aligned inside the shared vertical scroll container, and each side scrolls
 * horizontally on its own. Highlighted lines go through `HighlightedCode`, the Diff tab's only HTML injection site;
 * every other line is a React text node.
 */
import type { Cell, Row } from '@renderer/diff/diff-rows';
import type { DiffLineType } from '@renderer/diff/unified-diff';
import type { SafeLineHtml } from '@renderer/diff/highlight-lines';
import { DIFF_COPY, DIFF_TESTIDS } from '@renderer/diff-tab-copy';

export interface DiffSideColumnProps {
  side: 'left' | 'right';
  rows: Row[];
  /** Highlighted HTML per file line (index = line number − 1), or null to show plain text. */
  lines: SafeLineHtml[] | null;
  lang: string;
}

const TINT: Record<DiffLineType, string> = {
  context: '',
  removed: 'bg-rose-500/10',
  added: 'bg-emerald-500/10',
};

const MARKER: Record<DiffLineType, string> = { context: ' ', removed: '-', added: '+' };

function HighlightedCode({ html }: { html: SafeLineHtml }) {
  return <code className="whitespace-pre pr-3" dangerouslySetInnerHTML={{ __html: html }} />;
}

function LineRow({ cell, html }: { cell: Cell | null; html: SafeLineHtml | undefined }) {
  if (!cell) return <div data-testid={DIFF_TESTIDS.line} data-type="filler" className="h-5 bg-slate-500/10" />;
  return (
    <div data-testid={DIFF_TESTIDS.line} data-type={cell.type} className={`flex h-5 leading-5 ${TINT[cell.type]}`}>
      <span data-testid={DIFF_TESTIDS.gutter} className="w-12 shrink-0 select-none pr-2 text-right text-[--text-muted]">
        {cell.lineNo}
      </span>
      <span className="w-4 shrink-0 select-none text-[--text-muted]">{MARKER[cell.type]}</span>
      {html === undefined ? <code className="whitespace-pre pr-3">{cell.text}</code> : <HighlightedCode html={html} />}
    </div>
  );
}

function SeparatorRow({ decorative }: { decorative: boolean }) {
  return (
    <div
      data-testid={DIFF_TESTIDS.separator}
      aria-hidden={decorative || undefined}
      className="h-5 select-none bg-sky-500/5 pl-16 text-[11px] italic leading-5 text-[--text-muted]"
    >
      ⋯ {DIFF_COPY.hiddenLines}
    </div>
  );
}

/** One side of the split view: a horizontally scrolling column of fixed-height rows, labelled Before or After. */
export function DiffSideColumn({ side, rows, lines, lang }: DiffSideColumnProps) {
  const isOld = side === 'left';
  return (
    <section
      aria-label={isOld ? DIFF_COPY.sideOld : DIFF_COPY.sideNew}
      data-testid={isOld ? DIFF_TESTIDS.sideOld : DIFF_TESTIDS.sideNew}
      className="min-w-0 overflow-x-auto overflow-y-hidden"
    >
      <div className={`hljs language-${lines ? lang : 'plaintext'} w-max min-w-full`}>
        {rows.map((row, i) =>
          row.kind === 'separator' ? (
            <SeparatorRow key={i} decorative={!isOld} />
          ) : (
            <LineRow key={i} cell={row[side]} html={row[side] && lines ? lines[row[side].lineNo - 1] : undefined} />
          ),
        )}
      </div>
    </section>
  );
}
