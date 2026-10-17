/**
 * Paste sanitiser shared by every terminal drop and paste route (AC2). It replaces each C0 control
 * character other than TAB, LF and CR, plus DEL, with a space, so a payload carrying `ESC[201~`
 * can never end a bracketed paste early (GHSA-4jxv-xgrp-5m3r). Line endings are left for
 * `term.paste` to normalise.
 */
import type { SanitizePasteFn } from './terminal-drop-contract';

const UNSAFE_CONTROL = /[^\t\n\r\x20-\x7e\x80-\uffff]/g;

/** Returns `text` with every unsafe control character replaced by a space; length is preserved. */
export const sanitizePaste: SanitizePasteFn = (text) => text.replace(UNSAFE_CONTROL, ' ');
