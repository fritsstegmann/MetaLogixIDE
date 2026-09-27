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

const NO_FOCUS_TAGS = new Set(['BODY', 'HTML']);
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** null, BODY or HTML → 'none'; xterm helper textarea → 'terminal';
 *  INPUT / TEXTAREA / SELECT / contenteditable → 'text-entry'; anything else → 'control'. */
export function classifyActiveElement(el: ElementLike | null): ActiveElementKind {
  if (!el || NO_FOCUS_TAGS.has(el.tagName)) return 'none';
  if (el.tagName === 'TEXTAREA' && el.classList.contains(XTERM_TEXTAREA_CLASS)) return 'terminal';
  if (TEXT_ENTRY_TAGS.has(el.tagName) || el.isContentEditable) return 'text-entry';
  return 'control';
}

/** Window-focus rule: no overlay, and focus on nothing or on a non-text control. */
export function shouldTakeFocus(input: { overlayOpen: boolean; active: ActiveElementKind }): boolean {
  return !input.overlayOpen && (input.active === 'none' || input.active === 'control');
}

/** Notification-request rule: no overlay, and focus not in a text-entry element. */
export function shouldHonourRequest(input: { overlayOpen: boolean; active: ActiveElementKind }): boolean {
  return !input.overlayOpen && input.active !== 'text-entry';
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

interface PendingRequest { key: ShellKey; at: number }

const sameKey = (a: ShellKey, b: ShellKey): boolean =>
  a.projectId === b.projectId && a.shellIndex === b.shellIndex;

/** Builds the per-window focus owner. It tracks registered terminals, the
 *  last-used one, a window-focus target still waiting for `term.open()`, and
 *  one notification request that expires after `FOCUS_REQUEST_TTL_MS`. Every
 *  deferred focus re-checks the rule at the moment it would fire. */
export function createTerminalFocusCoordinator(deps: CoordinatorDeps): TerminalFocusCoordinator {
  const handles: TerminalHandle[] = [];
  let overlayOpen = false;
  let lastUsed: TerminalHandle | null = null;
  let pendingTarget: TerminalHandle | null = null;
  let request: PendingRequest | null = null;

  const ruleInput = () => ({ overlayOpen, active: deps.activeElementKind() });

  function pickTarget(): TerminalHandle | undefined {
    if (lastUsed) return lastUsed;
    return handles.find((h) => h.primary) ?? handles[0];
  }

  function consumeRequest(handle: TerminalHandle): boolean {
    if (!request) return false;
    if (deps.now() - request.at > FOCUS_REQUEST_TTL_MS) {
      request = null;
      return false;
    }
    if (!sameKey(request.key, handle.key)) return false;
    request = null;
    return shouldHonourRequest(ruleInput());
  }

  function opened(handle: TerminalHandle): void {
    const isPending = pendingTarget === handle;
    if (isPending) pendingTarget = null;
    if (consumeRequest(handle) || (isPending && shouldTakeFocus(ruleInput()))) handle.focus();
  }

  function unregister(handle: TerminalHandle): void {
    const i = handles.indexOf(handle);
    if (i >= 0) handles.splice(i, 1);
    if (lastUsed === handle) lastUsed = null;
    if (pendingTarget === handle) pendingTarget = null;
  }

  function onWindowFocus(): void {
    pendingTarget = null;
    if (!shouldTakeFocus(ruleInput())) return;
    const target = pickTarget();
    if (!target) return;
    if (target.isOpen()) target.focus();
    else pendingTarget = target;
  }

  function requestFocus(key: ShellKey): void {
    request = { key, at: deps.now() };
    const target = handles.find((h) => h.isOpen() && sameKey(h.key, key));
    if (target && consumeRequest(target)) target.focus();
  }

  return {
    register(handle) {
      handles.push(handle);
      return {
        opened: () => opened(handle),
        used: () => { if (handles.includes(handle)) lastUsed = handle; },
        unregister: () => unregister(handle),
      };
    },
    setOverlayOpen(open) { overlayOpen = open; },
    onWindowFocus,
    onWindowBlur() { pendingTarget = null; request = null; },
    requestFocus,
  };
}
