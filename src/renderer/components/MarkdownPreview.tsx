import { useMemo, useRef } from 'react';
import { renderMarkdown } from '@renderer/markdown/markdownRenderer';
import { MARKDOWN_PREVIEW_TESTID } from '@renderer/markdown/contract';
import { useMermaidDiagrams } from '@renderer/markdown/mermaid/useMermaidDiagrams';
import { useDocumentTheme } from '@renderer/hooks/useDocumentTheme';

/** Rendered Markdown preview: HTML, mermaid diagrams, math, and link routing. */
export function MarkdownPreview({ source }: { source: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(source), [source]);
  const ref = useRef<HTMLDivElement>(null);
  useMermaidDiagrams(ref, html, useDocumentTheme());
  return (
    <div
      ref={ref}
      className="markdown p-6 max-w-3xl mx-auto"
      data-testid={MARKDOWN_PREVIEW_TESTID}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
