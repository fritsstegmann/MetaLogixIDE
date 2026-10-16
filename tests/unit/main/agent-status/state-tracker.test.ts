import { describe, expect, it, vi } from 'vitest';
import { AgentStatusTracker } from '@main/agent-status/state-tracker';

const shell = { projectId: 1, shellIndex: 0 };
const identity = { ...shell, pid: 10, generation: 'g1', agent: 'claude' as const };

describe('Agent status transitions', () => {
  it('uses app launch identity and current screen without consulting process sampling', async () => {
    let rows = ['> '];
    const observeForeground = vi.fn(async () => false);
    const liveShell = vi.fn(() => ({ pid: 10, generation: 'g1', agent: 'claude' as const }));
    const tracker = new AgentStatusTracker({ liveShell, liveBottomRows: async () => rows }, observeForeground, 'win32');
    tracker.spawn(identity);
    expect(tracker.list()).toEqual([{ ...shell, agent: 'claude', state: 'idle' }]);
    rows = ['✻ Thinking…', 'esc to interrupt'];
    await tracker.refresh();
    expect(tracker.list()[0]?.state).toBe('busy');
    rows = ['Allow Bash command?', 'Esc to cancel'];
    await tracker.refresh();
    expect(tracker.list()[0]?.state).toBe('blocked');
    rows = ['> '];
    await tracker.refresh();
    expect(tracker.list()[0]?.state).toBe('idle');
    expect(observeForeground).not.toHaveBeenCalled();
    tracker.exit(identity);
    expect(tracker.list()).toEqual([]);
  });

  it('manual Windows remains idle and replaced generations reject old reports', async () => {
    const observed = vi.fn(async () => true);
    let generation = 'g1';
    const liveShell = vi.fn(() => ({ pid: 10, generation, agent: null }));
    const tracker = new AgentStatusTracker({ liveShell, liveBottomRows: async () => ['Allow Bash command?', 'Esc to cancel'] }, observed, 'win32');
    tracker.spawn({ ...identity, agent: null });
    await tracker.refresh();
    expect(tracker.list()).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
    generation = 'g2';
    tracker.spawn({ ...identity, generation: 'g2', agent: 'omp' });
    tracker.ompReport(shell, 'g1', 'blocked');
    expect(tracker.list()).toEqual([{ ...shell, agent: 'omp', state: 'idle' }]);
  });
  it('manual POSIX Claude appears only while it owns the foreground and stale samples cannot revive it', async () => {
    let foreground = true;
    const observe = vi.fn(async () => foreground);
    const liveShell = () => ({ pid: 10, generation: 'g1', agent: null });
    const tracker = new AgentStatusTracker({ liveShell, liveBottomRows: async () => ['✻ Thinking…', 'esc to interrupt'] }, observe, 'darwin');
    tracker.spawn({ ...identity, agent: null });
    await tracker.refresh();
    expect(tracker.list()).toEqual([{ ...shell, agent: 'claude', state: 'busy' }]);
    foreground = false;
    await tracker.refresh();
    expect(tracker.list()).toEqual([]);
    expect(observe).toHaveBeenCalledWith(10);
  });
});
