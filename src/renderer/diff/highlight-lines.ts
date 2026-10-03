/**
 * Per-line syntax highlighting for the split diff view and the app's HTML-safety boundary for it (spec AC38, AC40).
 * `highlightToLines` highlights the full text once, then splits the HTML at each newline, closing every open span at
 * the end of a line and reopening it on the next, so a comment or string that spans lines keeps its colour on each.
 * Every line must pass an allow-list of `<span class="…">`, `</span>` and tag-free text; if any line fails, the line
 * count is off, or the highlighter throws, the whole side falls back to escaped plain text. `SafeLineHtml` values are
 * only ever built here.
 */
import hljs from 'highlight.js/lib/common';

declare const safeLineHtml: unique symbol;

/** HTML for one line that has passed the allow-list, or escaped plain text. The only type the view injects as HTML. */
export type SafeLineHtml = string & { readonly [safeLineHtml]: true };

/** Turns full source text into highlight HTML; a test seam standing in for highlight.js. */
export type Highlighter = (text: string, lang: string) => string;

const ALLOWED_LINE = /^(?:<span class="[A-Za-z0-9_ -]+">|<\/span>|[^<>])*$/;
const TAG_OR_NEWLINE = /<span class="[^"]*">|<\/span>|\n/g;
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const hljsHighlight: Highlighter = (text, lang) => hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function plainLines(text: string): SafeLineHtml[] {
  return text.split('\n').map((line) => escapeHtml(line) as SafeLineHtml);
}

function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  let last = 0;
  for (const match of html.matchAll(TAG_OR_NEWLINE)) {
    line += html.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[0] === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else {
      if (match[0] === '</span>') open.pop();
      else open.push(match[0]);
      line += match[0];
    }
  }
  lines.push(line + html.slice(last));
  return lines;
}

/**
 * One `SafeLineHtml` per line of `text` (split on `\n`), highlighted as `lang` when highlight.js knows it and the
 * output passes the allow-list, otherwise escaped plain text. `highlight` replaces highlight.js in tests.
 */
export function highlightToLines(text: string, lang: string, highlight: Highlighter = hljsHighlight): SafeLineHtml[] {
  if (!lang || !hljs.getLanguage(lang)) return plainLines(text);
  let lines: string[];
  try {
    lines = splitHtmlLines(highlight(text, lang));
  } catch {
    return plainLines(text);
  }
  const safe = lines.length === text.split('\n').length && lines.every((line) => ALLOWED_LINE.test(line));
  return safe ? (lines as SafeLineHtml[]) : plainLines(text);
}
