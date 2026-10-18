/**
 * Tasks panel presentation (AC15, AC16, AC18, AC19) and its request gate (AC25): on a project change
 * tasks and notices clear and a late reply from the old project is ignored. The gate runs under a
 * minimal in-test hook runtime (vitest env is node); the presentational components use no hooks.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { TASKS_COPY, type TaskDef, type TaskNotice, type TaskNoticeKind, type TasksDiscovery } from '@shared/tasks-contract';

const rt = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: () => void; run?: () => unknown };
  const slots: unknown[] = [];
  const effects: Effect[] = [];
  let cursor = 0;
  let effectCursor = 0;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const memo = <F,>(fn: () => F, deps: unknown[]): F => {
    const i = cursor++;
    const prev = slots[i] as { v: F; deps: unknown[] } | undefined;
    if (prev && !changed(prev.deps, deps)) return prev.v;
    const v = fn();
    slots[i] = { v, deps };
    return v;
  };
  return {
    reset() { slots.length = 0; effects.length = 0; },
    render<T,>(fn: () => T): T {
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
    unmount() { for (const e of effects) e.cleanup?.(); },
    useState<S,>(init: S) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = init;
      const set = (v: S | ((p: S) => S)) => { slots[i] = typeof v === 'function' ? (v as (p: S) => S)(slots[i] as S) : v; };
      return [slots[i] as S, set] as const;
    },
    useRef<R,>(init: R) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i] as { current: R };
    },
    useCallback: <F,>(fn: F, deps: unknown[]) => memo(() => fn, deps),
    useMemo: memo,
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

type Call = { projectId: number; resolve: (v: TasksDiscovery) => void; reject: (e: unknown) => void };
const calls: Call[] = [];
vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn((_channel: string, req: { projectId: number }) =>
      new Promise((resolve, reject) => { calls.push({ projectId: req.projectId, resolve, reject }); })),
  },
}));
vi.mock('@renderer/hooks/useToasts', () => ({ toast: vi.fn() }));

const { TasksPanel, TaskGroups } = await import('@renderer/components/TasksPanel');
const { groupTasks } = await import('@renderer/tasks-view');

const t = (source: TaskDef['source'], name: string, command: string[]): TaskDef => ({ id: `${source}:${name}`, source, name, command });

function render(tasks: TaskDef[], notices: TaskNotice[] = []): string {
  return renderToStaticMarkup(<TaskGroups grouped={groupTasks(tasks)} notices={notices} running={null} onRun={() => undefined} />);
}

describe('TaskGroups', () => {
  it('renders the mise section after compose with title and count', () => {
    const html = render([t('mise', 'a', ['mise', 'run', 'a']), t('mise', 'b', ['mise', 'run', 'b']), t('compose', 'db', ['docker'])]);
    expect(html).toContain(`${TASKS_COPY.sectionTitle.mise} (2)`);
    expect(html.indexOf(TASKS_COPY.sectionTitle.compose)).toBeLessThan(html.indexOf(TASKS_COPY.sectionTitle.mise));
  });

  it('omits the mise section with no mise tasks and no notice', () => {
    const html = render([t('npm', 'dev', ['npm', 'run', 'dev'])]);
    expect(html).toContain(TASKS_COPY.sectionTitle.npm);
    expect(html).not.toContain(TASKS_COPY.sectionTitle.mise);
  });

  it.each<[TaskNoticeKind, string | undefined, string]>([
    ['not-found', undefined, TASKS_COPY.notice['not-found']],
    ['untrusted', undefined, TASKS_COPY.notice.untrusted],
    ['timed-out', undefined, TASKS_COPY.notice['timed-out']],
    ['failed', 'boom', TASKS_COPY.notice.failed('boom')],
    ['unexpected', undefined, TASKS_COPY.notice.unexpected],
  ])('shows the %s notice muted inside the mise area while other groups render', (kind, detail, text) => {
    const html = render([t('npm', 'dev', ['npm', 'run', 'dev'])], [{ source: 'mise', kind, detail }]);
    expect(html).toMatch(new RegExp(`<div class="[^"]*text-\\[--text-muted\\][^"]*">${text}</div>`));
    expect(html.indexOf(TASKS_COPY.sectionTitle.mise)).toBeLessThan(html.indexOf(text));
    expect(html).toContain('>dev<');
  });

  it('uses the full command as the row title', () => {
    const html = render([t('mise', 'build:web', ['mise', 'run', 'build:web'])]);
    expect(html).toContain('title="mise run build:web"');
  });
});

describe('empty-state copy', () => {
  it('names mise tasks', () => {
    expect(TASKS_COPY.empty).toContain('mise tasks');
  });
});

function findGroups(node: ReactNode): ReactElement<{ grouped: Record<string, TaskDef[]>; notices: TaskNotice[] }> | null {
  if (!isValidElement(node)) return null;
  if (node.type === TaskGroups) return node as ReactElement<{ grouped: Record<string, TaskDef[]>; notices: TaskNotice[] }>;
  const kids = (node.props as { children?: ReactNode }).children;
  for (const k of Array.isArray(kids) ? kids : [kids]) {
    const hit = findGroups(k);
    if (hit) return hit;
  }
  return null;
}

const found = (name: string): TasksDiscovery => ({
  tasks: [t('mise', name, ['mise', 'run', name])],
  notices: [{ source: 'mise', kind: 'untrusted' }],
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const call = (i: number): Call => {
  const c = calls[i];
  if (!c) throw new Error(`no request #${i}`);
  return c;
};

describe('TasksPanel request gate', () => {
  beforeEach(() => { rt.reset(); calls.length = 0; });
  afterEach(() => { rt.unmount(); });

  function mount(initial: number) {
    let projectId = initial;
    const draw = () => findGroups(rt.render(() => TasksPanel({ projectId, onLaunched: () => undefined })));
    draw();
    return {
      rerender(next: number) { projectId = next; return draw(); },
      view: draw,
    };
  }

  it('shows tasks and notices once the current project answers', async () => {
    const h = mount(1);
    call(0).resolve(found('a'));
    await flush();
    const g = h.view();
    expect(g?.props.grouped.mise?.map((x) => x.name)).toEqual(['a']);
    expect(g?.props.notices).toHaveLength(1);
  });

  it('clears tasks and notices on a project change before the new reply', async () => {
    const h = mount(1);
    call(0).resolve(found('a'));
    await flush();
    const g = h.rerender(2);
    expect(g?.props.grouped.mise).toEqual([]);
    expect(g?.props.notices).toEqual([]);
  });

  const markup = (projectId: number) =>
    renderToStaticMarkup(rt.render(() => TasksPanel({ projectId, onLaunched: () => undefined })) as ReactElement);

  it('shows the empty-state copy when no source has tasks and there is no notice (AC18)', async () => {
    markup(1);
    call(0).resolve({ tasks: [], notices: [] });
    await flush();
    expect(markup(1)).toContain(TASKS_COPY.empty);
  });

  it('shows the notice instead of the empty-state copy when only a mise notice came back', async () => {
    markup(1);
    call(0).resolve({ tasks: [], notices: [{ source: 'mise', kind: 'not-found' }] });
    await flush();
    const html = markup(1);
    expect(html).toContain(TASKS_COPY.notice['not-found']);
    expect(html).not.toContain(TASKS_COPY.empty);
  });

  it('ignores a late reply from the previous project', async () => {
    const h = mount(1);
    h.rerender(2);
    call(1).resolve(found('two'));
    await flush();
    call(0).resolve(found('one'));
    await flush();
    expect(h.view()?.props.grouped.mise?.map((x) => x.name)).toEqual(['two']);
  });
});
