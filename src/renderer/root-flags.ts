import { FROST_ATTR, FROST_TERMINAL_QUERY_KEY, MAC_PLATFORM } from './frosted-chrome-contract';

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
  if (flags.platform === 'darwin') el.setAttribute(FROST_ATTR.platform, MAC_PLATFORM);
  if (flags.frostTerminal) el.setAttribute(FROST_ATTR.frostTerminal, '');
  else el.removeAttribute(FROST_ATTR.frostTerminal);
}

/** Reads the first-paint frosted-terminal value from a `location.search` string. Only `frostTerminal=1` is ON. */
export function parseFrostTerminalQuery(search: string): boolean {
  return new URLSearchParams(search).get(FROST_TERMINAL_QUERY_KEY) === '1';
}
