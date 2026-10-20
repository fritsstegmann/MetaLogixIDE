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
  readonly controls: readonly FleetControl[];
  /** A listener failure is distinct from an empty LAN; no sensitive details leave main. */
  readonly error?: string;
}

/** A public root identity and display name, never its filesystem location. */
export interface FleetRoot {
  readonly id: number;
  readonly name: string;
}

/** A project belongs to precisely one root in the remote hierarchy. */
export interface FleetProject {
  readonly id: number;
  readonly rootId: number;
  readonly name: string;
}

/** Identifies the trusted peer currently controlling one local shell. */
export interface FleetControl {
  readonly projectId: number;
  readonly shellIndex: number;
  readonly peerName: string;
}
export interface FleetShell {
  readonly projectId: number;
  readonly shellIndex: number;
  readonly agent: AgentKind | null;
  readonly state: AgentState;
}

export interface FleetStatus {
  readonly roots: readonly FleetRoot[];
  readonly projects: readonly FleetProject[];
  readonly shells: readonly FleetShell[];
}

/** Ordered chunks of one remote terminal attachment; snapshot precedes ready and live data. */
export interface FleetTerminalEvent {
  readonly peerId: string;
  readonly subscriptionId: string;
  readonly projectId: number;
  readonly shellIndex: number;
  readonly kind: 'snapshot' | 'ready' | 'data' | 'exit';
  readonly data: string;
}
