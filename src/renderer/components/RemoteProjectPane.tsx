import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@renderer/api';
import { ShellTab } from './ShellTab';
import { StatusDot } from './StatusDot';
import { ShellTabsBar, type RemoteShellMenu, type ShellLaunched, type ShellMenuProfile, type ShellTabsBarItem } from './ShellTabsBar';
import { RemoteShellCommandsContext, type RemoteShellCommands } from './RemoteShellCommands';
import { toast } from '@renderer/hooks/useToasts';
import { visibleMainTab, type MainTab } from '@renderer/main-tab';
import { remoteWorkspace, type RemoteWorkspace } from '@renderer/p2p/remote-workspace';
import { PROJECT_SETTINGS_COPY, PROJECT_SETTINGS_TESTIDS } from '@renderer/project-settings-contract';
import { useRemoteProjectShells, type RemoteProjectShell } from '@renderer/p2p/useRemoteProjectShells';
import { ActivityTab } from './ActivityTab';
import { DiffTab } from './DiffTab';
import { FilesTab } from './FilesTab';
import { RemoteProjectSettings, type RemoteProjectSettingsProps } from './RemoteProjectSettings';
import { WorkspaceDestinations } from './WorkspaceDestinations';
import { useWorkspaceHeaderSlot } from './WorkspaceHeaderSlot';

interface Props {
  deviceId: string;
  deviceName: string;
  projectId: number;
  projectName: string;
  /** The tab to open on; a fleet notice names the shell it is about. */
  initialShellIndex?: number;
  /** Object identity distinguishes repeated requests for the same shell. */
  openRequest?: { readonly shellIndex?: number };
  onClose?: () => void;
}

type WorkspaceStatus = 'checking' | 'unavailable' | 'activity-disabled' | 'activity-enabled';

function useRemoteWorkspaceStatus(remote: RemoteWorkspace, projectId: number): WorkspaceStatus {
  const [status, setStatus] = useState<WorkspaceStatus>('checking');
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(): Promise<void> {
      let delay = 5000;
      try {
        const info = await remote.call('workspace.info', { projectId });
        if (!disposed) setStatus(info.activityEnabled ? 'activity-enabled' : 'activity-disabled');
      } catch {
        // Do not present a previously enabled workspace as authorized after the host stops confirming it.
        delay = 30_000;
        if (!disposed) setStatus('unavailable');
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), delay);
      }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [remote, projectId]);
  return status;
}

/** Keep tab state and pending reads scoped to a device/project pair, not just its numeric ID. */
export function RemoteProjectPane(props: Props): ReactElement {
  return <RemoteWorkspacePane key={`${props.deviceId}:${props.projectId}`} {...props} />;
}

function RemoteWorkspacePane({ deviceId, deviceName, projectId, projectName, initialShellIndex, openRequest, onClose }: Props): ReactElement {
  const [tab, setTab] = useState<MainTab>('shell');
  const [filesVisited, setFilesVisited] = useState(false);
  const [fileTarget, setFileTarget] = useState<string | null>(null);
  const consumeFileTarget = useCallback(() => setFileTarget(null), []);
  const remote = useMemo(() => remoteWorkspace(deviceId), [deviceId]);
  const status = useRemoteWorkspaceStatus(remote, projectId);
  const activityEnabled = status === 'activity-enabled';
  const visibleTab = visibleMainTab(tab, activityEnabled);
  const selectTab = (next: MainTab) => {
    if (next === 'files') setFilesVisited(true);
    setTab(next);
  };
  const requestedShellIndex = openRequest?.shellIndex ?? initialShellIndex;
  useEffect(() => {
    if (requestedShellIndex !== undefined) setTab('shell');
  }, [openRequest, requestedShellIndex]);
  useEffect(() => {
    if (visibleTab !== tab) setTab(visibleTab);
  }, [tab, visibleTab]);

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col" data-testid="remote-project-pane">
      <RemoteHeader>
        <WorkspaceDestinations active={visibleTab} activityEnabled={activityEnabled} onSelect={selectTab} />
        <div className="workspace-project-actions flex min-w-0 flex-wrap items-center justify-end gap-2 pr-2">
          <RemoteProjectIdentity projectName={projectName} deviceName={deviceName} onClose={onClose} />
        </div>
      </RemoteHeader>
      {status === 'unavailable' && <p role="status" className="px-3 pb-1 text-xs text-[--text-muted]">
        Workspace access unavailable. Check the host’s P2P permissions and app version.
      </p>}
      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        <RemoteProjectShells active={visibleTab === 'shell'} deviceId={deviceId} deviceName={deviceName} projectId={projectId}
          projectName={projectName} initialShellIndex={requestedShellIndex} openRequest={openRequest} />
        {filesVisited && <div className="h-full min-h-0" hidden={visibleTab !== 'files'}>
          <FilesTab projectId={projectId} remote={remote} active={visibleTab === 'files'}
            openRelPath={fileTarget} onOpenRelPathConsumed={consumeFileTarget} />
        </div>}
        {visibleTab === 'diff' && <DiffTab projectId={projectId} remote={remote} />}
        {visibleTab === 'settings' && <RemoteSettingsView projectId={projectId} projectName={projectName} remote={remote} />}
        {visibleTab === 'activity' && <ActivityTab projectId={projectId} remote={remote} followFiles={false}
          onFollowFilesChange={() => {}} onOpenTarget={(path) => { setFileTarget(path); selectTab('files'); }} />}
      </div>
    </div>
  );
}

function RemoteSettingsView(props: RemoteProjectSettingsProps): ReactElement {
  return <section aria-label={PROJECT_SETTINGS_COPY.title} data-testid={PROJECT_SETTINGS_TESTIDS.view}
    className="flex-1 min-h-0 min-w-0 overflow-auto text-[--text]">
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h2 className="text-lg font-semibold">{PROJECT_SETTINGS_COPY.title}</h2>
      <RemoteProjectSettings {...props} />
    </div>
  </section>;
}

/**
 * The pane's destinations and project actions: portalled into App's workspace header row (the same
 * row and grid the local workspace uses) when one is provided, otherwise rendered inline above the body.
 */
function RemoteHeader({ children }: { readonly children: ReactNode }): ReactElement {
  const slot = useWorkspaceHeaderSlot();
  if (slot) return createPortal(children, slot);
  return <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5 text-xs text-[--text]">{children}</div>;
}

function RemoteProjectIdentity({ projectName, deviceName, onClose }: Pick<Props, 'projectName' | 'deviceName' | 'onClose'>): ReactElement {
  return (
    <div className="ml-auto flex min-w-0 items-center gap-2">
      <span className="truncate font-semibold">{`${projectName} @ ${deviceName}`}</span>
      <span data-testid="p2p-badge" className="px-1.5 rounded text-[10px] leading-[16px] border border-[--border] text-[--text-muted]">P2P</span>
      {onClose && <button type="button" onClick={onClose} aria-label="Close remote project" data-testid="remote-pane-close"
        className="w-6 h-6 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong]">×</button>}
    </div>
  );
}

type ShellProps = Omit<Props, 'onClose'> & { readonly active: boolean };

function rpcIndex(result: unknown): number | null {
  return result && typeof result === 'object' && 'shellIndex' in result && typeof result.shellIndex === 'number' ? result.shellIndex : null;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error:\s*/, '');

/**
 * The tab state of one remote project, on top of the polled host list: tabs opened here show at
 * once (until the poll lists them), closed tabs vanish at once (until the poll drops them), and the
 * shown tab falls back to the picked, then the first-launched, then the first live tab.
 */
function useRemoteTabs(deviceId: string, projectId: number, active: boolean, initialShellIndex: number | undefined, openRequest: ShellProps['openRequest']) {
  const { shells: polled, refresh } = useRemoteProjectShells(deviceId, projectId, active);
  const [launched, setLaunched] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(initialShellIndex ?? null);
  const [opening, setOpening] = useState<readonly number[]>([]);
  const [closing, setClosing] = useState<ReadonlySet<number>>(new Set());
  // A later request for another tab of the same project (a second notice) selects it too.
  useEffect(() => {
    if (initialShellIndex !== undefined) setPicked(initialShellIndex);
  }, [initialShellIndex, openRequest]);

  // shells.launch is idempotent per project on the host (it reuses the live shell), so StrictMode's
  // double-mount just launches twice and the `cancelled` flag drops the stale result. Deliberately no
  // shells.kill on cancel: it would kill the very shell the second mount attaches to.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.invoke('p2p:rpc-call', { deviceId, method: 'shells.launch', params: { projectId } }).then(
      ({ result }) => { if (!cancelled) setLaunched(rpcIndex(result) ?? 0); },
      (e: unknown) => { if (!cancelled) setError(errorText(e)); },
    );
    return () => { cancelled = true; };
  }, [deviceId, projectId]);

  // Drop optimistic entries once the host's list agrees.
  const polledIds = useMemo(() => new Set(polled.map((s) => s.shellIndex)), [polled]);
  useEffect(() => {
    setOpening((prev) => (prev.some((i) => polledIds.has(i)) ? prev.filter((i) => !polledIds.has(i)) : prev));
    setClosing((prev) => ([...prev].some((i) => !polledIds.has(i)) ? new Set([...prev].filter((i) => polledIds.has(i))) : prev));
  }, [polledIds]);

  const shells = useMemo<RemoteProjectShell[]>(() => {
    const live = polled.filter((s) => !closing.has(s.shellIndex));
    const pending = opening.filter((i) => !polledIds.has(i) && !closing.has(i))
      .map((shellIndex): RemoteProjectShell => ({ shellIndex, launchName: 'Terminal', agent: null, agentState: null }));
    return [...live, ...pending].sort((a, b) => a.shellIndex - b.shellIndex);
  }, [polled, polledIds, opening, closing]);

  const has = (i: number | null): i is number => i !== null && shells.some((s) => s.shellIndex === i);
  // Before the first poll, trust the launch result so the terminal attaches without waiting.
  const shellIndex = has(picked) ? picked : has(launched) ? launched : shells[0]?.shellIndex ?? (polled.length === 0 && opening.length === 0 && closing.size === 0 ? launched : null);

  const call = useCallback((method: string, params: Record<string, unknown>) =>
    api.invoke('p2p:rpc-call', { deviceId, method, params: { projectId, ...params } }), [deviceId, projectId]);

  const open = useCallback(async (method: 'shells.launchProfile' | 'shells.launchPlain', params: Record<string, unknown>, onLaunched?: ShellLaunched) => {
    try {
      const index = rpcIndex((await call(method, params)).result);
      if (index === null) throw new Error('no shell index');
      setError(null);
      setOpening((prev) => (prev.includes(index) ? prev : [...prev, index]));
      setPicked(index);
      onLaunched?.(index);
      refresh();
    } catch (e) {
      toast('Could not open a terminal on the remote machine', { kind: 'error', detail: errorText(e) });
    }
  }, [call, refresh]);

  const close = useCallback((index: number) => {
    setClosing((prev) => new Set(prev).add(index));
    setLaunched((prev) => (prev === index ? null : prev));
    setPicked((prev) => (prev === index ? null : prev));
    call('shells.kill', { shellIndex: index }).then(refresh, (e: unknown) => {
      setClosing((prev) => { const next = new Set(prev); next.delete(index); return next; });
      toast('Could not close the remote terminal', { kind: 'error', detail: errorText(e) });
    });
  }, [call, refresh]);

  return { shells, shellIndex, error, setPicked, open, close, call };
}

/** The host's saved profiles for the add-tab menu, and the project's default, both read and written on the host. */
function useRemoteShellMenu(call: ReturnType<typeof useRemoteTabs>['call']) {
  const [defaultName, setDefaultName] = useState<string | null>(null);
  const menu = useMemo<RemoteShellMenu>(() => ({
    profiles: async () => {
      const { result } = await call('shells.cliProfiles', {});
      const r = result as { profiles?: ShellMenuProfile[]; defaultName?: string | null } | undefined;
      setDefaultName(r?.defaultName ?? null);
      return Array.isArray(r?.profiles) ? r.profiles : [];
    },
    remove: async (name) => { await call('shells.removeCliProfile', { name }); },
    setDefault: async (name) => {
      const { result } = await call('shells.setDefaultCli', { name });
      setDefaultName((result as { defaultName?: string | null } | undefined)?.defaultName ?? null);
    },
  }), [call]);
  return { menu, defaultName };
}

function RemoteProjectShells({ active, deviceId, deviceName, projectId, projectName, initialShellIndex, openRequest }: ShellProps): ReactElement | null {
  const tabs = useRemoteTabs(deviceId, projectId, active, initialShellIndex, openRequest);
  const { shells, shellIndex, error, setPicked, open, close } = tabs;
  const { menu, defaultName } = useRemoteShellMenu(tabs.call);
  const slot = useWorkspaceHeaderSlot();
  const commands = useContext(RemoteShellCommandsContext);

  // Tell main which remote shell is on screen, so a fleet notice for it is held back while it is in view.
  useEffect(() => {
    if (!active || shellIndex === null || error) return;
    api.invoke('p2p:viewing', { shell: { deviceId, projectId, shellIndex } }).catch(() => { /* worst case: one extra notice */ });
    return () => { api.invoke('p2p:viewing', { shell: null }).catch(() => {}); };
  }, [active, deviceId, projectId, shellIndex, error]);

  // ⌘T / ⌘W from App act on this host while the Shell tab shows.
  const latest = useRef({ open, close, shellIndex });
  latest.current = { open, close, shellIndex };
  useEffect(() => {
    if (!commands || !active) return;
    const own: RemoteShellCommands = {
      newTab: () => { void latest.current.open('shells.launchPlain', {}); },
      closeActive: () => { const i = latest.current.shellIndex; if (i !== null) latest.current.close(i); },
    };
    commands.current = own;
    return () => { if (commands.current === own) commands.current = null; };
  }, [commands, active]);

  if (!active) return null;
  const items = shells.map((s): ShellTabsBarItem => ({
    projectId, shellIndex: s.shellIndex, pinned: false, startedAt: null, lastActiveAt: null,
    launchName: s.launchName, agent: s.agent, state: s.agentState ?? undefined,
  }));
  const bar = (
    <ShellTabsBar
      projectId={projectId}
      shells={items}
      active={shellIndex ?? -1}
      onSelect={setPicked}
      onClose={close}
      defaultCliName={defaultName}
      remoteMenu={menu}
      renderDot={(s, isActive) => s.state ? <StatusDot agent={s.agent ?? null} state={s.state} inactiveWhenIdle={!isActive} /> : null}
      onLaunchProfile={(name, onLaunched) => void open('shells.launchProfile', { profileName: name }, onLaunched)}
      onLaunchPlainTab={(onLaunched) => void open('shells.launchPlain', {}, onLaunched)}
      onLaunchCustom={() => { /* hidden for remote hosts: they run only their saved profiles */ }}
    />
  );
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[--surface-sheet]" data-sheet-content="shell">
      {slot ? createPortal(bar, slot) : <div className="shrink-0 py-1" aria-label={`Shells of ${projectName} on ${deviceName}`} data-testid="remote-shell-tabs">{bar}</div>}
      <div className="flex-1 min-h-0 relative">
        {error && shells.length === 0 && <div className="p-4 text-[12px] text-[--danger]">Could not open remote shell: {error}</div>}
        {!error && shellIndex === null && shells.length === 0 && (
          <div className="p-4 text-[12px] text-[--text-muted]" data-testid="remote-no-shells">No terminals open on {deviceName}. Use + to open one.</div>
        )}
        {shellIndex !== null && (
          <ShellTab
            key={`${deviceId}:${projectId}:${shellIndex}`}
            projectId={projectId}
            shellIndex={shellIndex}
            primary
            source={{ kind: 'remote', deviceId, deviceName }}
          />
        )}
      </div>
    </div>
  );
}
