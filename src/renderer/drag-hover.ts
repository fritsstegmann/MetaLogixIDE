/**
 * Pure state for the terminal drop overlay (AC19, AC20). `createDragHover` counts `dragenter`
 * against `dragleave` so crossing child elements never toggles the overlay, and `dropKindFor`
 * decides from a drag's types whether the drop will paste a path, paste text, or is not accepted.
 * `createExternalDragGuard` tells the window-level guard which drags started outside the app.
 */
import { APP_FILE_DRAG_TYPE } from '@shared/terminal-drop-contract';

export type DropKind = 'path' | 'text';

/** Enter/leave depth counter; `enter` and `leave` return whether the overlay should show. */
export interface DragHover {
  enter(): boolean;
  leave(): boolean;
  reset(): void;
}

/** Classifies drag types: `Files` or the Files-tree type → path, `text/plain` → text, else null. */
export function dropKindFor(types: readonly string[]): DropKind | null {
  if (types.includes('Files') || types.includes(APP_FILE_DRAG_TYPE)) return 'path';
  return types.includes('text/plain') ? 'text' : null;
}

/** Creates a depth counter that is visible while depth > 0; `reset` is for drop and dragend. */
export function createDragHover(): DragHover {
  let depth = 0;
  return {
    enter: () => {
      depth += 1;
      return true;
    },
    leave: () => {
      depth = Math.max(0, depth - 1);
      return depth > 0;
    },
    reset: () => {
      depth = 0;
    },
  };
}

/** Window-level drag guard state; `dragOver` and `drop` return whether to `preventDefault`. */
export interface ExternalDragGuard {
  dragStart(): void;
  dragEnd(): void;
  dragOver(): boolean;
  drop(): boolean;
}

/**
 * Creates the AC22 guard: a drag counts as in-app from `dragstart` in this window until `dragend`
 * or `drop`. Only drags that did not start here are swallowed, so in-app drags keep their native
 * default (text into the editor, inputs, the Find box).
 */
export function createExternalDragGuard(): ExternalDragGuard {
  let inApp = false;
  return {
    dragStart: () => {
      inApp = true;
    },
    dragEnd: () => {
      inApp = false;
    },
    dragOver: () => !inApp,
    drop: () => {
      const swallow = !inApp;
      inApp = false;
      return swallow;
    },
  };
}
