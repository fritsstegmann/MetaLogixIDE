/** Sidebar tests keep local and remote folder hierarchies separate, including collapse and offline states. */
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
  readonly states: Map<number, unknown>;
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
  return { fleet, statuses, refs, states: new Map(), effects, emit, error: false, cursor: 0, refCursor: 0 };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof ReactModule>()),
  useState: (initial: unknown) => {
    const index = scenario.cursor++;
    const value = index === 1 ? scenario.fleet : index === 2 ? scenario.error :
      index === 3 ? scenario.statuses : scenario.states.has(index) ? scenario.states.get(index) :
        typeof initial === 'function' ? Reflect.apply(initial, undefined, []) : initial;
    return [value, (next: unknown) => {
      const resolved = typeof next === 'function' ? Reflect.apply(next, undefined, [index === 1 ? scenario.fleet : index === 3 ? scenario.statuses : scenario.states.get(index) ?? value]) : next;
      if (index === 1) scenario.fleet = resolved;
      else if (index === 2) scenario.error = resolved === true;
      else if (index === 3) scenario.statuses = resolved;
      else scenario.states.set(index, resolved);
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
const status: FleetStatus = {
  roots: [{ id: 1, name: 'Workspace' }, { id: 2, name: 'Archive' }],
  projects: [{ id: 12, rootId: 1, name: 'Service' }, { id: 14, rootId: 2, name: 'Old Site' }, { id: 13, rootId: 1, name: 'Client' }],
  shells: [{ projectId: 12, shellIndex: 0, agent: null, state: 'busy' }],
};
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
function clickButton(testId: string, label: string): void {
  scenario.cursor = 0;
  scenario.refCursor = 0;
  const button = nodes(Sidebar(props)).find((node) => row(node, testId) &&
    typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith(label));
  expect(button).toBeDefined();
  if (button && 'onClick' in button.props && typeof button.props.onClick === 'function') button.props.onClick();
}
beforeEach(() => {
  onSelect.mockClear();
  scenario.cursor = 0;
  scenario.refCursor = 0;
  scenario.states.clear();
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
  it('renders each linked and offline machine as its own Projects-style section after local folders', () => {
    const html = markup();
    expect(html).toContain('data-testid="fleet-machine-machine-b-toggle"');
    expect(html).toContain('data-testid="section-all-toggle"');
    expect(html.indexOf('/work')).toBeLessThan(html.indexOf('data-testid="fleet-machine-machine-b"'));
    expect(html).toContain('data-testid="fleet-machine-machine-c-toggle"');
    expect(html).toContain('Projects in Workspace on Build Mac');
    expect(html).not.toContain('Projects in Workspace on Other Mac');
  });

  it('groups remote projects beneath their matching named folders in server order with project counts and live status', () => {
    const html = markup();
    const workspace = html.match(/aria-label="Workspace on Build Mac[^"]*"[^>]*>[\s\S]*?<\/button>/)?.[0];
    const archive = html.match(/aria-label="Archive on Build Mac[^"]*"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(workspace).toContain('2 projects');
    expect(workspace).toContain('1/2');
    expect(archive).toContain('1 project');
    expect(archive).toContain('>1</span>');
    expect(html.indexOf('Workspace on Build Mac')).toBeLessThan(html.indexOf('Service on Build Mac'));
    expect(html.indexOf('Service on Build Mac')).toBeLessThan(html.indexOf('Client on Build Mac'));
    expect(html.indexOf('Client on Build Mac')).toBeLessThan(html.indexOf('Archive on Build Mac'));
    expect(html.indexOf('Archive on Build Mac')).toBeLessThan(html.indexOf('Old Site on Build Mac'));
    const workspaceProjects = html.match(/<ul aria-label="Projects in Workspace on Build Mac"[^>]*>[\s\S]*?<\/ul>/)?.[0];
    const archiveProjects = html.match(/<ul aria-label="Projects in Archive on Build Mac"[^>]*>[\s\S]*?<\/ul>/)?.[0];
    expect(workspaceProjects).toContain('Service on Build Mac');
    expect(workspaceProjects).toContain('Client on Build Mac');
    expect(workspaceProjects).not.toContain('Old Site on Build Mac');
    expect(archiveProjects).toContain('Old Site on Build Mac');
    expect(archiveProjects).not.toContain('Service on Build Mac');
    const selected = html.match(/aria-label="Service on Build Mac"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(selected).toContain('aria-current="true"');
    expect(selected).toContain('aria-label="Working"');
  });

  it('never displays an absolute remote location even if an unexpected status includes one', () => {
    scenario.statuses = { 'machine-b': { kind: 'ready', data: {
      roots: [{ id: 1, name: 'Workspace', path: '/private/remote/Workspace' }],
      projects: [{ id: 12, rootId: 1, name: 'Service', path: '/private/remote/Workspace/Service' }],
      shells: [],
    } } };
    const html = markup();
    expect(html).toContain('Workspace on Build Mac');
    expect(html).toContain('Service on Build Mac');
    expect(html).not.toContain('/private/remote/');
  });

  it('keeps remote folder collapse independent across roots, peers, and the local root with the same numeric ID', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    scenario.fleet = { enabled: true, peers: [
      { id: 'machine-b', name: 'Build Mac', status: 'linked' },
      { id: 'machine-c', name: 'Other Mac', status: 'linked' },
    ] };
    clickButton('remote-root-toggle', 'Workspace on Build Mac');
    const html = markup();
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-label="Workspace on Build Mac/);
    expect(html).not.toContain('Service on Build Mac');
    expect(html).toContain('Old Site on Build Mac');
    expect(html).toContain('Service on Other Mac');
    expect(html).toContain('data-testid="project-row"');
    expect(html).toContain('data-testid="root-toggle"');
    clickButton('remote-root-toggle', 'Archive on Build Mac');
    expect(markup()).not.toContain('Old Site on Build Mac');
    scenario.states.clear();
    expect(markup()).not.toContain('Service on Build Mac');
    expect(markup()).not.toContain('Old Site on Build Mac');
    clickButton('remote-root-toggle', 'Workspace on Build Mac');
    expect(markup()).toMatch(/<button[^>]*aria-expanded="true"[^>]*aria-label="Workspace on Build Mac/);
    expect(markup()).toContain('Service on Build Mac');
    expect(markup()).not.toContain('Old Site on Build Mac');
  });

  it('keeps a peer section collapsed independently of its root folders', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    clickButton('remote-root-toggle', 'Workspace on Build Mac');
    clickButton('fleet-machine-machine-b-toggle', 'Build Mac, online');
    expect(markup()).not.toContain('Workspace on Build Mac');
    expect(markup()).toContain('Build Mac, online');
    scenario.states.clear();
    expect(markup()).not.toContain('Workspace on Build Mac');
    clickButton('fleet-machine-machine-b-toggle', 'Build Mac, online');
    expect(markup()).toContain('Workspace on Build Mac');
    expect(markup()).not.toContain('Service on Build Mac');
  });

  it('selects a same-numbered project on another peer without selecting the first peer or local project', () => {
    scenario.fleet = { enabled: true, peers: [
      { id: 'machine-b', name: 'Build Mac', status: 'linked' },
      { id: 'machine-c', name: 'Other Mac', status: 'linked' },
    ] };
    const html = markup();
    const other = html.match(/aria-label="Service on Other Mac"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(other).toContain('Service');
    expect(other).not.toContain('aria-current');
    clickButton('remote-project-row', 'Service on Other Mac');
    expect(onSelectRemote).toHaveBeenCalledWith({
      peerId: 'machine-c', peerName: 'Other Mac', projectId: 12, projectName: 'Service',
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders folders with zero projects and a useful empty state for no remote folders', () => {
    scenario.statuses = { 'machine-b': { kind: 'ready', data: {
      roots: [{ id: 4, name: 'Empty Folder' }], projects: [], shells: [],
    } } };
    const withEmptyFolder = markup();
    expect(withEmptyFolder).toContain('Empty Folder on Build Mac');
    expect(withEmptyFolder).toContain('0 projects');
    expect(withEmptyFolder).toContain('>0</span>');
    expect(withEmptyFolder).toContain('No remote projects.');
    scenario.statuses = { 'machine-b': { kind: 'ready', data: { roots: [], projects: [], shells: [] } } };
    expect(markup()).toContain('No remote folders.');
    expect(markup()).not.toContain('Empty Folder on Build Mac');
  });

  it('filters remote project names without losing their root folder hierarchy', () => {
    scenario.states.set(0, 'OLD');
    const html = markup();
    expect(html).toContain('Workspace on Build Mac');
    expect(html).toContain('Archive on Build Mac');
    expect(html).toContain('Old Site on Build Mac');
    expect(html).not.toContain('Service on Build Mac');
    expect(html).not.toContain('Client on Build Mac');
    expect(html).toContain('Projects in Archive on Build Mac');
  });

  it('keeps machine headings and folders visible when local Projects is collapsed', () => {
    vi.stubGlobal('localStorage', { getItem: () => '["All projects"]', setItem: () => undefined });
    const html = markup();
    expect(html).not.toContain('data-testid="root-toggle"');
    expect(html).toContain('data-testid="fleet-machine-machine-b-toggle"');
    expect(html).toContain('data-testid="remote-project-row"');
  });

  it('loads folders for an expanded linked machine without selecting a remote project', async () => {
    scenario.statuses = {};
    scenario.cursor = 0;
    scenario.refCursor = 0;
    renderToStaticMarkup(<Sidebar {...props} selectedRemote={null} />);
    scenario.effects[0]?.();
    await Promise.resolve();
    scenario.effects[3]?.();
    expect(invoke).toHaveBeenCalledWith('fleet:status', { peerId: 'machine-b' });
    expect(invoke).not.toHaveBeenCalledWith('fleet:status', { peerId: 'machine-c' });
  });

  it('distinguishes remote numeric ID 12 from local project ID 12, and sends peer identity on click', () => {
    scenario.cursor = 0;
    const projectButtons = nodes(Sidebar(props)).filter((node) => row(node, 'remote-project-row'));
    expect(projectButtons).toHaveLength(3);
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
    expect(markup()).not.toContain('Workspace on Build Mac');
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

  it('announces loading and retries a failed remote folder status', async () => {
    scenario.statuses = { 'machine-b': { kind: 'loading' } };
    expect(markup()).toContain('role="status"');
    expect(markup()).toContain('Loading projects…');
    scenario.statuses = { 'machine-b': { kind: 'error' } };
    scenario.cursor = 0;
    scenario.refCursor = 0;
    const retry = nodes(Sidebar(props)).find((node) => node.type === 'button' && node.props.children === 'Retry');
    expect(retry).toBeDefined();
    const fleetRef = scenario.refs[0];
    expect(fleetRef).toBeDefined();
    if (fleetRef) fleetRef.current = scenario.fleet;
    if (retry && 'onClick' in retry.props && typeof retry.props.onClick === 'function') retry.props.onClick();
    expect(invoke).toHaveBeenCalledWith('fleet:status', { peerId: 'machine-b' });
    await Promise.resolve();
    await Promise.resolve();
    expect(markup()).toContain('Workspace on Build Mac');
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
    scenario.emit?.({ enabled: true, peers: [{ id: 'machine-b', name: 'Build Mac', status: 'offline' }], controls: [] });
    oldReply?.(status);
    await Promise.resolve();
    await Promise.resolve();
    scenario.emit?.({ enabled: true, peers: [{ id: 'machine-b', name: 'Build Mac', status: 'linked' }], controls: [] });
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
