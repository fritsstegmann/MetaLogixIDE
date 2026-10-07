import { StatusDot } from './StatusDot';
import { useShellClaudeState } from '../hooks/useClaudeStates';

/** One tab strip dot. Its own component so the per-shell state hook has a stable call site across a `.map()` whose length varies (D1: grey static when idle and inactive). */
export function ShellTabDot({ projectId, shellIndex, isActive }: { projectId: number; shellIndex: number; isActive: boolean }) {
  const state = useShellClaudeState(projectId, shellIndex);
  return <StatusDot state={state} inactiveWhenIdle={!isActive} />;
}
