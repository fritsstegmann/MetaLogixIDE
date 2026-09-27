/**
 * markdown-it plugin for TeX math. Inline: `$…$`, `\(…\)`; display: `$$…$$`,
 * `\[…\]` (as a block or mid-paragraph). An inline `$` opens only before a
 * non-space and closes only after a non-space and before a non-digit; `\$` and
 * unmatched `\(`/`\[` stay literal. Code spans and code blocks are never math.
 */
import type MarkdownIt from 'markdown-it';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { renderMath } from './renderMath';

type InlineMatch =
  | { kind: 'math'; content: string; display: boolean; end: number }
  | { kind: 'text'; content: string; end: number };

type BlockClose = { content: string; line: number };

const BLOCK_DELIMITERS = [
  { open: '$$', close: '$$' },
  { open: '\\[', close: '\\]' },
];

const BRACKET_CLOSERS: Record<string, { close: string; display: boolean }> = {
  '(': { close: '\\)', display: false },
  '[': { close: '\\]', display: true },
};

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

function canCloseSingle(src: string, at: number): boolean {
  return !isSpace(src[at - 1]) && !isDigit(src[at + 1]);
}

function findDollarCloser(src: string, from: number, delim: string): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
    } else if (src.startsWith(delim, i) && (delim === '$$' || canCloseSingle(src, i))) {
      return i;
    }
  }
  return -1;
}

function scanDollar(src: string, pos: number): InlineMatch | null {
  if (src[pos] !== '$') return null;
  const delim = src[pos + 1] === '$' ? '$$' : '$';
  const start = pos + delim.length;
  if (delim === '$' && isSpace(src[start])) return null;
  const close = findDollarCloser(src, start, delim);
  if (close <= start) {
    return delim === '$$' ? { kind: 'text', content: '$$', end: start } : null;
  }
  return {
    kind: 'math',
    content: src.slice(start, close),
    display: delim === '$$',
    end: close + delim.length,
  };
}

function scanBracket(src: string, pos: number): InlineMatch | null {
  const closer = src[pos] === '\\' ? BRACKET_CLOSERS[src.charAt(pos + 1)] : undefined;
  if (!closer) return null;
  const start = pos + 2;
  const close = src.indexOf(closer.close, start);
  if (close < 0 || src.slice(start, close).trim() === '') return null;
  return {
    kind: 'math',
    content: src.slice(start, close),
    display: closer.display,
    end: close + closer.close.length,
  };
}

function pushInline(state: StateInline, match: InlineMatch): void {
  if (match.kind === 'text') {
    state.pending += match.content;
    return;
  }
  const token = state.push(match.display ? 'math_inline_display' : 'math_inline', 'math', 0);
  token.content = match.content;
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src.slice(0, state.posMax);
  const match = scanDollar(src, state.pos) ?? scanBracket(src, state.pos);
  if (!match) return false;
  if (!silent) pushInline(state, match);
  state.pos = match.end;
  return true;
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice((state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0), state.eMarks[line]);
}

function lineIndent(state: StateBlock, line: number): number {
  return (state.sCount[line] ?? 0) - state.blkIndent;
}

function closerAtEnd(text: string, close: string): number {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(close) ? trimmed.length - close.length : -1;
}

function scanFollowingLines(
  state: StateBlock,
  startLine: number,
  endLine: number,
  close: string,
): BlockClose | null {
  const lines: string[] = [];
  for (let line = startLine + 1; line < endLine; line++) {
    if (state.isEmpty(line) || lineIndent(state, line) < 0) return null;
    const text = lineText(state, line);
    const at = closerAtEnd(text, close);
    if (at >= 0) {
      lines.push(text.slice(0, at));
      return { content: lines.join('\n'), line };
    }
    lines.push(text);
  }
  return null;
}

function findBlockClose(
  state: StateBlock,
  startLine: number,
  endLine: number,
  first: string,
  close: string,
): BlockClose | null {
  const at = closerAtEnd(first, close);
  if (at > 0 && first.indexOf(close) === at)
    return { content: first.slice(0, at), line: startLine };
  if (first.includes(close)) return null;
  const rest = scanFollowingLines(state, startLine, endLine, close);
  return rest && { content: `${first}\n${rest.content}`, line: rest.line };
}

function mathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const text = lineText(state, startLine);
  const delim = BLOCK_DELIMITERS.find((d) => text.startsWith(d.open));
  if (!delim) return false;
  const found = findBlockClose(
    state,
    startLine,
    endLine,
    text.slice(delim.open.length),
    delim.close,
  );
  if (!found) return false;
  if (silent) return true;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = found.content;
  token.markup = delim.open;
  token.map = [startLine, found.line + 1];
  state.line = found.line + 1;
  return true;
}

/** Registers the math rules on `md`; formulas render through `renderMath`. */
export function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx]?.content ?? '', false);
  md.renderer.rules.math_inline_display = (tokens, idx) =>
    renderMath(tokens[idx]?.content ?? '', true);
  md.renderer.rules.math_block = (tokens, idx) =>
    `${renderMath(tokens[idx]?.content ?? '', true)}\n`;
}
