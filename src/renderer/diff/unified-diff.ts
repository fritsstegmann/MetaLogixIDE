/**
 * Parser for one file's unified diff as printed by `git diff` (spec AC14, AC15, AC18). It drops the file header,
 * keeps no raw `@@` text, reads each hunk body by the counts in its header (so content that looks like a header line
 * stays content), folds `\ No newline at end of file` into the previous line, and reports binary and mode-only diffs.
 */

export type DiffLineType = 'context' | 'removed' | 'added';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  noNewline?: true;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  hunks: Hunk[];
}

interface OpenHunk {
  hunk: Hunk;
  oldLeft: number;
  newLeft: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const LINE_TYPE: Record<string, DiffLineType | undefined> = { ' ': 'context', '-': 'removed', '+': 'added' };

function openHunk(header: RegExpExecArray): OpenHunk {
  return {
    hunk: { oldStart: Number(header[1]), newStart: Number(header[3]), lines: [] },
    oldLeft: header[2] === undefined ? 1 : Number(header[2]),
    newLeft: header[4] === undefined ? 1 : Number(header[4]),
  };
}

function readHeaderLine(line: string, out: ParsedDiff): void {
  if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') out.binary = true;
  else if (line.startsWith('old mode ')) out.oldMode = line.slice('old mode '.length);
  else if (line.startsWith('new mode ')) out.newMode = line.slice('new mode '.length);
}

function readBodyLine(line: string, open: OpenHunk): boolean {
  const type = LINE_TYPE[line.charAt(0)];
  if (!type) return false;
  if (type !== 'added') open.oldLeft--;
  if (type !== 'removed') open.newLeft--;
  open.hunk.lines.push({ type, text: line.slice(1) });
  return true;
}

function markNoNewline(open: OpenHunk | null): void {
  const last = open?.hunk.lines.at(-1);
  if (last) last.noNewline = true;
}

/** Parses `text` (one file's `git diff` output) into hunks plus the binary flag and any mode change. */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const out: ParsedDiff = { binary: false, hunks: [] };
  let open: OpenHunk | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('\\')) {
      markNoNewline(open);
      continue;
    }
    if (open && (open.oldLeft > 0 || open.newLeft > 0) && readBodyLine(line, open)) continue;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      open = openHunk(header);
      out.hunks.push(open.hunk);
    } else if (out.hunks.length === 0) {
      readHeaderLine(line, out);
    }
  }
  return out;
}
