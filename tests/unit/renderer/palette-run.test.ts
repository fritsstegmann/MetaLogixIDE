/**
 * `runSafely` turns a command's sync throw or async rejection into one `onError` call (AC16), and
 * `runPaletteRow` dispatches a picked row: it always closes the palette, then picks the project
 * (unless it is the current one, AC8), opens the file (AC35) or runs the command safely (AC16).
 */
import { describe, it, expect, vi } from 'vitest';
import { runPaletteRow, runSafely } from '@renderer/palette-run';
import type { PaletteCommand, PaletteRow } from '@renderer/command-palette-contract';
import type { Project } from '@shared/types';

function project(id: number): Project {
  return {
    id, rootId: 1, path: `/p/${id}`, name: `p${id}`, metaprojectProjectId: null, linkedChatChannelId: null,
    lastOpenedAt: null, pinned: false, hidden: false, firstLaunchedAt: null, config: {} as Project['config'],
  };
}

function command(run: PaletteCommand['run']): PaletteCommand {
  return { id: 'c', title: 'C', category: 'App', run };
}

function handlers() {
  const calls: string[] = [];
  return {
    calls,
    onClose: vi.fn(() => { calls.push('close'); }),
    onPickProject: vi.fn((p: Project) => { calls.push(`project:${p.id}`); }),
    onPickFile: vi.fn((rel: string) => { calls.push(`file:${rel}`); }),
    onCommandError: vi.fn((e: unknown) => { calls.push(`error:${String(e)}`); }),
  };
}

describe('runSafely', () => {
  it('reports a synchronous throw once, with the original error', async () => {
    const err = new Error('sync');
    const onError = vi.fn();
    await runSafely(() => { throw err; }, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('reports an async rejection once, with the original error', async () => {
    const err = new Error('async');
    const onError = vi.fn();
    await runSafely(() => Promise.reject(err), onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('never calls onError when the command succeeds, sync or async', async () => {
    const onError = vi.fn();
    const sync = vi.fn();
    await runSafely(sync, onError);
    await runSafely(async () => { await Promise.resolve(); }, onError);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('settles only after the async command settles', async () => {
    let done = false;
    await runSafely(async () => { await new Promise((r) => setTimeout(r, 5)); done = true; }, vi.fn());
    expect(done).toBe(true);
  });
});

describe('runPaletteRow', () => {
  it('closes, then picks a project that is not current', async () => {
    const h = handlers();
    await runPaletteRow({ kind: 'project', project: project(2), current: false }, h);
    expect(h.calls).toEqual(['close', 'project:2']);
  });

  it('only closes when the current project is picked (AC8)', async () => {
    const h = handlers();
    await runPaletteRow({ kind: 'project', project: project(1), current: true }, h);
    expect(h.calls).toEqual(['close']);
    expect(h.onPickProject).not.toHaveBeenCalled();
  });

  it('closes, then opens a picked file by its relative path (AC35)', async () => {
    const h = handlers();
    await runPaletteRow({ kind: 'file', file: { relPath: 'src/a.ts', name: 'a.ts' } }, h);
    expect(h.calls).toEqual(['close', 'file:src/a.ts']);
  });

  it('closes before running a command', async () => {
    const h = handlers();
    const row: PaletteRow = { kind: 'command', command: command(() => { h.calls.push('run'); }) };
    await runPaletteRow(row, h);
    expect(h.calls).toEqual(['close', 'run']);
    expect(h.onCommandError).not.toHaveBeenCalled();
  });

  it('closes and reports a failing command instead of throwing (AC16)', async () => {
    const h = handlers();
    const row: PaletteRow = { kind: 'command', command: command(() => Promise.reject(new Error('boom'))) };
    await expect(runPaletteRow(row, h)).resolves.toBeUndefined();
    expect(h.calls).toEqual(['close', 'error:Error: boom']);
  });
});
