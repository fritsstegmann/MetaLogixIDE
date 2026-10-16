import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installAgentStatus } from '@main/agent-status/install';

class FakePty extends EventEmitter {
  liveShell(): { pid: number; generation: string; agent: 'omp' } { return { pid: 12, generation: 'g1', agent: 'omp' }; }
  async liveBottomRows(): Promise<string[]> { return []; }
}

describe('status installer', () => {
  it('binds OMP credentials to the spawn, broadcasts only allowlisted changed entries, and revokes on exit', () => {
    const ptyManager = new FakePty();
    const receiver = { bind: vi.fn(), release: vi.fn(), setListener: vi.fn() };
    const broadcast = vi.fn();
    const { tracker, stop } = installAgentStatus({ ptyManager, receiver, broadcast, platform: 'win32' });
    ptyManager.emit('spawn', { projectId: 2, shellIndex: 1, pid: 12, generation: 'g1', agent: 'omp', ompSpawn: 'spawn' });
    expect(receiver.bind).toHaveBeenCalledWith({ projectId: 2, shellIndex: 1 }, 'spawn', 'g1');
    expect(tracker.list()).toEqual([{ projectId: 2, shellIndex: 1, agent: 'omp', state: 'idle' }]);
    tracker.ompReport({ projectId: 2, shellIndex: 1 }, 'g1', 'blocked');
    expect(broadcast).toHaveBeenLastCalledWith('agent-state:changed', { projectId: 2, shellIndex: 1, agent: 'omp', state: 'blocked' });
    ptyManager.emit('status-exit', { projectId: 2, shellIndex: 1, pid: 12, generation: 'g1', agent: 'omp' });
    expect(receiver.release).toHaveBeenCalledWith({ projectId: 2, shellIndex: 1 }, 'g1');
    expect(broadcast).toHaveBeenLastCalledWith('agent-state:changed', { projectId: 2, shellIndex: 1, agent: null, state: 'idle' });
    stop();
  });
});
