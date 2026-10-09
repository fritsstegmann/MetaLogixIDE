/** Framework-free, per-window store for the shared terminal font weight, kept in sync with the main-process settings store through injected ports. */
import { FONT_COPY } from '@renderer/fonts/font-contract';
import {
  TERMINAL_FONT_WEIGHT_DEFAULT,
  TERMINAL_FONT_WEIGHT_KEY,
  parseTerminalFontWeight,
  type TerminalFontWeight,
} from '@shared/terminal-font-weight';

export interface TerminalFontWeightSnapshot {
  readonly weight: TerminalFontWeight;
  readonly ready: boolean;
}

/** IO the store needs; the provider adapts the IPC api and toasts to these. */
export interface TerminalFontWeightPorts {
  loadStored(): Promise<unknown>;
  save(value: TerminalFontWeight): Promise<unknown>;
  onSettingsChanged(listener: (key: string) => void): () => void;
  notifySaveFailed(message: string): void;
  reportError(context: string, error: unknown): void;
}

export interface TerminalFontWeightStore {
  getSnapshot(): TerminalFontWeightSnapshot;
  subscribe(listener: () => void): () => void;
  setWeight(next: TerminalFontWeight): void;
  connect(): () => void;
}

/**
 * Creates the store. `connect` loads the stored weight (nothing stored means the 400 default, with no
 * write; an invalid stored value is reported and left untouched) and follows `settings:changed`; it
 * returns the disconnect. `setWeight` applies optimistically and persists; a failed save reports once
 * and reverts to the re-read stored value. Every async publish is version-guarded so a stale read can
 * never overwrite a newer weight.
 */
export function createTerminalFontWeightStore(ports: TerminalFontWeightPorts): TerminalFontWeightStore {
  let snapshot: TerminalFontWeightSnapshot = { weight: TERMINAL_FONT_WEIGHT_DEFAULT, ready: false };
  let version = 0;
  let connected = false;
  const listeners = new Set<() => void>();

  function publish(next: TerminalFontWeightSnapshot): void {
    if (next.weight === snapshot.weight && next.ready === snapshot.ready) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  async function resolveStored(): Promise<TerminalFontWeight> {
    const stored = await ports.loadStored();
    if (stored === null) return TERMINAL_FONT_WEIGHT_DEFAULT;
    const parsed = parseTerminalFontWeight(stored);
    if (!parsed.ok) throw new Error(`invalid persisted ${TERMINAL_FONT_WEIGHT_KEY}: ${parsed.error}`);
    return parsed.value;
  }

  async function sync(): Promise<void> {
    const syncVersion = ++version;
    try {
      const weight = await resolveStored();
      if (connected && syncVersion === version) publish({ weight, ready: true });
    } catch (error) {
      if (connected && syncVersion === version) publish({ ...snapshot, ready: true });
      ports.reportError('terminal font weight load failed', error);
    }
  }

  function persist(value: TerminalFontWeight): void {
    ports.save(value).catch((error: unknown) => {
      ports.reportError('terminal font weight save failed', error);
      ports.notifySaveFailed(FONT_COPY.terminalWeightSaveFailed);
      return sync();
    });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setWeight(next) {
      if (!snapshot.ready || next === snapshot.weight) return;
      version += 1;
      publish({ weight: next, ready: true });
      persist(next);
    },
    connect() {
      connected = true;
      const off = ports.onSettingsChanged((key) => {
        if (key === TERMINAL_FONT_WEIGHT_KEY) void sync();
      });
      void sync();
      return () => {
        connected = false;
        version += 1;
        off();
      };
    },
  };
}
