/**
 * StatusBar for a remote Fleet session (AC1): the same bar with a `<project> · <peer>` label, git from
 * `fleet:git-status` (hidden on failure), the remote shell count, the local hint, version and keep-awake
 * chip, and no port chips. Every remote negative is paired with a local positive in the same test. The
 * bar's own hooks run under a minimal in-test runtime; child components are inspected as elements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { FleetGitStatus } from '@shared/fleet-contract';
import type { Project } from '@shared/types';
import type { RemoteProjectSelection } from '@renderer/components/Sidebar';
import type { KeepAwakeControls } from '@renderer/hooks/useKeepAwake';

const rt = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: () => void; run?: () => unknown };
  const slots: unknown[] = [];
  const effects: Effect[] = [];
  let cursor = 0;
  let effectCursor = 0;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return {
    reset() {
      slots.length = 0;
      effects.length = 0;
    },
    render<T>(fn: () => T): T {
      cursor = 0;
      effectCursor = 0;
      const out = fn();
      const due = effects.filter((e) => e.run);
      for (const e of due) e.cleanup?.();
      for (const e of due) {
        const c = e.run?.();
        e.run = undefined;
        e.cleanup = typeof c === 'function' ? (c as () => void) : undefined;
      }
      return out;
    },
    unmount() {
      for (const e of effects) e.cleanup?.();
      effects.length = 0;
    },
    useState<S>(init: S | (() => S)) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof init === 'function' ? (init as () => S)() : init;
      const set = (v: S | ((p: S) => S)) => {
        slots[i] = typeof v === 'function' ? (v as (p: S) => S)(slots[i] as S) : v;
      };
      return [slots[i] as S, set] as const;
    },
    useRef<R>(init: R) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i] as { current: R };
    },
    useCallback<F>(fn: F, deps: unknown[]) {
      const i = cursor++;
      const prev = slots[i] as { fn: F; deps: unknown[] } | undefined;
      if (prev && !changed(prev.deps, deps)) return prev.fn;
      slots[i] = { fn, deps };
      return fn;
    },
    useMemo<F>(fn: () => F, deps: unknown[]): F {
      const i = cursor++;
      const prev = slots[i] as { value: F; deps: unknown[] } | undefined;
      if (prev && !changed(prev.deps, deps)) return prev.value;
      const value = fn();
      slots[i] = { value, deps };
      return value;
    },
    useEffect(run: () => unknown, deps?: unknown[]) {
      const i = effectCursor++;
      const prev = effects[i];
      if (prev && !changed(prev.deps, deps)) return;
      effects[i] = { deps, cleanup: prev?.cleanup, run };
    },
  };
});

vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useState: rt.useState,
  useRef: rt.useRef,
  useCallback: rt.useCallback,
  useMemo: rt.useMemo,
  useEffect: rt.useEffect,
}));

const net = vi.hoisted(() => ({
  git: null as null | (() => Promise<FleetGitStatus>),
  ports: [] as Array<{ projectId: number; shellIndex: number; ports: number[] }>,
}));
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@renderer/api', () => ({
  api: {
    invoke: (channel: string, req: unknown) => {
      invoke(channel, req);
      if (channel === 'fleet:git-status') return net.git?.() ?? new Promise(() => undefined);
      if (channel === 'git:status')
        return Promise.resolve({
          isRepo: true,
          branch: 'local-branch',
          ahead: 0,
          behind: 0,
          files: {},
          dirty: false,
        });
      if (channel === 'shells:ports') return Promise.resolve({ entries: net.ports });
      if (channel === 'app:get-version') return Promise.resolve({ version: '9.9.9' });
      return Promise.resolve({});
    },
    on: () => () => undefined,
  },
}));
vi.mock('@renderer/shortcut-platform', () => ({
  useShortcutPlatform: () => 'mac',
  RUNTIME_SHORTCUT_PLATFORM: 'mac',
}));

const { StatusBar, PaletteHint } = await import('@renderer/components/StatusBar');
const { KeepAwakeChip } = await import('@renderer/components/KeepAwakeChip');

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const channels = () => invoke.mock.calls.map((c) => c[0] as string);

function nodes(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement(node)) return [];
  const children = (node.props as { children?: ReactNode }).children;
  return [node, ...nodes(children)];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (!isValidElement(node)) return '';
  return text((node.props as { children?: ReactNode }).children);
}
const byTestId = (tree: ReactNode, id: string) =>
  nodes(tree).filter((n) => (n.props as { 'data-testid'?: string })['data-testid'] === id);
const portChips = (tree: ReactNode) =>
  nodes(tree).filter((n) =>
    String((n.props as { 'data-testid'?: string })['data-testid'] ?? '').startsWith('port-chip-'),
  );

const project: Project = {
  id: 7,
  rootId: 1,
  name: 'local-demo',
  path: '/p/demo',
  config: {},
  metaprojectProjectId: null,
  linkedChatChannelId: null,
  lastOpenedAt: null,
  pinned: false,
  hidden: false,
  firstLaunchedAt: null,
};
const remote: RemoteProjectSelection = {
  peerId: 'peer-b',
  peerName: 'Build Mac',
  projectId: 7,
  projectName: 'Service',
};
const REPO: FleetGitStatus = {
  isRepo: true,
  branch: 'feature/x',
  dirty: true,
  ahead: 2,
  behind: 1,
  changedCount: 3,
};
const keepAwake: KeepAwakeControls = {
  state: { kind: 'off' },
  stop: vi.fn(),
  darkenNow: vi.fn(),
} as unknown as KeepAwakeControls;

function mount(props: {
  project: Project | null;
  remote?: RemoteProjectSelection | null;
  aliveCount?: number;
}) {
  return () =>
    rt.render(() =>
      StatusBar({
        aliveCount: props.aliveCount ?? 1,
        onOpenPalette: () => undefined,
        keepAwake,
        ...props,
      }),
    );
}

beforeEach(() => {
  rt.reset();
  invoke.mockReset();
  net.git = null;
  net.ports = [{ projectId: 7, shellIndex: 0, ports: [5173] }];
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('window', {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
});
afterEach(() => {
  rt.unmount();
  vi.unstubAllGlobals();
});

describe('StatusBar for a remote session', () => {
  it('is the same status bar, labelled "<project> · <peer>"', () => {
    const tree = mount({ project: null, remote })();
    expect(byTestId(tree, 'status-bar')).toHaveLength(1);
    expect(text(tree)).toContain('Service · Build Mac');
    expect(text(tree)).not.toContain('no project');
  });

  it('reads git from the peer and never asks local git:status; local asks git:status', () => {
    mount({ project: null, remote })();
    expect(invoke).toHaveBeenCalledWith('fleet:git-status', { peerId: 'peer-b', projectId: 7 });
    expect(channels()).not.toContain('git:status');
    rt.unmount();
    rt.reset();
    invoke.mockReset();
    mount({ project })();
    expect(invoke).toHaveBeenCalledWith('git:status', { projectId: 7 });
    expect(channels()).not.toContain('fleet:git-status');
  });

  it('shows the remote branch, dirty marker, ahead/behind and changed count', async () => {
    net.git = () => Promise.resolve(REPO);
    const render = mount({ project: null, remote });
    render();
    await flush();
    const tree = render();
    const plain = text(tree);
    expect(plain).toContain('feature/x');
    expect(plain).toContain('●');
    expect(plain).toContain('↑2');
    expect(plain).toContain('↓1');
    const titled = nodes(tree).find((n) =>
      String((n.props as { title?: string }).title ?? '').startsWith('feature/x'),
    );
    expect((titled?.props as { title?: string } | undefined)?.title).toBe(
      'feature/x · ahead 2 · behind 1 · 3 changed',
    );
  });

  it('hides the git chip without crashing when fleet:git-status rejects, keeping the label', async () => {
    net.git = () => Promise.reject(new Error('peer offline'));
    const render = mount({ project: null, remote });
    render();
    await flush();
    const tree = render();
    expect(text(tree)).toContain('Service · Build Mac');
    expect(text(tree)).not.toContain('↑');
    expect(
      nodes(tree).some((n) =>
        String((n.props as { title?: string }).title ?? '').includes('changed'),
      ),
    ).toBe(false);
  });

  it('shows no port chips for a remote session even when a local project with that id has ports', async () => {
    const remoteRender = mount({ project: null, remote });
    remoteRender();
    await flush();
    expect(portChips(remoteRender())).toHaveLength(0);
    rt.unmount();
    rt.reset();
    const localRender = mount({ project });
    localRender();
    await flush();
    expect(
      portChips(localRender()).map((n) => (n.props as { 'data-testid': string })['data-testid']),
    ).toEqual(['port-chip-5173']);
  });

  it('shows the remote shell count in the shells chip', () => {
    const tree = mount({ project: null, remote, aliveCount: 3 })();
    const chip = byTestId(tree, 'shells-chip');
    expect(chip).toHaveLength(1);
    expect(text(chip[0])).toBe('3 shells');
    expect(
      text(byTestId(mount({ project: null, remote, aliveCount: 1 })(), 'shells-chip')[0]),
    ).toBe('1 shell');
  });

  it('keeps the palette hint, version and keep-awake chip', async () => {
    const render = mount({ project: null, remote });
    render();
    await flush();
    const tree = render();
    expect(nodes(tree).some((n) => n.type === PaletteHint)).toBe(true);
    expect(nodes(tree).some((n) => n.type === KeepAwakeChip)).toBe(true);
    expect(text(tree)).toContain('v9.9.9');
  });
});
