/**
 * DOM glue for dropping onto a terminal (AC1, AC16, AC19, AC20). It snapshots the `DataTransfer`
 * synchronously (it is unreadable once the event returns), hands the snapshot to `planDrop` with
 * the real IPC, path and toast effects, and passes a non-empty payload to `paste`, which must be
 * `term.paste` so bracketed paste applies. It also drives the overlay through the enter/leave
 * depth counter. Logic lives in `terminal-drop.ts` and `drag-hover.ts`; this hook is covered by E2E.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api } from '@renderer/api';
import { createDragHover, dropKindFor, type DropKind } from '@renderer/drag-hover';
import { toast } from '@renderer/hooks/useToasts';
import { planDrop, type DropDeps } from '@renderer/terminal-drop';
import { pathStyleFor } from '@shared/shell-escape';
import { APP_FILE_DRAG_TYPE } from '@shared/terminal-drop-contract';

export interface TerminalDropOptions {
  /** Inserts the payload; called only with a non-empty string. */
  paste(text: string): void;
  /** True while the shell has exited, so drops insert nothing (AC16). */
  isExited(): boolean;
}

export interface TerminalDropHandlers {
  onDragEnter(e: DragEvent<HTMLElement>): void;
  onDragOver(e: DragEvent<HTMLElement>): void;
  onDragLeave(e: DragEvent<HTMLElement>): void;
  onDrop(e: DragEvent<HTMLElement>): void;
}

const dropDeps: DropDeps<File> = {
  style: pathStyleFor(api.platform),
  pathForFile: (file) => api.pathForFile(file),
  resolveAppFile: (payload) => api.invoke('drops:resolve-app-file', payload),
  stageFile: (request) => api.invoke('drops:stage-file', request),
  notify: (title, detail) => {
    toast(title, { kind: 'error', detail });
  },
};

/** Returns the overlay kind to render (null hides it) and the drag handlers for the terminal container. */
export function useTerminalDrop(options: TerminalDropOptions): {
  overlay: DropKind | null;
  handlers: TerminalDropHandlers;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const hover = useMemo(createDragHover, []);
  const [overlay, setOverlay] = useState<DropKind | null>(null);

  const reset = useCallback(() => {
    hover.reset();
    setOverlay(null);
  }, [hover]);

  useEffect(() => {
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
    };
  }, [reset]);

  const handlers = useMemo<TerminalDropHandlers>(
    () => ({
      onDragEnter: (e) => {
        hover.enter();
        setOverlay(dropKindFor(e.dataTransfer.types));
      },
      onDragOver: (e) => {
        if (!dropKindFor(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: () => {
        if (!hover.leave()) setOverlay(null);
      },
      onDrop: (e) => {
        reset();
        const dt = e.dataTransfer;
        if (!dropKindFor(dt.types)) return;
        e.preventDefault();
        if (optionsRef.current.isExited()) return;
        const snapshot = {
          appFile: dt.types.includes(APP_FILE_DRAG_TYPE) ? dt.getData(APP_FILE_DRAG_TYPE) : '',
          files: Array.from(dt.files),
          text: dt.getData('text/plain'),
        };
        void planDrop(snapshot, dropDeps)
          .then((payload) => {
            if (payload && !optionsRef.current.isExited()) optionsRef.current.paste(payload);
          })
          .catch((err: unknown) => console.error('[metaide] terminal drop failed', err));
      },
    }),
    [hover, reset],
  );

  return { overlay, handlers };
}
