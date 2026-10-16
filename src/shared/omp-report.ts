/** Wire events emitted by the app-owned OMP extension, never by a renderer. */
export const OMP_REPORT_VERSION = 1 as const;

export type OmpReportEvent =
  | 'session_start'
  | 'session_switch'
  | 'agent_start'
  | 'agent_end'
  | 'approval_requested'
  | 'approval_resolved'
  | 'ask_start'
  | 'ask_end';

/** Session and monotonic sequence are scoped to one authenticated PTY spawn. */
export interface OmpReport {
  readonly version: typeof OMP_REPORT_VERSION;
  readonly session: string;
  readonly seq: number;
  readonly event: OmpReportEvent;
  readonly active?: boolean;
  readonly willContinue?: boolean;
}
