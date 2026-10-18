/**
 * Decides what clicking a terminal hover preview does, from the project the peeked file was found in, the project the
 * terminal belongs to, and whether the terminal sits in a popout window. Pure, so the routing rules are unit-tested
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
