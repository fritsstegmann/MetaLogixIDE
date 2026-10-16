export interface RootFlagTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface RootFlags {
  platform: string | undefined;
  frostTerminal: boolean;
}

/** Sets the root attributes the macOS frosted-chrome CSS keys on. Off darwin, sets nothing mac-specific. */
export function applyRootFlags(el: RootFlagTarget, flags: RootFlags): void {
  void el; void flags;
  throw new Error('not implemented');
}

/** Reads the first-paint frosted-terminal value from a `location.search` string. Only `frostTerminal=1` is ON. */
export function parseFrostTerminalQuery(search: string): boolean {
  void search;
  throw new Error('not implemented');
}
