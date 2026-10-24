/**
 * Write-only OSC 52 clipboard support for terminals whose PTY runs on another machine. A TUI that
 * owns the mouse (Claude Code fullscreen) copies by emitting `ESC ] 52 ; <selection> ; <base64> BEL`;
 * this module turns that into a local clipboard write. Reads (`?`) are never answered, and anything
 * outside the strict grammar (selection `c`, `p`, `s` or empty; canonical padded base64; fatal UTF-8;
 * at most 1 MiB decoded) is dropped without a reply.
 */
import type { IDisposable, IParser } from '@xterm/xterm';

export const OSC52_MAX_DECODED_BYTES = 1024 * 1024;
const MAX_ENCODED_LENGTH = Math.ceil(OSC52_MAX_DECODED_BYTES / 3) * 4;
const SELECTIONS: ReadonlySet<string> = new Set(['', 'c', 'p', 's']);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A clipboard write requested by an OSC 52 sequence. */
export interface Osc52Write {
  readonly kind: 'write';
  readonly text: string;
}

/** The slice of an xterm Terminal the installer touches. */
export interface Osc52Host {
  readonly parser: Pick<IParser, 'registerOscHandler'>;
}

/** What the installed handler needs: the clipboard sink and where a failed write is reported. */
export interface Osc52Deps {
  readonly writeClipboard: (text: string) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

function decodeBase64Utf8(payload: string): string | null {
  if (payload.length > MAX_ENCODED_LENGTH || !BASE64.test(payload)) return null;
  const binary = atob(payload);
  if (binary.length > OSC52_MAX_DECODED_BYTES) return null;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Parses the data of an OSC 52 sequence (the text after `52;`) into a clipboard write, or null to ignore it. */
export function parseOsc52(data: string): Osc52Write | null {
  const separator = data.indexOf(';');
  if (separator < 0 || !SELECTIONS.has(data.slice(0, separator))) return null;
  const payload = data.slice(separator + 1);
  if (payload === '' || payload === '?') return null;
  const text = decodeBase64Utf8(payload);
  return text === null ? null : { kind: 'write', text };
}

/** Registers the write-only OSC 52 handler on `term`; the handler claims every sequence so xterm never falls back. Dispose the result on cleanup. */
export function installOsc52(term: Osc52Host, deps: Osc52Deps): IDisposable {
  return term.parser.registerOscHandler(52, (data) => {
    const request = parseOsc52(data);
    if (request) deps.writeClipboard(request.text).catch(deps.onError);
    return true;
  });
}
