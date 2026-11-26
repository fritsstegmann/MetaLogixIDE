/**
 * One shared copy of the paired machines' state for the main window: the machine switcher (fleet
 * list, `shells.alive` poll, selected dot) and the project names of their live shells. The Sidebar
 * and the command palette both read it, so opening the palette starts no polls of its own, and the
 * palette still sees remote sessions while the Sidebar is swapped out for Chat, Git or Tasks.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { FleetProjectNames } from '../fleet-in-use';
import { useFleetInUse } from './useFleetInUse';
import { useMachineSwitcher, type MachineSwitcher } from './useMachineSwitcher';

export interface FleetState {
  readonly switcher: MachineSwitcher;
  /** Device id, then project id to name, for the paired machines' live projects. */
  readonly names: FleetProjectNames;
}

const FleetStateContext = createContext<FleetState | null>(null);

export function FleetStateProvider({ children }: { readonly children: ReactNode }) {
  const switcher = useMachineSwitcher();
  const names = useFleetInUse(switcher.shells);
  const value = useMemo(() => ({ switcher, names }), [switcher, names]);
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
