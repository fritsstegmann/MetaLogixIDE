import { describe, it, expect } from 'vitest';
import { PtyManager } from '@main/pty/manager';
import { resolve } from 'node:path';

const MOCK = resolve(__dirname, '../../../../scripts/mock-claude.mjs');

function launch(extraArgs: string[] = []) {
  return { argv: ['node', MOCK, ...extraArgs], env: {}, cwd: process.cwd(), variant: 'first' as const };
}

const PRINT_SIZE = 'process.stdout.write(`SIZE=${process.stdout.columns}x${process.stdout.rows}\\n`); setTimeout(() => {}, 500)';

function sizeLaunch() {
  return { argv: ['node', '-e', PRINT_SIZE], env: {}, cwd: process.cwd(), variant: 'first' as const };
}

async function untilData(mgr: PtyManager, projectId: number, match: string, timeoutMs = 3000): Promise<string> {
  let buf = '';
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`timeout waiting for ${match}; got ${buf}`)), timeoutMs);
    mgr.on('data', ({ projectId: pid, data }) => {
      if (pid !== projectId) return;
      buf += data;
      if (buf.includes(match)) { clearTimeout(timer); resolveP(buf); }
    });
  });
}

describe('PtyManager', () => {
  it('spawns a PTY and receives initial banner', async () => {
    const mgr = new PtyManager();
    const p = untilData(mgr, 1, 'mock-claude ready');
    await mgr.spawn(1, 0, launch());
    await p;
    expect(mgr.isAlive(1, 0)).toBe(true);
    await mgr.kill(1, 0);
  });

  it('write echoes back through data event', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(2, 0, launch());
    // Wait for initial banner.
    await untilData(mgr, 2, '> ');
    const p = untilData(mgr, 2, 'echo: hello');
    mgr.write(2, 0, 'hello\n');
    await p;
    await mgr.kill(2, 0);
  });

  it('kill removes the entry from list', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(3, 0, launch());
    await mgr.kill(3, 0);
    expect(mgr.list().find(s => s.projectId === 3)).toBeUndefined();
  });

  it('rejects duplicate spawn for same (project, index)', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(4, 0, launch());
    await expect(mgr.spawn(4, 0, launch())).rejects.toThrow();
    await mgr.kill(4, 0);
  });
  it('spawns at the size requested by a resize that arrived before the PTY existed', async () => {
    const mgr = new PtyManager();
    mgr.resize(5, 0, 180, 50);
    const p = untilData(mgr, 5, '\n');
    await mgr.spawn(5, 0, sizeLaunch());
    const out = await p;
    await mgr.kill(5, 0);
    expect(out).toContain('SIZE=180x50');
    expect(out).not.toContain('SIZE=100x30');
  });

  it('respawns at the last requested size after the previous PTY was killed', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(6, 0, launch());
    mgr.resize(6, 0, 150, 40);
    await mgr.kill(6, 0);
    const p = untilData(mgr, 6, '\n');
    await mgr.spawn(6, 0, sizeLaunch());
    const out = await p;
    await mgr.kill(6, 0);
    expect(out).toContain('SIZE=150x40');
  });

  it('keeps sizes per shell so one shell\'s resize does not size another', async () => {
    const mgr = new PtyManager();
    mgr.resize(7, 1, 180, 50);
    const p = untilData(mgr, 7, '\n');
    await mgr.spawn(7, 0, sizeLaunch());
    const out = await p;
    await mgr.kill(7, 0);
    expect(out).toContain('SIZE=100x30');
  });
});
