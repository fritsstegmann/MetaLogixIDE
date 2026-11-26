// @vitest-environment jsdom
/**
 * The command palette's In use group with paired machines: remote live projects follow this
 * machine's live projects, each of the first nine In use rows shows its Ctrl+<n> key, Ctrl+<n> in
 * the search field opens that row (a local pick or the remote project pane), and anything but a
 * bare Ctrl+1–9, or a number past the group, leaves the palette open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Project } from '@shared/types';
import type { RemoteInUseRow } from '@renderer/fleet-in-use';
import { PALETTE_COPY, PALETTE_TESTIDS, type PaletteRequest } from '@renderer/command-palette-contract';
import { RUNTIME_SHORTCUT_PLATFORM } from '@renderer/shortcut-platform';

function project(id: number, name: string): Project {
  return {
    id, rootId: 1, path: `/work/${name}`, name, metaprojectProjectId: null, linkedChatChannelId: null,
    lastOpenedAt: null, pinned: false, hidden: false, firstLaunchedAt: null, config: {} as Project['config'],
  };
}

const state = vi.hoisted(() => ({ remote: [] as RemoteInUseRow[] }));
const PROJECTS = [project(1, 'alpha'), project(2, 'beta')];

vi.mock('@renderer/api', () => ({ api: { invoke: async () => ({}), on: () => () => {} } }));
vi.mock('@renderer/hooks/useProjects', () => ({ useProjects: () => ({ projects: PROJECTS, refresh: async () => undefined }) }));
vi.mock('@renderer/hooks/useAliveShellIds', () => ({ useAliveShellIds: () => ({ aliveIds: new Set([2]), primaryIds: new Set([2]), refresh: async () => undefined }) }));
vi.mock('@renderer/hooks/useRoots', () => ({ useRoots: () => ({ roots: [], refresh: async () => undefined }) }));
vi.mock('@renderer/hooks/usePaletteFiles', () => ({ usePaletteFiles: () => ({ status: 'idle' }) }));
vi.mock('@renderer/hooks/useAgentStates', () => ({ useProjectAgentState: () => 'busy' }));
vi.mock('@renderer/p2p/FleetStateProvider', () => ({ useFleetStateOrNull: () => ({ switcher: {}, names: new Map() }) }));
vi.mock('@renderer/fleet-in-use', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/fleet-in-use')>()),
  remoteInUseRows: () => state.remote,
}));

import { CommandPalette } from '@renderer/components/CommandPalette';

const picks = {
  onPickProject: vi.fn(),
  onPickCurrent: vi.fn(),
  onPickFile: vi.fn(),
  onPickRemote: vi.fn(),
  onClose: vi.fn(),
};

function open(request: PaletteRequest = { seq: 1, seed: '' }) {
  render(<CommandPalette request={request} commands={[]} currentProject={null} {...picks} />);
  return screen.getByTestId(PALETTE_TESTIDS.input);
}

function inUseRows(): HTMLElement[] {
  const group = screen.getAllByTestId(PALETTE_TESTIDS.group).find((g) => g.textContent?.startsWith(PALETTE_COPY.groupTitles.running));
  return group ? [...group.querySelectorAll<HTMLElement>(`[data-testid="${PALETTE_TESTIDS.option}"]`)] : [];
}

beforeEach(() => {
  // jsdom has no layout; the palette scrolls the highlighted option into view.
  Element.prototype.scrollIntoView = () => undefined;
  state.remote = [
    { deviceId: 'dev-studio', deviceName: 'Studio', projectId: 7, name: 'api', state: 'busy' },
    { deviceId: 'dev-laptop', deviceName: 'Laptop', projectId: 9, name: 'notes', state: 'blocked' },
  ];
  for (const fn of Object.values(picks)) fn.mockReset();
});

afterEach(() => cleanup());

describe('palette In use with paired machines', () => {
  it('lists this machine\'s live projects, then the paired machines\', each with its Ctrl+<n> key', () => {
    open();
    const rows = inUseRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('beta');
    expect(rows[1]?.textContent).toContain('api');
    expect(rows[2]?.textContent).toContain('notes');
    expect(rows[2]?.querySelector(`[data-testid="${PALETTE_TESTIDS.remoteMachine}"]`)?.textContent).toBe('Laptop');
    expect(rows[1]?.querySelector(`[data-testid="${PALETTE_TESTIDS.remoteMachine}"]`)?.textContent).toBe('Studio');
    // The highlighted first row shows "Open"; the others show their jump key.
    expect(rows[0]?.querySelector(`[data-testid="${PALETTE_TESTIDS.jumpKey}"]`)).toBeNull();
    expect(rows.slice(1).map((r) => r.querySelector(`[data-testid="${PALETTE_TESTIDS.jumpKey}"]`)?.textContent))
      .toEqual([PALETTE_COPY.jumpKey(2, RUNTIME_SHORTCUT_PLATFORM), PALETTE_COPY.jumpKey(3, RUNTIME_SHORTCUT_PLATFORM)]);
    // Not-running projects are not numbered.
    const projectsGroup = screen.getAllByTestId(PALETTE_TESTIDS.group).find((g) => g.textContent?.startsWith(PALETTE_COPY.groupTitles.projects));
    expect(projectsGroup?.querySelector(`[data-testid="${PALETTE_TESTIDS.jumpKey}"]`)).toBeNull();
  });

  it('Ctrl+2 opens the first paired machine\'s project pane, after closing', () => {
    const input = open();
    fireEvent.keyDown(input, { key: '2', ctrlKey: true });
    expect(picks.onClose).toHaveBeenCalledTimes(1);
    expect(picks.onPickRemote).toHaveBeenCalledWith({ source: { kind: 'remote', deviceId: 'dev-studio' }, deviceName: 'Studio', projectId: 7, projectName: 'api' });
    expect(picks.onPickProject).not.toHaveBeenCalled();
  });

  it('Ctrl+1 opens this machine\'s live project', () => {
    const input = open();
    fireEvent.keyDown(input, { key: '1', ctrlKey: true });
    expect(picks.onPickProject).toHaveBeenCalledWith(PROJECTS[1]);
    expect(picks.onPickRemote).not.toHaveBeenCalled();
  });

  it('leaves the palette open for a number past In use, a modified Ctrl+<n> or a plain digit', () => {
    const input = open();
    fireEvent.keyDown(input, { key: '4', ctrlKey: true });
    fireEvent.keyDown(input, { key: '2', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(input, { key: '2', ctrlKey: true, metaKey: true });
    fireEvent.keyDown(input, { key: '2' });
    expect(picks.onClose).not.toHaveBeenCalled();
    expect(picks.onPickRemote).not.toHaveBeenCalled();
    expect(picks.onPickProject).not.toHaveBeenCalled();
  });
});
