/** Sidebar tests keep local roots ahead of separately identified remote projects and offline machines. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import type * as ReactModule from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnimatePresence } from 'motion/react';
import type { FleetState, FleetStatus } from '@shared/fleet-contract';
import type { Project, Root } from '@shared/types';
import type { RemoteProjectSelection } from '@renderer/components/Sidebar';

interface Scenario {
  fleet: unknown;
  statuses: unknown;
  readonly refs: Array<{ current: unknown }>;
  readonly effects: Array<() => unknown>;
  emit: ((next: FleetState) => void) | null;
  error: boolean;
  cursor: number;
  refCursor: number;
}
const scenario = vi.hoisted((): Scenario => {
  const fleet: unknown = null;
  const statuses: unknown = {};
  const refs: Array<{ current: unknown }> = [];
  const effects: Array<() => unknown> = [];
  const emit: ((next: FleetState) => void) | null = null;
  return { fleet, statuses, refs, effects, emit, error: false, cursor: 0, refCursor: 0 };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof ReactModule>()),
  useState: (initial: unknown) => {
    const index = scenario.cursor++;
    const value = index === 1 ? scenario.fleet : index === 2 ? scenario.error :
      index === 3 ? scenario.statuses : typeof initial === 'function' ? Reflect.apply(initial, undefined, []) : initial;
    return [value, (next: unknown) => {
      const resolved = typeof next === 'function' ? Reflect.apply(next, undefined, [index === 1 ? scenario.fleet : index === 3 ? scenario.statuses : value]) : next;
      if (index === 1) scenario.fleet = resolved;
      if (index === 2) scenario.error = resolved === true;
      if (index === 3) scenario.statuses = resolved;
    }];
  },
  useRef: (value: unknown) => {
    const index = scenario.refCursor++;
    return scenario.refs[index] ??= { current: value };
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: (callback: () => unknown) => { scenario.effects.push(callback); },
}));
const local: Project = {
  id: 12, rootId: 1, name: 'Service', path: '/work/Service', config: {},
  metaprojectProjectId: null, linkedChatChannelId: null, lastOpenedAt: null,
  pinned: false, hidden: false, firstLaunchedAt: null,
};
const root: Root = { id: 1, path: '/work', addedAt: '2024-01-01', sortOrder: 0 };
vi.mock('@renderer/hooks/useRoots', () => ({ useRoots: () => ({ roots: [root], refresh: vi.fn() }) }));
vi.mock('@renderer/hooks/useProjects', () => ({ useProjects: () => ({ projects: [local], refresh: vi.fn() }) }));
vi.mock('@renderer/hooks/useRecents', () => ({ useRecents: () => ({ recents: [] }) }));
vi.mock('@renderer/hooks/useAliveShellIds', () => ({ useAliveShellIds: () => ({ aliveIds: new Set<number>() }) }));
vi.mock('@renderer/hooks/useAgentStates', () => ({ useOverallAgentState: () => 'idle', useProjectAgentState: () => 'idle' }));
vi.mock('@renderer/components/SidebarHeader', () => ({ SidebarHeader: () => null }));
const invoke = vi.hoisted(() => vi.fn());
const on = vi.hoisted(() => vi.fn());
vi.mock('@renderer/api', () => ({ api: { invoke, on } }));
const { Sidebar } = await import('@renderer/components/Sidebar');
const chosen: RemoteProjectSelection = { peerId: 'machine-b', peerName: 'Build Mac', projectId: 12, projectName: 'Service' };
const onSelect = vi.fn();
const onSelectRemote = vi.fn();
const status: FleetStatus = { projects: [{ id: 12, name: 'Service' }], shells: [] };
const props = {
  selectedProjectId: null,
  selectedRemote: chosen,
  onSelect,
  onSelectRemote,
  onEditEnv: vi.fn(),
  onProjectSettings: vi.fn(),
};
function nodes(node: unknown): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement(node)) return [];
  const props: unknown = node.props;
  const children = props !== null && typeof props === 'object' && 'children' in props ? props.children : undefined;
  if (node.type === AnimatePresence) return nodes(children);
  if (typeof node.type === 'function') return nodes(Reflect.apply(node.type, undefined, [props]));
  return [node, ...nodes(children)];
}
function row(node: ReactElement, testId: string): boolean {
  const props: unknown = node.props;
  return node.type === 'button' && props !== null && typeof props === 'object' &&
    'data-testid' in props && props['data-testid'] === testId;
}
function markup() { scenario.cursor = 0; scenario.refCursor = 0; return renderToStaticMarkup(<Sidebar {...props} />); }
beforeEach(() => {
  onSelect.mockClear();
  scenario.cursor = 0;
  scenario.refCursor = 0;
  scenario.refs.length = 0;
  scenario.effects.length = 0;
  scenario.emit = null;
  scenario.error = false;
  invoke.mockReset();
  on.mockReset();
  invoke.mockImplementation((channel: string) => Promise.resolve(channel === 'fleet:get-state' ? scenario.fleet : status));
  on.mockImplementation((_channel: string, listener: (next: FleetState) => void) => {
    scenario.emit = listener;
    return () => { if (scenario.emit === listener) scenario.emit = null; };
  });
  onSelectRemote.mockClear();
  scenario.fleet = { enabled: true, peers: [{ id: 'machine-b', name: 'Build Mac', status: 'linked' }, { id: 'machine-c', name: 'Other Mac', status: 'offline' }] };
  scenario.statuses = { 'machine-b': { kind: 'ready', data: status }, 'machine-c': { kind: 'ready', data: status } };
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
});
afterEach(() => vi.unstubAllGlobals());

describe('Projects sidebar Fleet grouping', () => {
  it('places linked and offline machine headings after local roots, not in recents or Fleet activity', () => {
    const html = markup();
    expect(html.indexOf('/work')).toBeLessThan(html.indexOf('Build Mac'));
    expect(html).toContain('Build Mac, linked');
    expect(html).toContain('Other Mac, offline');
    expect(html).toContain('Projects on Build Mac');
    expect(html).not.toContain('Projects on Other Mac');
  });

  it('distinguishes remote numeric ID 12 from local project ID 12, and sends peer identity on click', () => {
    scenario.cursor = 0;
    const projectButtons = nodes(Sidebar(props)).filter((node) => row(node, 'remote-project-row'));
    expect(projectButtons).toHaveLength(1);
    const button = projectButtons[0];
    expect(button?.props).toMatchObject({ 'aria-label': 'Service on Build Mac', 'aria-current': 'true' });
    if (button && 'onClick' in button.props && typeof button.props.onClick === 'function') button.props.onClick();
    expect(onSelectRemote).toHaveBeenCalledWith(chosen);
    expect(onSelect).not.toHaveBeenCalled();
    scenario.cursor = 0;
    const localButton = nodes(Sidebar(props)).find((node) => row(node, 'project-row'));
    expect(localButton).toBeDefined();
    if (localButton && 'onClick' in localButton.props && typeof localButton.props.onClick === 'function') localButton.props.onClick();
    expect(onSelect).toHaveBeenCalledWith(local);
  });

  it('removes stale remote rows when a peer goes offline, is revoked, or Fleet is disabled', () => {
    expect(markup()).toContain('Service on Build Mac');
    scenario.fleet = { enabled: true, peers: [{ id: 'machine-b', name: 'Build Mac', status: 'offline' }] };
    expect(markup()).toContain('Build Mac, offline');
    expect(markup()).not.toContain('Service on Build Mac');
    scenario.fleet = { enabled: true, peers: [] };
    expect(markup()).not.toContain('Build Mac, offline');
    scenario.fleet = { enabled: false, peers: [] };
    expect(markup()).not.toContain('fleet-machine');
  });

  it('shows an actionable failure rather than treating failed status as empty projects', () => {
    scenario.statuses = { 'machine-b': { kind: 'error' } };
    const html = markup();
    expect(html).toContain('role="alert"');
    expect(html).toContain('>Retry</button>');
    expect(html).not.toContain('data-testid="remote-project-row"');
  });

  it('ignores an in-flight status after link loss, then loads current projects on reconnection', async () => {
    scenario.statuses = {};
    const replies: Array<(data: FleetStatus) => void> = [];
    invoke.mockImplementation((channel: string) => channel === 'fleet:get-state'
      ? Promise.resolve(scenario.fleet)
      : new Promise<FleetStatus>((resolve) => { replies.push(resolve); }));
    vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    scenario.cursor = 0;
    scenario.refCursor = 0;
    Sidebar(props);
    const disconnect = scenario.effects[0]?.();
    await Promise.resolve();
    const stopRefresh = scenario.effects[1]?.();
    expect(invoke).toHaveBeenCalledWith('fleet:status', { peerId: 'machine-b' });
    const oldReply = replies[0];
    expect(oldReply).toBeDefined();
    scenario.emit?.({ enabled: true, peers: [{ id: 'machine-b', name: 'Build Mac', status: 'offline' }] });
    oldReply?.(status);
    await Promise.resolve();
    await Promise.resolve();
    scenario.emit?.({ enabled: true, peers: [{ id: 'machine-b', name: 'Build Mac', status: 'linked' }] });
    expect(markup()).not.toContain('data-testid=\"remote-project-row\"');
    scenario.effects[1]?.();
    const freshReply = replies[1];
    expect(freshReply).toBeDefined();
    freshReply?.(status);
    await Promise.resolve();
    await Promise.resolve();
    expect(markup()).toContain('data-testid=\"remote-project-row\"');
    if (typeof stopRefresh === 'function') stopRefresh();
    if (typeof disconnect === 'function') disconnect();
  });
});
