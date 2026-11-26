// @vitest-environment jsdom
/** RemoteProjectPane: the main-area pane for a project on a paired machine (moved unchanged from Sidebar.machines.test.tsx). */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@renderer/api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} } }));
vi.mock('../ShellTab', () => ({ ShellTab: (p: { source: unknown; shellIndex: number }) => <div data-testid="shell-tab" data-shell={p.shellIndex}>{JSON.stringify(p.source)}</div> }));
vi.mock('../FilesTab', () => ({ FilesTab: ({ openRelPath }: { openRelPath?: string }) => <div data-testid="files-panel">
  {openRelPath}<textarea aria-label="Remote draft" />
</div> }));
vi.mock('../ActivityTab', () => ({ ActivityTab: ({ onOpenTarget }: { onOpenTarget?: (path: string) => void }) =>
  <button type="button" onClick={() => onOpenTarget?.('remote.txt')}>Open remote activity file</button> }));

import { RemoteProjectPane } from '../RemoteProjectPane';
import { WorkspaceDestinations } from '../WorkspaceDestinations';
import { WorkspaceHeaderSlotContext } from '../WorkspaceHeaderSlot';
import { SHELL_TAB_TEST_ID } from '@shared/agent-state';
import { RemoteShellCommandsContext, type RemoteShellCommands } from '../RemoteShellCommands';

/** The shell tab chips (the same ShellTabsBar chips local projects use). */
const chips = (): HTMLElement[] => screen.queryAllByTestId(SHELL_TAB_TEST_ID);
const findChips = (): Promise<HTMLElement[]> => screen.findAllByTestId(SHELL_TAB_TEST_ID);
const findChip = async (name: string | RegExp): Promise<HTMLElement> => waitFor(() => {
  const found = chips().find((c) => (typeof name === 'string' ? c.textContent === name : name.test(c.textContent ?? '')));
  if (!found) throw new Error(`no chip ${String(name)}`);
  return found;
});
const isActive = (c: HTMLElement): boolean => c.className.includes('bg-[--surface-active]');

let alive: unknown[] = [];

beforeEach(() => {
  cleanup();
  // The shell tab strip (ShellTabsBar) reads prefers-reduced-motion; jsdom has no matchMedia.
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
  // ChipStrip fades chips in and out with the Web Animations API, which jsdom lacks.
  Element.prototype.animate = function animate() {
    return { finished: Promise.resolve(), cancel() {}, finish() {}, onfinish: null, addEventListener() {} } as unknown as Animation;
  };
  alive = [];
  invoke.mockReset();
  invoke.mockImplementation(async (_ch: string, a: { method?: string }) => {
    if (a?.method === 'shells.launch') return { result: { shellIndex: 2 } };
    if (a?.method === 'shells.alive') return { result: alive };
    if (a?.method === 'workspace.info') throw new Error('unknown_method');
    return {};
  });
});

describe('RemoteProjectPane', () => {
  test('fills a provided workspace header row with its destinations, centred shell strip and identity, like the local header', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
    const header = document.createElement('header');
    header.className = 'workspace-header-row';
    document.body.appendChild(header);
    try {
      render(<WorkspaceHeaderSlotContext.Provider value={header}>
        <RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />
      </WorkspaceHeaderSlotContext.Provider>);
      await screen.findByTestId('shell-tab');
      const pane = screen.getByTestId('remote-project-pane');
      const strip = await waitFor(() => { const el = header.querySelector<HTMLElement>('.shell-tabs-bar'); if (!el) throw new Error('no strip'); return el; });
      // Positive control: everything still renders, just in the header row rather than inside the pane.
      expect(within(header.querySelector<HTMLElement>('.workspace-destinations')!).getByRole('button', { name: 'Shell' }).getAttribute('aria-current')).toBe('page');
      expect(header.querySelector('.workspace-project-actions')?.textContent).toContain('alpha @ Tower');
      expect(strip.parentElement).toBe(header);
      await waitFor(() => expect(strip.querySelectorAll(`[data-testid="${SHELL_TAB_TEST_ID}"]`)).toHaveLength(2));
      expect(pane.contains(strip)).toBe(false);
      expect(pane.querySelector('.workspace-destinations')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
      expect(header.querySelector('.shell-tabs-bar')).toBeNull();
      expect(await screen.findByTestId('files-panel')).toBeTruthy();
    } finally {
      cleanup();
      header.remove();
    }
  });

  test('renders its header inline when no header row is provided', async () => {
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    await screen.findByTestId('shell-tab');
    const pane = screen.getByTestId('remote-project-pane');
    expect(pane.querySelector('.workspace-destinations')).not.toBeNull();
    expect(pane.textContent).toContain('alpha @ Tower');
  });

  test('offers workspace destinations independently of shell session tabs', async () => {
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    await screen.findByTestId('shell-tab');
    expect(screen.getByRole('button', { name: 'Shell' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Diff' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    expect(await screen.findByText(/Workspace access unavailable/)).toBeTruthy();
  });

  test('the shared destinations keep local diff and unsaved markers', () => {
    const onSelect = vi.fn();
    render(<WorkspaceDestinations active="settings" activityEnabled={false} diffCount={2} envDirty onSelect={onSelect} />);
    const diff = screen.getByRole('button', { name: 'Diff, 2 changed files' });
    expect(screen.getByTestId('main-tab-diff-count').textContent).toBe('2');
    expect(screen.getByTestId('project-settings-tab').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('project-settings-tab').getAttribute('aria-label')).toMatch(/unsaved/i);
    fireEvent.click(diff);
    expect(onSelect).toHaveBeenCalledWith('diff');
  });

  test('reports a remote Diff failure and retries against that same host', async () => {
    invoke.mockImplementation(async (_ch: string, input: { deviceId?: string; method?: string }) => {
      if (input?.method === 'workspace.info') return { result: { activityEnabled: false } };
      if (input?.method === 'workspace.diffStatus') throw new Error('temporarily unavailable');
      if (input?.method === 'shells.launch') return { result: { shellIndex: 2 } };
      return { result: [] };
    });
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read git status');
    invoke.mockResolvedValueOnce({
      result: { isRepo: false, branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Not a git repository.')).toBeTruthy();
    expect(invoke.mock.calls.filter(([, input]) => input?.method === 'workspace.diffStatus')).toEqual([
      ['p2p:rpc-call', { deviceId: 'tower', method: 'workspace.diffStatus', params: { projectId: 7 } }],
      ['p2p:rpc-call', { deviceId: 'tower', method: 'workspace.diffStatus', params: { projectId: 7 } }],
    ]);
    expect(invoke).not.toHaveBeenCalledWith('git:panel-status', expect.anything());
  });

  test('returning from Files restores the picked remote session and does not relaunch it', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    fireEvent.click(await findChip('Opencode'));
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByTestId('files-panel')).toBeTruthy();
    expect(screen.queryByTestId('shell-tab')).toBeNull();
    expect(screen.getByRole('button', { name: 'Files' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }));
    expect((await screen.findByTestId('shell-tab')).getAttribute('data-shell')).toBe('3');
    expect(invoke.mock.calls.filter(([, input]) => input?.method === 'shells.launch')).toHaveLength(1);
  });

  test('uses the selected host Activity capability and routes its file link within that workspace', async () => {
    invoke.mockImplementation(async (_ch: string, input: { deviceId?: string; method?: string }) => {
      if (input?.method === 'workspace.info') return { result: { activityEnabled: input.deviceId === 'tower' } };
      if (input?.method === 'shells.launch') return { result: { shellIndex: 2 } };
      return { result: [] };
    });
    const { rerender } = render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open remote activity file' }));
    expect(screen.getByTestId('files-panel').textContent).toBe('remote.txt');

    rerender(<RemoteProjectPane deviceId="laptop" deviceName="Laptop" projectId={7} projectName="alpha" />);
    expect((await screen.findByTestId('shell-tab')).textContent).toContain('"deviceId":"laptop"');
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    expect(screen.queryByTestId('files-panel')).toBeNull();
  });

  test('a repeated notice for the same shell returns from Files to Shell', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
    const project = { deviceId: 'tower', deviceName: 'Tower', projectId: 7, projectName: 'alpha' };
    const { rerender } = render(<RemoteProjectPane {...project} openRequest={{ shellIndex: 3 }} />);
    await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3'));
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByTestId('files-panel')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Remote draft' }), { target: { value: 'unsaved' } });
    rerender(<RemoteProjectPane {...project} openRequest={{ shellIndex: 3 }} />);
    expect((await screen.findByTestId('shell-tab')).getAttribute('data-shell')).toBe('3');
    expect(screen.queryByRole('textbox', { name: 'Remote draft' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Remote draft' }).value).toBe('unsaved');
  });

  test('ignores a prior machine reporting Activity after a same-ID project switch', async () => {
    let finishTower: (value: { result: { activityEnabled: boolean } }) => void = () => {};
    const towerInfo = new Promise<{ result: { activityEnabled: boolean } }>((resolve) => { finishTower = resolve; });
    invoke.mockImplementation(async (_ch: string, input: { deviceId?: string; method?: string }) => {
      if (input?.method === 'workspace.info') {
        return input.deviceId === 'tower' ? towerInfo : { result: { activityEnabled: false } };
      }
      if (input?.method === 'shells.launch') return { result: { shellIndex: 2 } };
      return { result: [] };
    });
    const { rerender } = render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    expect(invoke).toHaveBeenCalledWith('p2p:rpc-call', { deviceId: 'tower', method: 'workspace.info', params: { projectId: 7 } });
    rerender(<RemoteProjectPane deviceId="laptop" deviceName="Laptop" projectId={7} projectName="alpha" />);
    expect((await screen.findByTestId('shell-tab')).textContent).toContain('"deviceId":"laptop"');
    await act(async () => { finishTower({ result: { activityEnabled: true } }); });
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
  });

  test('a lost workspace grant removes Activity but keeps the selected Shell usable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let granted = true;
    try {
      invoke.mockImplementation(async (_ch: string, input: { method?: string }) => {
        if (input?.method === 'workspace.info') {
          if (!granted) throw new Error('workspace access requires a grant from the host');
          return { result: { activityEnabled: true } };
        }
        if (input?.method === 'shells.launch') return { result: { shellIndex: 2 } };
        return { result: [] };
      });
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      expect(await screen.findByRole('button', { name: 'Activity' })).toBeTruthy();
      granted = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByText(/Workspace access unavailable/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });

  test('header shows Project @ Machine with a P2P badge and a remote ShellTab', async () => {
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    expect(screen.getByText('alpha @ Tower')).toBeTruthy();
    expect(screen.getByText('P2P')).toBeTruthy();
    const tab = await screen.findByTestId('shell-tab');
    await waitFor(() => expect(tab.textContent).toContain('"deviceId":"tower"'));
  });

  test('shows one tab per shell the project runs on that machine, and switches the terminal to the one picked', async () => {
    alive = [
      { projectId: 7, shellIndex: 3, launchArgv: ['opencode'], agentState: 'busy', agent: 'opencode' },
      { projectId: 7, shellIndex: 2, launchArgv: ['/usr/local/bin/claude', '--continue'], agentState: 'idle', agent: 'claude' },
      { projectId: 7, shellIndex: 4, launchArgv: ['$SHELL'], agentState: null, agent: null },
      { projectId: 9, shellIndex: 0, launchArgv: ['codex'] }, // another project: not a tab here
    ];
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    await waitFor(() => expect(chips()).toHaveLength(3));
    const tabs = chips();
    expect(tabs.map((t) => t.textContent)).toEqual(['Claude', 'Opencode', 'Terminal']);
    // The launched shell is selected first.
    expect(tabs.map(isActive)).toEqual([true, false, false]);
    expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('2');

    fireEvent.click(await findChip(/Opencode/));
    expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3');
    expect(isActive(await findChip(/Opencode/))).toBe(true);
  });

  test('a terminal where an agent was started by hand is labelled as that agent; repeats are numbered', async () => {
    alive = [
      { projectId: 7, shellIndex: 2, launchArgv: ['claude'], agent: 'claude', agentState: 'idle' },
      { projectId: 7, shellIndex: 3, launchArgv: ['$SHELL'], agent: 'opencode', agentState: 'busy' },
      { projectId: 7, shellIndex: 5, launchArgv: ['claude'], agent: null },
    ];
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    await waitFor(() => expect(chips()).toHaveLength(3));
    expect(chips().map((t) => t.textContent)).toEqual(['Claude 1', 'opencode', 'Claude 2']);
  });

  test('falls back to the launched shell when the picked one is gone; no chips (only +) before the host lists shells', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      await screen.findByTestId('shell-tab');
      expect(chips()).toHaveLength(0);
      expect(screen.getByTestId('tabbar-new-shell')).toBeTruthy();

      alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
      await vi.advanceTimersByTimeAsync(3000);
      fireEvent.click(await findChip('Opencode'));
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3');

      alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }];
      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(chips()).toHaveLength(1));
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });

  test('tells main which remote shell is on screen, follows tab switches, and clears it on unmount', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
    const viewing = () => invoke.mock.calls.filter((c) => c[0] === 'p2p:viewing').map((c) => (c[1] as { shell: unknown }).shell);
    const { unmount } = render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    await screen.findByTestId('shell-tab');
    expect(viewing().at(-1)).toEqual({ deviceId: 'tower', projectId: 7, shellIndex: 2 });
    fireEvent.click(await findChip('Opencode'));
    await waitFor(() => expect(viewing().at(-1)).toEqual({ deviceId: 'tower', projectId: 7, shellIndex: 3 }));
    unmount();
    expect(viewing().at(-1)).toBeNull();
  });

  test('opens on the tab a fleet notice names, and on another when a later notice names that', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }, { projectId: 7, shellIndex: 4, launchArgv: ['$SHELL'] }];
    const { rerender } = render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" initialShellIndex={3} />);
    await findChips();
    await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3'));
    rerender(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" initialShellIndex={4} />);
    await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('4'));
  });

  describe('terminal tab controls on the host', () => {
    /** Host fixture: alive shells, saved profiles, and every tab RPC recorded. */
    function host(opts: { profilesFail?: boolean } = {}) {
      alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
      let next = 6;
      let defaultName: string | null = 'claude';
      invoke.mockImplementation(async (_ch: string, a: { method?: string; params?: Record<string, unknown> }) => {
        switch (a?.method) {
          case 'shells.launch': return { result: { shellIndex: 2 } };
          case 'shells.alive': return { result: alive };
          case 'workspace.info': throw new Error('unknown_method');
          case 'shells.cliProfiles':
            if (opts.profilesFail) throw new Error('unknown_method');
            return { result: { profiles: [{ name: 'claude', scope: 'global', icon: '🤖' }, { name: 'mine', scope: 'project' }], defaultName } };
          case 'shells.launchProfile': case 'shells.launchPlain': return { result: { shellIndex: next++ } };
          case 'shells.kill': return { result: { ok: true } };
          case 'shells.setDefaultCli': defaultName = (a.params?.name as string | null) ?? null; return { result: { defaultName } };
          case 'shells.removeCliProfile': return { result: { ok: true } };
          default: return {};
        }
      });
    }
    const rpc = (method: string) => invoke.mock.calls.filter(([, a]) => a?.method === method).map(([, a]) => a.params);

    async function openMenu() {
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      await waitFor(() => expect(chips()).toHaveLength(2));
      fireEvent.click(screen.getByTestId('tabbar-new-shell'));
    }

    test('the + menu lists the host\'s saved profiles, offers no custom command, and opens a profile as a new selected tab', async () => {
      host();
      await openMenu();
      const mine = await screen.findByText('mine');
      expect(screen.getByText('claude')).toBeTruthy();
      expect(screen.queryByText(/custom command/i)).toBeNull();
      fireEvent.click(mine);
      await waitFor(() => expect(rpc('shells.launchProfile')).toEqual([{ projectId: 7, profileName: 'mine' }]));
      // Selected at once, before the next poll lists it.
      await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('6'));
      expect(chips()).toHaveLength(3);
    });

    test('Terminal in the + menu opens the host login shell', async () => {
      host();
      await openMenu();
      fireEvent.click(await screen.findByText('Terminal'));
      await waitFor(() => expect(rpc('shells.launchPlain')).toEqual([{ projectId: 7 }]));
      await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('6'));
    });

    test('the star sets and clears the host default, and × on a project profile removes it on the host', async () => {
      host();
      await openMenu();
      fireEvent.click(await screen.findByRole('button', { name: 'Set mine as folder default' }));
      await waitFor(() => expect(rpc('shells.setDefaultCli')).toEqual([{ projectId: 7, name: 'mine' }]));
      fireEvent.click(await screen.findByRole('button', { name: 'Clear folder default' }));
      await waitFor(() => expect(rpc('shells.setDefaultCli')).toEqual([{ projectId: 7, name: 'mine' }, { projectId: 7, name: null }]));
      fireEvent.click(screen.getByTitle('Remove from this project'));
      await waitFor(() => expect(rpc('shells.removeCliProfile')).toEqual([{ projectId: 7, name: 'mine' }]));
      await waitFor(() => expect(screen.queryByText('mine')).toBeNull());
    });

    test('an older host without profile support shows the menu error and still offers Terminal', async () => {
      host({ profilesFail: true });
      await openMenu();
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(screen.getByText('Terminal')).toBeTruthy();
    });

    test('× on a tab kills that shell on the host, drops it at once and shows a remaining tab', async () => {
      host();
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      await waitFor(() => expect(chips()).toHaveLength(2));
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('2');
      fireEvent.click(screen.getByRole('button', { name: 'Close Claude' }));
      await waitFor(() => expect(rpc('shells.kill')).toEqual([{ projectId: 7, shellIndex: 2 }]));
      await waitFor(() => expect(chips().map((c) => c.textContent)).toEqual(['Opencode']));
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3');
    });

    test('closing the last tab leaves no terminal attached and points at +', async () => {
      host();
      alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }];
      invoke.mockImplementation(async (_ch: string, a: { method?: string }) => {
        if (a?.method === 'shells.launch') return { result: { shellIndex: 2 } };
        if (a?.method === 'shells.alive') return { result: alive };
        if (a?.method === 'shells.kill') { alive = []; return { result: { ok: true } }; }
        if (a?.method === 'workspace.info') throw new Error('unknown_method');
        return {};
      });
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      await waitFor(() => expect(chips()).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: 'Close Claude' }));
      expect(await screen.findByTestId('remote-no-shells')).toBeTruthy();
      expect(screen.queryByTestId('shell-tab')).toBeNull();
      expect(screen.getByTestId('tabbar-new-shell')).toBeTruthy();
    });

    test('App\'s ⌘T / ⌘W reach the shown remote tab through the commands context, only while Shell is showing', async () => {
      host();
      const commands = { current: null as RemoteShellCommands | null };
      render(<RemoteShellCommandsContext.Provider value={commands}>
        <RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />
      </RemoteShellCommandsContext.Provider>);
      await waitFor(() => expect(chips()).toHaveLength(2));
      act(() => commands.current!.closeActive());
      await waitFor(() => expect(rpc('shells.kill')).toEqual([{ projectId: 7, shellIndex: 2 }]));
      act(() => commands.current!.newTab());
      await waitFor(() => expect(rpc('shells.launchPlain')).toEqual([{ projectId: 7 }]));
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
      await waitFor(() => expect(commands.current).toBeNull());
    });
  });

  test('the close button calls onClose', () => {
    const onClose = vi.fn();
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('remote-pane-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
