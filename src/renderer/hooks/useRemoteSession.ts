/**
 * Renderer hooks for a remote Fleet session: the hosting peer's git summary for the status bar, the
 * `fleet:viewing` report that lets main hold back notices for the shell on screen, and the handler that
 * turns a clicked notice (`fleet:focus-remote-shell`) into a remote project selection.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetGitStatus, FleetShellRef, FleetState } from '@shared/fleet-contract';
import type { RemoteProjectSelection } from '@renderer/components/Sidebar';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { createRequestGate } from '@renderer/diff/diff-load-state';

export const EMPTY_FLEET_GIT: FleetGitStatus = {
  isRepo: false,
  branch: null,
  dirty: false,
  ahead: 0,
  behind: 0,
  changedCount: 0,
};

const FOCUS_FAILED = 'Could not open the remote shell';

const isHidden = () => document.visibilityState === 'hidden';

/**
 * Polls `fleet:git-status` for `target` every `intervalMs` (4 s, like the local hook) while the window
 * is visible. Only the latest request's answer applies; a rejection yields `EMPTY_FLEET_GIT`, which hides
 * the git chip. A null target makes no request.
 */
export function useFleetGitStatus(
  target: { peerId: string; projectId: number } | null,
  intervalMs = 4000,
): FleetGitStatus {
  const [status, setStatus] = useState<FleetGitStatus>(EMPTY_FLEET_GIT);
  const gateRef = useRef(createRequestGate());
  const peerId = target?.peerId ?? null;
  const projectId = target?.projectId ?? null;

  const load = useCallback(
    async (fromPoll: boolean) => {
      const gate = gateRef.current;
      if (peerId === null || projectId === null) {
        gate.invalidate();
        setStatus(EMPTY_FLEET_GIT);
        return;
      }
      if (fromPoll && (gate.inFlight || isHidden())) return;
      const seq = gate.begin();
      try {
        const next = await api.invoke('fleet:git-status', { peerId, projectId });
        if (gate.isLatest(seq)) setStatus(next);
      } catch {
        if (gate.isLatest(seq)) setStatus(EMPTY_FLEET_GIT);
      } finally {
        gate.settle(seq);
      }
    },
    [peerId, projectId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);
  useEffect(() => {
    if (peerId === null) return;
    const id = window.setInterval(() => {
      void load(true);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [peerId, intervalMs, load]);

  return status;
}

function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(!isHidden());
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

const shellKey = (shell: FleetShellRef | null) =>
  shell ? JSON.stringify([shell.peerId, shell.projectId, shell.shellIndex]) : '';

/**
 * Tells main which remote shell this window shows (`fleet:viewing`), or null while none is shown or the
 * window is hidden. Sends on mount, so a reloaded or recreated window clears any shell main still holds,
 * then only when that value changes.
 */
export function useFleetViewing(shell: FleetShellRef | null): void {
  const visible = useWindowVisible();
  const shown = visible ? shell : null;
  const key = shellKey(shown);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const sentRef = useRef<string | null>(null);
  useEffect(() => {
    if (key === sentRef.current) return;
    sentRef.current = key;
    const current = shownRef.current;
    void api
      .invoke('fleet:viewing', {
        shell: current
          ? { peerId: current.peerId, projectId: current.projectId, shellIndex: current.shellIndex }
          : null,
      })
      .catch(() => {
        if (sentRef.current === key) sentRef.current = null;
      });
  }, [key]);
}

const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseShellRef(payload: unknown): FleetShellRef | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { peerId, projectId, shellIndex } = payload as Record<string, unknown>;
  if (typeof peerId !== 'string' || peerId === '' || !isIndex(projectId) || !isIndex(shellIndex))
    return null;
  return { peerId, projectId, shellIndex };
}

/**
 * Handles `fleet:focus-remote-shell`: drops a malformed payload, resolves the peer (must be linked in
 * `fleetState`) and the project name (from the peer's `fleet:status`), then calls `onFocus` with the
 * selection and shell index. An unknown peer or project, or a failed lookup, shows an error toast. Only the
 * newest of overlapping requests applies.
 */
export function useRemoteShellFocus(
  fleetState: FleetState | null,
  onFocus: (target: RemoteProjectSelection, shellIndex: number) => void,
): void {
  const stateRef = useRef(fleetState);
  stateRef.current = fleetState;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  useEffect(() => {
    let latest = 0;
    const off = api.on('fleet:focus-remote-shell', (payload: unknown) => {
      const ref = parseShellRef(payload);
      if (!ref) return;
      const request = ++latest;
      const peer = stateRef.current?.peers.find(
        (p) => p.id === ref.peerId && p.status === 'linked',
      );
      if (!peer) {
        toast(FOCUS_FAILED, {
          kind: 'error',
          detail: 'That machine is offline or no longer linked.',
        });
        return;
      }
      void api.invoke('fleet:status', { peerId: peer.id }).then(
        (status) => {
          if (request !== latest) return;
          const project = status.projects.find((p) => p.id === ref.projectId);
          if (!project) {
            toast(FOCUS_FAILED, {
              kind: 'error',
              detail: `${peer.name} no longer shares that project.`,
            });
            return;
          }
          onFocusRef.current(
            {
              peerId: peer.id,
              peerName: peer.name,
              projectId: project.id,
              projectName: project.name,
            },
            ref.shellIndex,
          );
        },
        () => {
          if (request === latest)
            toast(FOCUS_FAILED, {
              kind: 'error',
              detail: `Could not reach ${peer.name}. Check the connection and retry.`,
            });
        },
      );
    });
    return () => {
      latest++;
      off();
    };
  }, []);
}
