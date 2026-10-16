/** Classifies only the current bounded bottom rows of a recognized Claude terminal. */
import type { AgentState } from '@shared/agent-state';

const READY = /^(?:[❯>]\s*(?:$|Ready for another task)|[╭╰]─.*Claude Code)/i;
const APPROVAL = /(?:Allow\s+.+\?|Do you want to\s+.+\?|What would you like to do\?)/i;
const ANSWER = /(?:Esc to cancel|^(?:❯|>)?\s*[12]\.\s*(?:Yes|No|Allow|Continue|Stop))$/i;
const WORKING = /(?:[✻✳⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*(?:Thinking|Working|Running|Compacting)|esc to interrupt)/i;

/** Returns idle on unknown content; old prompts above the latest ready line cannot block. */
export function classifyClaudeScreen(rows: readonly string[]): AgentState {
  const visible = rows.map((row) => row.trim()).filter(Boolean);
  if (visible.length === 0) return 'idle';
  const lastReady = visible.findLastIndex((row) => READY.test(row) && !row.includes('Claude Code'));
  const live = visible.slice(lastReady + 1);
  if (lastReady >= 0 && live.length === 0) return 'idle';
  const bottom = live.slice(-6);
  if (bottom.some((row) => APPROVAL.test(row)) && ANSWER.test(bottom.at(-1) ?? '')) return 'blocked';
  return bottom.some((row) => WORKING.test(row)) ? 'busy' : 'idle';
}
