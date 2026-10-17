/**
 * Pure resolver behind every terminal paste route: the capture-phase `paste` event, the
 * Ctrl+Shift+V key path and the context-menu Paste item (AC12, AC12a, AC13, AC14). Clipboard text
 * is sanitised and returned; an empty clipboard asks the main process to stage a clipboard image
 * and returns its escaped path; neither yields null. Effects are injected through
 * `ClipboardPasteDeps`.
 */
import { sanitizePaste } from '@shared/paste-sanitize';
import { escapePath } from '@shared/shell-escape';
import {
  DROP_COPY,
  type ClipboardImageResult,
  type PathStyle,
} from '@shared/terminal-drop-contract';

/** Injected effects; `stageClipboardImage` wraps the `drops:stage-clipboard-image` channel. */
export interface ClipboardPasteDeps {
  readonly style: PathStyle;
  stageClipboardImage(): Promise<ClipboardImageResult>;
  notify(title: string, detail: string): void;
}

const CLIPBOARD_IMAGE_NAME = 'Clipboard image';

async function stagedImagePath(deps: ClipboardPasteDeps): Promise<string | null> {
  try {
    const result = await deps.stageClipboardImage();
    if (result.kind === 'staged') return escapePath(result.path, deps.style);
    if (result.kind === 'too-large') {
      deps.notify(DROP_COPY.tooLargeTitle, DROP_COPY.tooLargeDetail(CLIPBOARD_IMAGE_NAME));
    } else if (result.kind === 'failed') {
      deps.notify(DROP_COPY.clipboardImageFailedTitle, result.reason);
    }
  } catch (err) {
    deps.notify(
      DROP_COPY.clipboardImageFailedTitle,
      err instanceof Error ? err.message : String(err),
    );
  }
  return null;
}

/** Resolves clipboard text to the payload for `term.paste`, or null when there is nothing to paste. */
export async function resolveClipboardPaste(
  text: string,
  deps: ClipboardPasteDeps,
): Promise<string | null> {
  if (text !== '') return sanitizePaste(text);
  return stagedImagePath(deps);
}
