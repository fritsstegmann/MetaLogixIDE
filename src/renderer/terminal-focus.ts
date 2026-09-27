// Decides whether, and which, shell terminal takes keyboard focus when a
// window regains OS focus or a notification asks for a shell. DOM-free so
// it runs in the node test environment; the DOM adapter lives in
// hooks/useWindowTerminalFocus.ts.

export type ActiveElementKind = 'none' | 'terminal' | 'text-entry' | 'control';

/** Structural subset of Element, so the classifier runs in the node test environment. */
export interface ElementLike {
  tagName: string;
  isContentEditable: boolean;
  classList: { contains(token: string): boolean };
}

export const XTERM_TEXTAREA_CLASS = 'xterm-helper-textarea';
export const FOCUS_REQUEST_TTL_MS = 5000; // covers ShellTab's <=2s open gate + snapshot

/** null, BODY or HTML → 'none'; xterm helper textarea → 'terminal';
 *  INPUT / TEXTAREA / SELECT / contenteditable → 'text-entry'; anything else → 'control'. */
export function classifyActiveElement(_el: ElementLike | null): ActiveElementKind {
  void _el;
  throw new Error('not implemented');
}

/** Window-focus rule: no overlay, and focus on nothing or on a non-text control. */
export function shouldTakeFocus(_input: { overlayOpen: boolean; active: ActiveElementKind }): boolean {
  void _input;
  throw new Error('not implemented');
}

/** Notification-request rule: no overlay, and focus not in a text-entry element. */
export function shouldHonourRequest(_input: { overlayOpen: boolean; active: ActiveElementKind }): boolean {
  void _input;
  throw new Error('not implemented');
}

export interface ShellKey { projectId: number; shellIndex: number }

export interface TerminalHandle {
  key: ShellKey;
  primary: boolean;          // left pane / popout terminal
  isOpen(): boolean;         // true after term.open()
  focus(): void;             // term.focus()
}

export interface TerminalRegistration {
  opened(): void;            // call right after term.open()
  used(): void;              // call on the xterm textarea's 'focus' event
  unregister(): void;        // call in effect cleanup
}

export interface TerminalFocusCoordinator {
  register(handle: TerminalHandle): TerminalRegistration;
  setOverlayOpen(open: boolean): void;
  onWindowFocus(): void;
  onWindowBlur(): void;
  requestFocus(key: ShellKey): void;
}

export interface CoordinatorDeps {
  activeElementKind(): ActiveElementKind;
  now(): number;
}

export function createTerminalFocusCoordinator(_deps: CoordinatorDeps): TerminalFocusCoordinator {
  void _deps;
  throw new Error('not implemented');
}
