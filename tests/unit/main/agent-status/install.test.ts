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
  it('forwards authenticated receiver state immediately and detaches on stop', () => {
    const ptyManager = new FakePty();
    const callbacks: Array<(shell: { projectId: number; shellIndex: number }, generation: string, state: 'idle' | 'busy' | 'blocked') => void> = [];
    const receiver = { bind: vi.fn(), release: vi.fn(), setListener: vi.fn((listener: typeof callbacks[number]) => { callbacks.push(listener); }) };
    const broadcast = vi.fn();
    const { stop } = installAgentStatus({ ptyManager, receiver, broadcast, platform: 'win32' });
    ptyManager.emit('spawn', { projectId: 2, shellIndex: 1, pid: 12, generation: 'g1', agent: 'omp' });
    expect(receiver.bind).not.toHaveBeenCalled();
    expect(receiver.setListener).toHaveBeenCalledTimes(1);
    const listener = callbacks[0];
    listener?.({ projectId: 2, shellIndex: 1 }, 'g1', 'busy');
    expect(broadcast).toHaveBeenLastCalledWith('agent-state:changed', { projectId: 2, shellIndex: 1, agent: 'omp', state: 'busy' });
    listener?.({ projectId: 2, shellIndex: 1 }, 'old', 'blocked');
    expect(broadcast).toHaveBeenCalledTimes(2);
    stop();
    ptyManager.emit('status-exit', { projectId: 2, shellIndex: 1, generation: 'g1', agent: 'omp' });
    expect(receiver.release).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
  it('expires blocked status on the installed tick when the receiver stays unavailable', async () => {
    vi.useFakeTimers();
    try {
      const ptyManager = new FakePty();
      const receiver = { bind: vi.fn(), release: vi.fn(), setListener: vi.fn() };
      const broadcast = vi.fn();
      const { tracker, stop } = installAgentStatus({ ptyManager, receiver, broadcast, platform: 'win32' });
      try {
        ptyManager.emit('spawn', { projectId: 2, shellIndex: 1, pid: 12, generation: 'g1', agent: 'omp', ompSpawn: 'spawn' });
        tracker.ompReport({ projectId: 2, shellIndex: 1 }, 'g1', 'blocked');
        await vi.advanceTimersByTimeAsync(1750);
        expect(tracker.list()).toEqual([{ projectId: 2, shellIndex: 1, agent: 'omp', state: 'idle' }]);
        expect(broadcast).toHaveBeenLastCalledWith('agent-state:changed', { projectId: 2, shellIndex: 1, agent: 'omp', state: 'idle' });
        expect(broadcast).toHaveBeenCalledTimes(3);
      } finally {
        stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
