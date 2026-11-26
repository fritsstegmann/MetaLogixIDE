/**
 * One shared copy of the main window's In use state: the machine switcher (fleet list,
 * `shells.alive` poll, selected dot), the project names of the paired machines' live shells, and the
 * single ordered In use list that Ctrl+1–9 number. The Sidebar, the command palette and App's global
 * key all read it, so they agree on the order, opening the palette starts no polls of its own, and
 * remote sessions stay reachable while the Sidebar is swapped out for Chat, Git or Tasks.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { remoteInUseRows, type FleetProjectNames, type RemoteInUseRow } from '../fleet-in-use';
import { useAliveShellIds } from '../hooks/useAliveShellIds';
import { useProjects } from '../hooks/useProjects';
import { advanceInUseSequence, orderedLocalInUse, type InUseSequence, type InUseTarget } from '../in-use-jump';
import { useFleetInUse } from './useFleetInUse';
import { useMachineSwitcher, type MachineSwitcher } from './useMachineSwitcher';

export interface FleetState {
  readonly switcher: MachineSwitcher;
  /** Device id, then project id to name, for the paired machines' live projects. */
  readonly names: FleetProjectNames;
  /** This machine's live project ids in In use order: first seen alive first, stable while they stay alive. */
  readonly localInUse: readonly number[];
  /** The paired machines' live projects, unfiltered, in dot order then by name. */
  readonly remoteInUse: readonly RemoteInUseRow[];
  /** `localInUse` then `remoteInUse`: the list Ctrl+1–9 number. */
  readonly inUseTargets: readonly InUseTarget[];
}

const FleetStateContext = createContext<FleetState | null>(null);
const EMPTY_SEQUENCE: InUseSequence = { seq: new Map(), next: 1 };

/** This machine's In use order, advanced in render whenever the live set changes. */
function useLocalInUse(): readonly number[] {
  const { aliveIds } = useAliveShellIds();
  const { projects } = useProjects();
  const [sequence, setSequence] = useState(EMPTY_SEQUENCE);
  const next = advanceInUseSequence(sequence, aliveIds);
  if (next !== sequence) setSequence(next);
  const known = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  return useMemo(() => orderedLocalInUse(next, known), [next, known]);
}

export function FleetStateProvider({ children }: { readonly children: ReactNode }) {
  const switcher = useMachineSwitcher();
  const names = useFleetInUse(switcher.shells);
  const localInUse = useLocalInUse();
  const remoteInUse = useMemo(
    () => remoteInUseRows(switcher.machines, switcher.shells, names, ''),
    [switcher.machines, switcher.shells, names],
  );
  const inUseTargets = useMemo<InUseTarget[]>(() => [
    ...localInUse.map((projectId): InUseTarget => ({ kind: 'local', projectId })),
    ...remoteInUse.map((row): InUseTarget => ({ kind: 'remote', row })),
  ], [localInUse, remoteInUse]);
  const value = useMemo(
    () => ({ switcher, names, localInUse, remoteInUse, inUseTargets }),
    [switcher, names, localInUse, remoteInUse, inUseTargets],
  );
  return <FleetStateContext.Provider value={value}>{children}</FleetStateContext.Provider>;
}

/** The shared fleet state; throws outside `FleetStateProvider`. */
export function useFleetState(): FleetState {
  const state = useContext(FleetStateContext);
  if (!state) throw new Error('useFleetState must be used inside FleetStateProvider');
  return state;
}

/** The shared fleet state, or `null` outside `FleetStateProvider` (a surface that works without paired machines). */
export function useFleetStateOrNull(): FleetState | null {
  return useContext(FleetStateContext);
}
