// @vitest-environment jsdom
/**
 * The command palette's In use group with paired machines: remote live projects follow this
 * machine's live projects, and each In use row shows its global Ctrl+<n> key from the shared list
 * (`in-use-jump.ts`), also when a query filters the list. The palette leaves Ctrl+<n> itself to
 * App's global handler: it neither picks nor stops the key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Project } from '@shared/types';
import type { RemoteInUseRow } from '@renderer/fleet-in-use';
import type { InUseTarget } from '@renderer/in-use-jump';
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
vi.mock('@renderer/p2p/FleetStateProvider', () => ({
  useFleetStateOrNull: () => ({
    localInUse: [2],
    remoteInUse: state.remote,
    inUseTargets: [{ kind: 'local', projectId: 2 } as InUseTarget, ...state.remote.map((row): InUseTarget => ({ kind: 'remote', row }))],
  }),
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

const jumpKeyOf = (row: HTMLElement | undefined): string | null | undefined =>
  row?.querySelector(`[data-testid="${PALETTE_TESTIDS.jumpKey}"]`)?.textContent;

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
  it('lists this machine\'s live projects, then the paired machines\', each with its global Ctrl+<n> key', () => {
    open();
    const rows = inUseRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('beta');
    expect(rows[1]?.textContent).toContain('api');
    expect(rows[1]?.querySelector(`[data-testid="${PALETTE_TESTIDS.remoteMachine}"]`)?.textContent).toBe('Studio');
    expect(rows[2]?.querySelector(`[data-testid="${PALETTE_TESTIDS.remoteMachine}"]`)?.textContent).toBe('Laptop');
    // The highlighted first row shows "Open"; the others show their key.
    expect(jumpKeyOf(rows[0])).toBeUndefined();
    expect([jumpKeyOf(rows[1]), jumpKeyOf(rows[2])]).toEqual([2, 3].map((n) => PALETTE_COPY.jumpKey(n, RUNTIME_SHORTCUT_PLATFORM)));
    const projectsGroup = screen.getAllByTestId(PALETTE_TESTIDS.group).find((g) => g.textContent?.startsWith(PALETTE_COPY.groupTitles.projects));
    expect(projectsGroup?.querySelector(`[data-testid="${PALETTE_TESTIDS.jumpKey}"]`)).toBeNull();
  });

  it('keeps each row\'s global number when a query filters In use', () => {
    state.remote = [...state.remote, { deviceId: 'dev-laptop', deviceName: 'Laptop', projectId: 10, name: 'notes-2', state: 'idle' }];
    const input = open();
    fireEvent.change(input, { target: { value: 'notes' } });
    const rows = inUseRows();
    expect(rows.map((r) => r.textContent?.includes('notes'))).toEqual([true, true]);
    // Global list: beta 1, api 2, notes 3, notes-2 4. The first (highlighted) row shows Open.
    expect(jumpKeyOf(rows[1])).toBe(PALETTE_COPY.jumpKey(4, RUNTIME_SHORTCUT_PLATFORM));
  });

  it('leaves Ctrl+<n> to App: no pick and the key is not consumed', () => {
    const input = open();
    const notCanceled = fireEvent.keyDown(input, { key: '2', ctrlKey: true });
    expect(notCanceled).toBe(true);
    expect(picks.onPickRemote).not.toHaveBeenCalled();
    expect(picks.onPickProject).not.toHaveBeenCalled();
    expect(picks.onClose).not.toHaveBeenCalled();
  });
});
