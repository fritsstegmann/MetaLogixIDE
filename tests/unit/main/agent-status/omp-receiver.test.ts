import { describe, expect, it, vi } from 'vitest';
import { OmpReceiver, parseOmpEnvelope } from '@main/agent-status/omp-receiver';

const valid = { spawn: 'spawn-1', token: 'secret-1', report: { version: 1, session: 's1', seq: 1, event: 'session_start' } };

describe('OMP untrusted report boundary', () => {
  it('rejects unknown keys, bad types, oversized data and unsupported events', () => {
    expect(parseOmpEnvelope(JSON.stringify(valid))).toEqual(valid);
    expect(parseOmpEnvelope(JSON.stringify({ ...valid, shellIndex: 3 }))).toBeNull();
    expect(parseOmpEnvelope(JSON.stringify({ ...valid, report: { ...valid.report, prompt: 'secret' } }))).toBeNull();
    expect(parseOmpEnvelope(JSON.stringify({ ...valid, report: { ...valid.report, seq: 0 } }))).toBeNull();
    expect(parseOmpEnvelope(JSON.stringify({ ...valid, report: { ...valid.report, event: 'nested' } }))).toBeNull();
    expect(parseOmpEnvelope('x'.repeat(1025))).toBeNull();
    expect(parseOmpEnvelope('{')).toBeNull();
    expect(parseOmpEnvelope(JSON.stringify({ ...valid, report: { ...valid.report, active: 'yes' } }))).toBeNull();
    expect(parseOmpEnvelope(JSON.stringify({ ...valid, report: { ...valid.report, session: '' } }))).toBeNull();
  });

  it('accepts only live authenticated generation and rejects stale replay', () => {
    const onReport = vi.fn();
    const receiver = new OmpReceiver(onReport);
    const creds = receiver.issue({ projectId: 1, shellIndex: 2 });
    receiver.bind({ projectId: 1, shellIndex: 2 }, creds.spawn, 'generation-1');
    const line = JSON.stringify({ ...valid, spawn: creds.spawn, token: creds.token });
    expect(receiver.accept(line)).toBe(true);
    expect(receiver.accept(line)).toBe(false);
    expect(receiver.accept(JSON.stringify({ ...valid, spawn: creds.spawn, token: 'wrong', report: { ...valid.report, seq: 2 } }))).toBe(false);
    expect(receiver.accept(JSON.stringify({ ...valid, spawn: creds.spawn, token: creds.token, report: { ...valid.report, seq: 3, event: 'agent_start', session: 'nested' } }))).toBe(false);
    expect(receiver.accept(JSON.stringify({ ...valid, spawn: creds.spawn, token: creds.token, report: { ...valid.report, seq: 2, event: 'agent_start' } }))).toBe(true);
    expect(receiver.accept(JSON.stringify({ ...valid, spawn: creds.spawn, token: creds.token, report: { ...valid.report, seq: 1, event: 'agent_end' } }))).toBe(false);
    expect(onReport).toHaveBeenCalledTimes(2);
    expect(onReport).toHaveBeenLastCalledWith({ projectId: 1, shellIndex: 2 }, 'generation-1', 'busy');
    receiver.release({ projectId: 1, shellIndex: 2 }, 'generation-1');
    expect(receiver.accept(JSON.stringify({ ...valid, spawn: creds.spawn, token: creds.token, report: { ...valid.report, seq: 2 } }))).toBe(false);
  });
  it('keeps shells isolated and does not let an old exit revoke the replacement', () => {
    const onReport = vi.fn();
    const receiver = new OmpReceiver(onReport);
    const shell = { projectId: 5, shellIndex: 0 };
    const other = { projectId: 5, shellIndex: 1 };
    const first = receiver.issue(shell);
    const second = receiver.issue(other);
    receiver.bind(shell, first.spawn, 'old');
    receiver.bind(other, second.spawn, 'other');
    expect(receiver.accept(JSON.stringify({ ...valid, spawn: first.spawn, token: second.token }))).toBe(false);
    const replacement = receiver.issue(shell);
    receiver.bind(shell, replacement.spawn, 'new');
    receiver.release(shell, 'old');
    expect(receiver.accept(JSON.stringify({ ...valid, spawn: first.spawn, token: first.token }))).toBe(false);
    expect(receiver.accept(JSON.stringify({ ...valid, spawn: replacement.spawn, token: replacement.token }))).toBe(true);
    expect(onReport).toHaveBeenCalledWith(shell, 'new', 'idle');
    expect(onReport).not.toHaveBeenCalledWith(other, 'new', 'idle');
  });
  it('bounds authenticated event frequency per spawn', () => {
    const receiver = new OmpReceiver();
    const shell = { projectId: 9, shellIndex: 0 };
    const creds = receiver.issue(shell);
    receiver.bind(shell, creds.spawn, 'generation');
    const packet = (seq: number): string => JSON.stringify({
      spawn: creds.spawn, token: creds.token,
      report: { version: 1, session: 'session', seq, event: seq === 1 ? 'session_start' : 'agent_start' },
    });
    for (let seq = 1; seq <= 100; seq++) expect(receiver.accept(packet(seq))).toBe(true);
    expect(receiver.accept(packet(101))).toBe(false);
  });
});
