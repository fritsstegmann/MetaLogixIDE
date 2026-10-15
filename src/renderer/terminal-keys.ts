/** Pure routing for keys pressed while a terminal is focused, plus the xterm custom key handler. */
import type { CreateTerminalKeyHandlerFn, RouteTerminalKeyFn, TerminalTabActionFn } from './shortcut-contract';

export const routeTerminalKey: RouteTerminalKeyFn = () => {
  throw new Error('not implemented');
};

export const createTerminalKeyHandler: CreateTerminalKeyHandlerFn = () => {
  throw new Error('not implemented');
};

export const terminalTabAction: TerminalTabActionFn = () => {
  throw new Error('not implemented');
};
