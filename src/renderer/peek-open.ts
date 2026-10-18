/**
 * Decides what clicking a terminal path or its hover preview does, from the project the peeked file was found in, the
 * project the terminal belongs to, and whether the terminal sits in a popout window. Pure, so the rules are unit-tested
 * without a DOM; HoverPreview renders the result and ShellTab/App carry out the open.
 */

/** Exact test ids for the hover preview's click affordances. */
export const PEEK_TESTIDS = {
  card: 'hover-preview',
  footer: 'hover-preview-footer',
  note: 'hover-preview-note',
} as const;

/** Exact user-facing strings for the hover preview's click affordances. */
export const PEEK_COPY = {
  openHere: 'Click to open',
  notFound: 'Not found in any of your projects.',
  switchProject: 'Click to switch project and open',
  outsideProjects: 'Outside your projects — preview only',
  popoutOtherProject: 'In another project — open it from the main window',
} as const;

/** What a click on the preview does: open in this project, switch to another project and open there, or nothing (with an optional note saying why). */
export type PeekOpenAction =
  | { kind: 'open-here' }
  | { kind: 'switch-project'; projectId: number }
  | { kind: 'disabled'; note: string | null };

/** Inputs to {@link peekOpenAction}: the peek result's `found` and `projectId`, the terminal's project, and whether it is a popout. */
export interface PeekOpenInput {
  found: boolean;
  projectId: number | null;
  currentProjectId: number;
  popout: boolean;
}

/** The open request a click sends to `onOpenFile`; `projectId` is set only when the file belongs to another project. */
export interface PeekOpenRequest {
  relPath: string;
  line: number | null;
  projectId?: number;
}

/** Chooses the click action for a peek result; a miss gives a silent disabled action because the preview already says "not found". */
export function peekOpenAction({ found, projectId, currentProjectId, popout }: PeekOpenInput): PeekOpenAction {
  if (!found) return { kind: 'disabled', note: null };
  if (projectId === null) return { kind: 'disabled', note: PEEK_COPY.outsideProjects };
  if (projectId === currentProjectId) return { kind: 'open-here' };
  if (popout) return { kind: 'disabled', note: PEEK_COPY.popoutOtherProject };
  return { kind: 'switch-project', projectId };
}

/** Turns a click action into the request for `onOpenFile`, or null when the click must do nothing. */
export function peekOpenRequest(action: PeekOpenAction, relPath: string, line: number | null): PeekOpenRequest | null {
  if (action.kind === 'open-here') return { relPath, line };
  if (action.kind === 'switch-project') return { relPath, line, projectId: action.projectId };
  return null;
}

/** The parts of a `files:peek` result the click routing reads. */
export interface PeekResult {
  relPath: string;
  projectId: number | null;
  found: boolean;
}

/**
 * The open request for a click on the printed path itself, routed by the same rules as the preview card: the peek
 * result decides, through {@link peekOpenAction}, whether to open here, switch project, or do nothing (null).
 */
export function peekClickRequest(peek: PeekResult, line: number | null, currentProjectId: number, popout: boolean): PeekOpenRequest | null {
  const action = peekOpenAction({ found: peek.found, projectId: peek.projectId, currentProjectId, popout });
  return peekOpenRequest(action, peek.relPath, line);
}

/** What {@link resolvePathClick} needs: the terminal's project, popout flag, and a way to peek a path. */
export interface PathClickContext {
  currentProjectId: number;
  popout: boolean;
  peek: (path: string) => Promise<PeekResult>;
}

/**
 * Resolves a click on the printed `path` to an open request from a fresh peek, so the decision always reflects the file
 * as it is at click time rather than a preview fetched earlier; a failed peek opens nothing.
 */
export async function resolvePathClick(path: string, line: number | null, ctx: PathClickContext): Promise<PeekOpenRequest | null> {
  let result: PeekResult;
  try {
    result = await ctx.peek(path);
  } catch {
    return null;
  }
  return peekClickRequest(result, line, ctx.currentProjectId, ctx.popout);
}
