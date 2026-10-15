import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performance } from 'node:perf_hooks';

interface FakePty {
  pid: number;
  emitData: (data: string) => void;
  emitExit: (exitCode: number) => void;
  kill: () => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (ev: { exitCode: number }) => void) => void;
}

const ptys: FakePty[] = [];

vi.mock('node-pty', () => ({
  spawn: () => {
    let dataCb: (data: string) => void = () => {};
    let exitCb: (ev: { exitCode: number }) => void = () => {};
    const pty: FakePty = {
      pid: 4000 + ptys.length,
      emitData: (data) => dataCb(data),
      emitExit: (exitCode) => exitCb({ exitCode }),
      kill: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      onData: (cb) => { dataCb = cb; },
      onExit: (cb) => { exitCb = cb; },
    };
    ptys.push(pty);
    return pty;
  },
}));

const { PtyManager, RollingScrollback } = await import('@main/pty/manager');

const CAP = 256 * 1024;
const LAUNCH = { argv: ['fake-shell'], env: {}, cwd: process.cwd(), variant: 'first' as const };

type DataEvent = { projectId: number; shellIndex: number; data: string };

/** Spawns a fake shell and records every event the manager emits, in order. */
async function setup(shells: Array<[number, number]> = [[1, 0]]) {
  const mgr = new PtyManager();
  const events: Array<{ type: string; ev: Record<string, unknown> }> = [];
  for (const type of ['data', 'exit', 'ports']) {
    mgr.on(type, (ev: Record<string, unknown>) => events.push({ type, ev }));
  }
  const handles: FakePty[] = [];
  for (const [p, s] of shells) {
    await mgr.spawn(p, s, LAUNCH);
    handles.push(ptys[ptys.length - 1]!);
  }
  const data = () => events.filter((e) => e.type === 'data').map((e) => e.ev as DataEvent);
  return { mgr, events, handles, data };
}

describe('PtyManager output coalescing (H3)', () => {
  beforeEach(() => {
    ptys.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits many rapid chunks of one shell as a single data event, bytes and order intact', async () => {
    const { handles: [pty], data } = await setup();
    const chunks = Array.from({ length: 500 }, (_, i) => `chunk-${i}\r\n`);
    for (const c of chunks) pty!.emitData(c);
    expect(data()).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(data()).toEqual([{ projectId: 1, shellIndex: 0, data: chunks.join('') }]);
  });

  it('fires at most once per flush window and keeps order across windows', async () => {
    const { handles: [pty], data } = await setup();
    pty!.emitData('a');
    await vi.advanceTimersByTimeAsync(4);
    expect(data()).toEqual([]);
    pty!.emitData('b');
    await vi.advanceTimersByTimeAsync(1);
    expect(data().map((d) => d.data)).toEqual(['ab']);
    pty!.emitData('c');
    pty!.emitData('d');
    await vi.advanceTimersByTimeAsync(50);
    expect(data().map((d) => d.data)).toEqual(['ab', 'cd']);
  });

  it('coalesces per shell, never mixing bytes of different shells', async () => {
    const { handles: [a, b], data } = await setup([[1, 0], [1, 1]]);
    a!.emitData('A1');
    b!.emitData('B1');
    a!.emitData('A2');
    b!.emitData('B2');
    await vi.advanceTimersByTimeAsync(50);
    expect(data()).toHaveLength(2);
    expect(data()).toEqual(expect.arrayContaining([
      { projectId: 1, shellIndex: 0, data: 'A1A2' },
      { projectId: 1, shellIndex: 1, data: 'B1B2' },
    ]));
  });

  it('emits pending output before the exit event, without waiting for the window', async () => {
    const { handles: [pty], events } = await setup();
    pty!.emitData('last words\r\n');
    pty!.emitExit(3);
    expect(events.map((e) => e.type)).toEqual(['data', 'exit']);
    expect(events[0]!.ev).toEqual({ projectId: 1, shellIndex: 0, data: 'last words\r\n' });
    await vi.advanceTimersByTimeAsync(50);
    expect(events.filter((e) => e.type === 'data')).toHaveLength(1);
  });

  it('emits pending output on kill, exactly once', async () => {
    const { mgr, handles: [pty], data } = await setup();
    pty!.emitData('pending');
    await mgr.kill(1, 0);
    expect(data()).toEqual([{ projectId: 1, shellIndex: 0, data: 'pending' }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(data()).toHaveLength(1);
  });

  it('keeps scrollback and the screen mirror equal to what was emitted', async () => {
    const { mgr, handles: [pty], data } = await setup();
    pty!.emitData('\x1b[31mred');
    pty!.emitData('\x1b[0m tail');
    await vi.advanceTimersByTimeAsync(50);
    expect(mgr.getScrollback(1, 0)).toBe(data().map((d) => d.data).join(''));
    const snap = mgr.getSnapshot(1, 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await snap).toMatch(/red.*tail/);
  });

  it('does not expose unemitted output through getSnapshot', async () => {
    const { mgr, handles: [pty] } = await setup();
    pty!.emitData('NOT-YET');
    const snap = mgr.getSnapshot(1, 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await snap).not.toContain('NOT-YET');
    await mgr.kill(1, 0);
  });

  it('tracks lastDataAt per chunk, not per flush', async () => {
    const { mgr, handles: [pty] } = await setup();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    pty!.emitData('x');
    expect(mgr.liveShells()[0]!.lastDataAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('detects a port announced across two chunks of the same window', async () => {
    const { handles: [pty], events } = await setup();
    pty!.emitData('Local: http://localhost:51');
    pty!.emitData('73/\r\n');
    await vi.advanceTimersByTimeAsync(50);
    expect(events.filter((e) => e.type === 'ports').map((e) => e.ev)).toEqual([
      { projectId: 1, shellIndex: 0, ports: [5173] },
    ]);
  });

  it('searches the scrollback built from flushed output', async () => {
    const { mgr, handles: [pty] } = await setup();
    pty!.emitData('first\nan \x1b[31mERR');
    pty!.emitData('OR\x1b[0m here\nlast\n');
    await vi.advanceTimersByTimeAsync(50);
    expect(mgr.searchScrollback('error')).toEqual([{
      projectId: 1, shellIndex: 0, pid: pty!.pid,
      line: 'an ERROR here', lineNumber: 2, contextBefore: ['first'], contextAfter: ['last'],
    }]);
  });

  it('keeps early output captured per chunk for the exit report', async () => {
    const { mgr, handles: [pty] } = await setup();
    pty!.emitData('boot banner');
    expect(mgr.getEarlyBuffer(1, 0)).toBe('boot banner');
  });

  it('clears a port announced just before Ctrl-C, even though the flush is still pending (L1)', async () => {
    const { mgr, handles: [pty], events } = await setup();
    pty!.emitData('Local: http://localhost:3000\r\n');
    mgr.write(1, 0, '\x03');
    await vi.advanceTimersByTimeAsync(50);
    const portsEvents = events.filter((e) => e.type === 'ports').map((e) => e.ev as { ports: number[] });
    expect(portsEvents.some((e) => e.ports.includes(3000))).toBe(true);
    expect(portsEvents[portsEvents.length - 1]).toEqual({ projectId: 1, shellIndex: 0, ports: [] });
  });
});

/** A line-structured block of `size` characters. */
function lines(size: number, tag = 'x'): string {
  const line = `${tag.repeat(79)}\n`;
  return line.repeat(Math.ceil(size / line.length)).slice(0, size);
}

describe('RollingScrollback (H1)', () => {
  it('returns everything while under the cap', () => {
    const sb = new RollingScrollback();
    sb.append('hello ');
    sb.append('world');
    expect(sb.read()).toBe('hello world');
  });

  it('keeps only the most recent ≤256 KiB, cut at a line boundary', () => {
    const sb = new RollingScrollback();
    let full = '';
    for (let i = 0; i < 12_000; i++) {
      const chunk = `line ${i} ${'y'.repeat(i % 50)}\n`;
      full += chunk;
      sb.append(chunk);
    }
    const out = sb.read();
    expect(out.length).toBeLessThanOrEqual(CAP);
    expect(out.length).toBeGreaterThan(CAP - 8192);
    expect(full.endsWith(out)).toBe(true);
    expect(full[full.length - out.length - 1]).toBe('\n');
    expect(out.startsWith('line ')).toBe(true);
  });

  it('keeps the tail of a single chunk larger than the cap', () => {
    const sb = new RollingScrollback();
    const big = lines(3 * CAP, 'b') + 'END';
    sb.append(big);
    const out = sb.read();
    expect(out.length).toBeLessThanOrEqual(CAP);
    expect(big.endsWith(out)).toBe(true);
    expect(out.endsWith('END')).toBe(true);
    expect(big[big.length - out.length - 1]).toBe('\n');
  });

  it('stays a correct suffix under a stream of single-character chunks', () => {
    const sb = new RollingScrollback();
    const full = lines(CAP + 50_000, 'c');
    for (const ch of full) sb.append(ch);
    const out = sb.read();
    expect(out.length).toBeLessThanOrEqual(CAP);
    expect(full.endsWith(out)).toBe(true);
    expect(full[full.length - out.length - 1]).toBe('\n');
  });

  it('skips a dangling escape fragment at the cut to the next line', () => {
    const sb = new RollingScrollback();
    const escapes = '\x1b[1;2;3;'.repeat(1875);
    const stream = 'z'.repeat(CAP) + escapes + 'tail\n' + 'k'.repeat(CAP - 13_005);
    sb.append(stream);
    const out = sb.read();
    expect(out.startsWith('kkk')).toBe(true);
    expect(out).not.toContain('\x1b');
  });

  it('reads the same value repeatedly and keeps appending after a read', () => {
    const sb = new RollingScrollback();
    sb.append(lines(CAP + 1000));
    const first = sb.read();
    expect(sb.read()).toBe(first);
    sb.append('more\n');
    expect(sb.read().endsWith('more\n')).toBe(true);
    expect(sb.read().length).toBeLessThanOrEqual(CAP);
  });

  it('appending a chunk costs O(chunk), not O(cap)', () => {
    const chunk = `${'o'.repeat(110)}\n`;
    const timeAppends = (cap: number): number => {
      const sb = new RollingScrollback(cap);
      sb.append(lines(cap));
      const start = performance.now();
      for (let i = 0; i < 3000; i++) sb.append(chunk);
      return performance.now() - start;
    };
    timeAppends(4 * 1024);
    timeAppends(4 * 1024 * 1024);
    const small = Math.max(timeAppends(4 * 1024), 0.5);
    const large = timeAppends(4 * 1024 * 1024);
    expect(large / small).toBeLessThan(10);
  });

  it('does not retain the character data of chunks trimmed off the front (M1)', () => {
    const cap = 1024;
    const sb = new RollingScrollback(cap);
    const chunk = `${'x'.repeat(64)}\n`;
    for (let i = 0; i < 2000; i++) sb.append(chunk);
    const chunks = (sb as unknown as { chunks: string[] }).chunks;
    const retainedChars = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(retainedChars).toBeLessThanOrEqual(cap + chunk.length);
  });
});
