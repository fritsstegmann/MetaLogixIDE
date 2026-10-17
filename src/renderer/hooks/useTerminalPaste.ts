/**
 * DOM glue for pasting into a terminal (AC12, AC12a, AC13). A capture-phase `paste` listener on the
 * xterm host runs before xterm's own textarea listener, so macOS Cmd+V and Edit > Paste are routed
 * through `resolveClipboardPaste` instead of xterm's text-only paste. `pasteFromText` is the same
 * route for callers that read the clipboard themselves (Ctrl+Shift+V, the context menu). `paste`
 * must be `term.paste` and is called only with a non-empty payload. Covered by E2E.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { api } from '@renderer/api';
import { resolveClipboardPaste, type ClipboardPasteDeps } from '@renderer/clipboard-paste';
import { toast } from '@renderer/hooks/useToasts';
import { pathStyleFor } from '@shared/shell-escape';

const clipboardDeps: ClipboardPasteDeps = {
  style: pathStyleFor(api.platform),
  stageClipboardImage: () => api.invoke('drops:stage-clipboard-image', undefined),
  notify: (title, detail) => {
    toast(title, { kind: 'error', detail });
  },
};

/** Installs the paste interceptor on `hostRef` and returns a stable `pasteFromText(text)`. */
export function useTerminalPaste(
  hostRef: RefObject<HTMLElement>,
  paste: (text: string) => void,
): (text: string) => Promise<void> {
  const pasteRef = useRef(paste);
  pasteRef.current = paste;

  const pasteFromText = useCallback(async (text: string) => {
    const payload = await resolveClipboardPaste(text, clipboardDeps);
    if (payload) pasteRef.current(payload);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData('text/plain') ?? '';
      pasteFromText(text).catch((err: unknown) =>
        console.error('[metaide] terminal paste failed', err),
      );
    };
    host.addEventListener('paste', onPaste, true);
    return () => host.removeEventListener('paste', onPaste, true);
  }, [hostRef, pasteFromText]);

  return pasteFromText;
}
