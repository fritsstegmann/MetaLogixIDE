/** OSC 52 tests: the pure parser rejects hostile payloads, and the installer is write-only and always claims the sequence. */
import { describe, expect, it, vi } from 'vitest';
import { OSC52_MAX_DECODED_BYTES, installOsc52, parseOsc52 } from '@renderer/terminal-osc52';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('parseOsc52', () => {
  it('decodes a clipboard write for each accepted selection parameter', () => {
    for (const selection of ['c', 'p', 's', '']) {
      expect(parseOsc52(`${selection};${b64('héllo 🌍')}`)).toEqual({
        kind: 'write',
        text: 'héllo 🌍',
      });
    }
  });

  it('ignores selection parameters other than c, p, s or empty', () => {
    expect(parseOsc52(`c;${b64('ok')}`)).not.toBeNull();
    for (const selection of ['0', 'x', 'q', 'cc', 'c0', ' c', 'C']) {
      expect(parseOsc52(`${selection};${b64('ok')}`)).toBeNull();
    }
  });

  it('ignores a read query and never turns it into a write', () => {
    expect(parseOsc52('c;?')).toBeNull();
    expect(parseOsc52(';?')).toBeNull();
  });

  it('rejects a sequence with no selection separator', () => {
    expect(parseOsc52(b64('no separator'))).toBeNull();
    expect(parseOsc52('')).toBeNull();
  });

  it('ignores an empty payload rather than clearing the clipboard', () => {
    expect(parseOsc52('c;')).toBeNull();
  });

  it('rejects base64 that a lenient decoder would accept', () => {
    const good = b64('payload!');
    expect(parseOsc52(`c;${good}`)).toEqual({ kind: 'write', text: 'payload!' });
    for (const bad of [
      `${good} `,
      ` ${good}`,
      good.slice(0, -1),
      `${good.slice(0, 4)}\n${good.slice(4)}`,
      'ab$d',
      'YQ',
      'YQ=',
      'Y===',
      'YQ==YQ==',
      'c;YQ==',
    ]) {
      expect(parseOsc52(`c;${bad}`)).toBeNull();
    }
  });

  it('rejects bytes that are not valid UTF-8', () => {
    expect(parseOsc52(`c;${Buffer.from([0x61, 0x62]).toString('base64')}`)).toEqual({
      kind: 'write',
      text: 'ab',
    });
    for (const bytes of [[0xff, 0xfe], [0xc3], [0xed, 0xa0, 0x80], [0x61, 0x80]]) {
      expect(parseOsc52(`c;${Buffer.from(bytes).toString('base64')}`)).toBeNull();
    }
  });

  it('accepts exactly 1 MiB decoded and rejects one byte more', () => {
    expect(parseOsc52(`c;${b64('a'.repeat(OSC52_MAX_DECODED_BYTES))}`)).toEqual({
      kind: 'write',
      text: 'a'.repeat(OSC52_MAX_DECODED_BYTES),
    });
    expect(parseOsc52(`c;${b64('a'.repeat(OSC52_MAX_DECODED_BYTES + 1))}`)).toBeNull();
    expect(OSC52_MAX_DECODED_BYTES).toBe(1024 * 1024);
  });

  it('rejects an oversized payload by its encoded length before decoding it', () => {
    const atob = vi.spyOn(globalThis, 'atob');
    try {
      expect(parseOsc52(`c;${'A'.repeat(8 * 1024 * 1024)}`)).toBeNull();
      expect(atob).not.toHaveBeenCalled();
      expect(parseOsc52(`c;${b64('small')}`)).not.toBeNull();
      expect(atob).toHaveBeenCalled();
    } finally {
      atob.mockRestore();
    }
  });
});

function fakeTerm() {
  const handlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
  const dispose = vi.fn();
  const write = vi.fn();
  const term = {
    write,
    input: write,
    paste: write,
    parser: {
      registerOscHandler: vi.fn(
        (ident: number, handler: (data: string) => boolean | Promise<boolean>) => {
          handlers.set(ident, handler);
          return { dispose };
        },
      ),
    },
  };
  return { term, handlers, dispose, write };
}

describe('installOsc52', () => {
  it('registers on OSC 52, writes decoded text to the clipboard and returns true', async () => {
    const { term, handlers } = fakeTerm();
    const writeClipboard = vi.fn(async () => undefined);
    installOsc52(term, { writeClipboard, onError: vi.fn() });
    expect(term.parser.registerOscHandler).toHaveBeenCalledWith(52, expect.any(Function));
    expect(handlers.get(52)?.(`c;${b64('copied text')}`)).toBe(true);
    expect(writeClipboard).toHaveBeenCalledOnce();
    expect(writeClipboard).toHaveBeenCalledWith('copied text');
  });

  it('claims every OSC 52 sequence, even hostile ones, without writing the clipboard or the PTY', () => {
    const { term, handlers, write } = fakeTerm();
    const writeClipboard = vi.fn(async () => undefined);
    installOsc52(term, { writeClipboard, onError: vi.fn() });
    const handler = handlers.get(52)!;
    for (const data of [
      'c;?',
      'x;YQ==',
      'nosep',
      'c;',
      'c;!!!!',
      `c;${'A'.repeat(2_000_000)}`,
      `c;${Buffer.from([0xff]).toString('base64')}`,
    ]) {
      expect(handler(data)).toBe(true);
    }
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(handler(`c;${b64('positive control')}`)).toBe(true);
    expect(writeClipboard).toHaveBeenCalledOnce();
  });

  it('reports a clipboard write failure through onError', async () => {
    const { term, handlers } = fakeTerm();
    const failure = new Error('denied');
    const onError = vi.fn();
    installOsc52(term, { writeClipboard: () => Promise.reject(failure), onError });
    handlers.get(52)?.(`c;${b64('x')}`);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });

  it('returns the registration so cleanup can dispose it', () => {
    const { term, dispose } = fakeTerm();
    const disposable = installOsc52(term, {
      writeClipboard: vi.fn(async () => undefined),
      onError: vi.fn(),
    });
    expect(dispose).not.toHaveBeenCalled();
    disposable.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
