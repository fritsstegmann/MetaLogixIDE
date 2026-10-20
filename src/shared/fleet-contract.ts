/** Public fleet state contains no private key, credential, project path or terminal content. */
import type { AgentKind, AgentState } from './agent-state';

export interface FleetPeer {
  readonly id: string;
  readonly name: string;
  readonly status: 'discovered' | 'pending' | 'linked' | 'offline';
  /** Compare on both devices before approval; only present during pairing. */
  readonly verificationCode?: string;
}

export interface FleetState {
  readonly enabled: boolean;
  readonly peers: readonly FleetPeer[];
  /** A listener failure is distinct from an empty LAN; no sensitive details leave main. */
  readonly error?: string;
}

export interface FleetProject {
  readonly id: number;
  readonly name: string;
}

export interface FleetShell {
  readonly projectId: number;
  readonly shellIndex: number;
  readonly agent: AgentKind | null;
  readonly state: AgentState;
}

export interface FleetStatus {
  readonly projects: readonly FleetProject[];
  readonly shells: readonly FleetShell[];
}
