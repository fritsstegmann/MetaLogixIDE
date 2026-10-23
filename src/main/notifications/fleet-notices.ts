/**
 * Controller side of Fleet notices: shows a trusted host's Claude
 * needs-input / finished notice as an OS notification under the
 * controller's own toggles, holds it back while the focused main window
 * shows that remote shell, and on click asks the renderer to open it.
 */
import type { FleetShellRef } from '@shared/fleet-contract';
import type { FleetNoticeEvent } from '@main/fleet/service';
import { toggleFor, type ClaudeNotifyToggle } from './claude-notifier';
import {
  OsNotifications,
  type NotificationConstructor,
  type NotificationHandle,
  type NotificationsPort,
} from './os-notifications';
import { raiseMain, type AppWindows } from './install';

/** Injected ports of the notice notifier. */
export interface FleetNoticeDeps {
  notifications: NotificationsPort;
  isViewing: (shell: FleetShellRef) => boolean;
  navigate: (shell: FleetShellRef) => void;
  settings: { get(key: ClaudeNotifyToggle): boolean };
}

const PEER_ID = /^[a-f0-9]{64}$/;
const VIEWING_ERROR =
  'invalid fleet:viewing: expected { shell: null } or { shell: { peerId: 64 hex, projectId >= 1, shellIndex >= 0 } }';

const refKey = (shell: FleetShellRef): string =>
  `${shell.peerId}:${shell.projectId}:${shell.shellIndex}`;
const sameRef = (a: FleetShellRef, b: FleetShellRef): boolean => refKey(a) === refKey(b);

/** Shows Fleet notices subject to the controller's toggles and view, one outstanding per remote shell. */
export class FleetNoticeNotifier {
  private readonly outstanding = new Map<string, NotificationHandle>();

  constructor(private readonly deps: FleetNoticeDeps) {}

  /** Shows one notice unless its toggle is off, notifications are unsupported or the shell is in view. */
  handle(event: FleetNoticeEvent): void {
    const target: FleetShellRef = {
      peerId: event.peerId,
      projectId: event.projectId,
      shellIndex: event.shellIndex,
    };
    if (
      !this.deps.settings.get(toggleFor(event.kind)) ||
      !this.deps.notifications.isSupported() ||
      this.deps.isViewing(target)
    )
      return;
    const key = refKey(target);
    this.outstanding.get(key)?.close();
    this.outstanding.set(
      key,
      this.deps.notifications.show({
        title: `${event.projectName ?? 'remote project'} on ${event.peerName} — shell ${event.shellIndex}`,
        body: event.body,
        onClick: () => this.deps.navigate(target),
      }),
    );
  }
}

const exactKeys = (value: object, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
};
const bounded = (value: unknown, min: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= 1_000_000;

/** Validates a `fleet:viewing` request: `{ shell: null }` or an exact `{ peerId, projectId, shellIndex }`. Throws otherwise. */
export function parseFleetViewing(req: unknown): FleetShellRef | null {
  if (typeof req !== 'object' || req === null || Array.isArray(req) || !exactKeys(req, ['shell']))
    throw new Error(VIEWING_ERROR);
  const { shell } = req as { shell: unknown };
  if (shell === null) return null;
  if (
    typeof shell !== 'object' ||
    Array.isArray(shell) ||
    !exactKeys(shell, ['peerId', 'projectId', 'shellIndex'])
  )
    throw new Error(VIEWING_ERROR);
  const { peerId, projectId, shellIndex } = shell as Record<string, unknown>;
  if (
    typeof peerId !== 'string' ||
    !PEER_ID.test(peerId) ||
    !bounded(projectId, 1) ||
    !bounded(shellIndex, 0)
  )
    throw new Error(VIEWING_ERROR);
  return { peerId, projectId, shellIndex };
}

/** Everything `installFleetNotices` wires together. */
export interface FleetNoticeInstallDeps {
  fleet: {
    onNotice(listener: (event: FleetNoticeEvent) => void): () => void;
    viewing(): FleetShellRef | null;
  };
  settings: { get(key: ClaudeNotifyToggle): boolean };
  notificationClass: NotificationConstructor;
  windows: Pick<AppWindows, 'main' | 'focused'>;
  broadcast(channel: 'fleet:focus-remote-shell', payload: FleetShellRef): void;
}

/** Subscribes a notice notifier to Fleet; viewing counts only while the main window is focused, mirroring local notices. */
export function installFleetNotices(deps: FleetNoticeInstallDeps): FleetNoticeNotifier {
  const notifier = new FleetNoticeNotifier({
    notifications: new OsNotifications(deps.notificationClass),
    isViewing: (shell) => {
      const viewing = deps.fleet.viewing();
      const main = deps.windows.main();
      return (
        viewing !== null &&
        main !== null &&
        !main.isDestroyed() &&
        deps.windows.focused() === main &&
        sameRef(viewing, shell)
      );
    },
    navigate: (shell) => {
      raiseMain(deps.windows);
      deps.broadcast('fleet:focus-remote-shell', { ...shell });
    },
    settings: deps.settings,
  });
  deps.fleet.onNotice((event) => notifier.handle(event));
  return notifier;
}
