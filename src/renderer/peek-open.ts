/**
 * Decides what clicking a terminal path or its hover preview does, from the project the peeked file was found in, the
 * project the terminal belongs to, and whether the terminal sits in a popout window, and holds the preview open while
 * the pointer crosses from the path to the card. Pure, so the rules are unit-tested without a DOM; HoverPreview renders
 * the result and ShellTab/App carry out the open.
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

/** What {@link resolvePathClick} needs: the terminal's project, popout flag, the card's last peek, and a way to peek afresh. */
export interface PathClickContext {
  currentProjectId: number;
  popout: boolean;
  cached: { path: string; peek: PeekResult } | null;
  peek: (path: string) => Promise<PeekResult>;
}

/** Resolves a click on the printed `path` to an open request, reusing the card's peek for that path or peeking afresh; a failed peek opens nothing. */
export async function resolvePathClick(path: string, line: number | null, ctx: PathClickContext): Promise<PeekOpenRequest | null> {
  let result: PeekResult;
  try {
    result = ctx.cached?.path === path ? ctx.cached.peek : await ctx.peek(path);
  } catch {
    return null;
  }
  return peekClickRequest(result, line, ctx.currentProjectId, ctx.popout);
}

/** How long the preview stays up after the pointer leaves the path or the card, so it can cross the gap between them. */
export const PEEK_CLOSE_DELAY_MS = 200;

/** Timer functions {@link createHoverHold} schedules with; injectable so the hold is tested without real time. */
export interface HoldTimers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Keeps the preview open while the pointer is on the path or the card; `dispose` drops any pending close and resets both. */
export interface HoverHold {
  linkEnter: () => void;
  linkLeave: () => void;
  cardEnter: () => void;
  cardLeave: () => void;
  dispose: () => void;
}

/**
 * Creates the hold that closes the preview only once the pointer is on neither the path nor the card: `close` runs
 * `delayMs` after the pointer leaves the last of them, and entering either cancels it. Tracking both separately keeps
 * the card open whatever order the browser fires the card's pointerenter and xterm's mouseleave-driven link leave.
 */
export function createHoverHold(
  close: () => void,
  delayMs: number = PEEK_CLOSE_DELAY_MS,
  timers: HoldTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
): HoverHold {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let overLink = false;
  let overCard = false;
  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  const update = () => {
    cancel();
    if (overLink || overCard) return;
    pending = timers.set(() => { pending = null; close(); }, delayMs);
  };
  return {
    linkEnter: () => { overLink = true; update(); },
    linkLeave: () => { overLink = false; update(); },
    cardEnter: () => { overCard = true; update(); },
    cardLeave: () => { overCard = false; update(); },
    dispose: () => { overLink = false; overCard = false; cancel(); },
  };
}
