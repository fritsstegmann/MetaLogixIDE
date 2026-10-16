import { describe, expect, it } from 'vitest';
import { classifyClaudeScreen } from '@main/agent-status/claude-screen';

describe('Claude live-screen authority', () => {
  it('recognizes only a current known approval or question at the bottom', () => {
    expect(classifyClaudeScreen(['╭─ Claude Code', 'Allow Bash to run this command?', '❯ 1. Yes', '  2. No'])).toBe('blocked');
    expect(classifyClaudeScreen(['Claude', 'What would you like to do?', '❯ 1. Continue', '  2. Stop'])).toBe('blocked');
    expect(classifyClaudeScreen(['Allow Bash to run this command?', '❯ 1. Yes', '❯ Ready for another task'])).toBe('idle');
    expect(classifyClaudeScreen(['Allow Bash to run this command?', '❯ 1. Yes', 'unrelated shell prompt $'])).toBe('idle');
  });

  it('treats ready and ambiguous content as idle, known working UI as busy', () => {
    expect(classifyClaudeScreen(['❯ '])).toBe('idle');
    expect(classifyClaudeScreen(['✳ Thinking…', 'esc to interrupt'])).toBe('busy');
    expect(classifyClaudeScreen(['some log', 'spinner', 'what should I do?'])).toBe('idle');
    expect(classifyClaudeScreen([])).toBe('idle');
  });
});
