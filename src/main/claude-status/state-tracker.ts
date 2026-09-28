/**
 * Per-shell Claude state machine (service layer): idle, busy or blocked,
 * driven by authenticated hook events, answering keystrokes written to a
 * blocked shell, and a stale-busy guard over PTY output silence. An entry
 * counts only while its hook session is the shell's current one, so a
 * respawn, a release or a shell that never had a session reads idle with no
 * extra plumbing. Changes are emitted only on real transitions and carry
 * nothing but the shell key and the state. Never consults notification
 * toggles or what the user is viewing (AC11), and never logs PTY input.
 */
import { stateTransitionFor } from '@main/claude-hooks/hook-event';
import type { ReceivedHook } from '@main/claude-hooks/receiver';
import type { ShellKey } from '@main/claude-hooks/session-registry';
import type { ClaudeShellState, ClaudeShellStateEntry } from '@shared/claude-state';
import { isAnsweringInput } from './answer-input';

/** A busy shell with no PTY output for this long becomes idle (spec D3). */
export const STALE_BUSY_MS = 15_000;

/** Injected ports; `lastOutputAt` is the ms epoch of the shell's last PTY output, or null when unknown. */
export interface ClaudeStateTrackerDeps {
  sessions: { confirm(sessionId: string): boolean; currentId(shell: ShellKey): string | null };
  lastOutputAt(shell: ShellKey): number | null;
  now(): number;
}

/** Receives one entry per real state transition. */
export type ClaudeStateListener = (entry: ClaudeShellStateEntry) => void;

interface Entry {
  shell: ShellKey;
  sessionId: string;
  state: Exclude<ClaudeShellState, 'idle'>;
  since: number;
}

const shellKeyString = (shell: ShellKey): string => `${shell.projectId}:${shell.shellIndex}`;

/** Tracks each hook-tracked shell's Claude state; see the module docblock. */
export class ClaudeStateTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<ClaudeStateListener>();

  constructor(private readonly deps: ClaudeStateTrackerDeps) {}

  /** Applies one authenticated hook event; events from a released session are dropped (AC9). */
  handle(hook: ReceivedHook): void {
    if (!this.deps.sessions.confirm(hook.sessionId)) return;
    const next = stateTransitionFor(hook.event);
    if (next === null) return;
    this.transition(hook.shell, hook.sessionId, next);
  }

  /** Moves a blocked shell to busy when `data` answers its prompt (AC7); otherwise does nothing. */
  onInput(shell: ShellKey, data: string): void {
    const entry = this.currentEntry(shell);
    if (entry?.state !== 'blocked' || !isAnsweringInput(data)) return;
    this.transition(shell, entry.sessionId, 'busy');
  }

  /** Expires busy shells silent for `STALE_BUSY_MS` (AC8) and drops entries of replaced sessions. */
  tick(): void {
    const now = this.deps.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.state !== 'busy') continue;
      if (!this.isCurrent(entry)) { this.entries.delete(shellKeyString(entry.shell)); continue; }
      const lastActive = Math.max(entry.since, this.deps.lastOutputAt(entry.shell) ?? entry.since);
      if (now - lastActive >= STALE_BUSY_MS) this.transition(entry.shell, entry.sessionId, 'idle');
    }
  }

  /** Discards the shell's state after its PTY exited, emitting idle when it was busy or blocked (AC9). */
  shellExited(shell: ShellKey): void {
    const key = shellKeyString(shell);
    if (!this.entries.delete(key)) return;
    this.emit(shell, 'idle');
  }

  /** The shell's current state; idle unless its entry belongs to its current hook session. */
  stateOf(shell: ShellKey): ClaudeShellState {
    return this.currentEntry(shell)?.state ?? 'idle';
  }

  /** Every shell whose current state is busy or blocked, as fresh entries. */
  list(): ClaudeShellStateEntry[] {
    return [...this.entries.values()]
      .filter((entry) => this.isCurrent(entry))
      .map((entry) => toStateEntry(entry.shell, entry.state));
  }

  /** Subscribes to state transitions; returns the unsubscribe function. */
  onChange(listener: ClaudeStateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private transition(shell: ShellKey, sessionId: string, next: ClaudeShellState): void {
    const previous = this.stateOf(shell);
    const key = shellKeyString(shell);
    if (next === 'idle') this.entries.delete(key);
    else this.entries.set(key, { shell: { ...shell }, sessionId, state: next, since: this.deps.now() });
    if (next !== previous) this.emit(shell, next);
  }

  private currentEntry(shell: ShellKey): Entry | null {
    const entry = this.entries.get(shellKeyString(shell));
    return entry && this.isCurrent(entry) ? entry : null;
  }

  private isCurrent(entry: Entry): boolean {
    return entry.sessionId === this.deps.sessions.currentId(entry.shell);
  }

  private emit(shell: ShellKey, state: ClaudeShellState): void {
    console.debug('[claude-status] state changed', toStateEntry(shell, state));
    for (const listener of this.listeners) listener(toStateEntry(shell, state));
  }
}

function toStateEntry(shell: ShellKey, state: ClaudeShellState): ClaudeShellStateEntry {
  return { projectId: shell.projectId, shellIndex: shell.shellIndex, state };
}
