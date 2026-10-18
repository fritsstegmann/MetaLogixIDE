/** Pure Tasks panel view logic: filtering (AC17), grouping, and project-keyed discovery. */
import { describe, expect, it } from 'vitest';
import { TASK_SOURCES, type TaskDef } from '@shared/tasks-contract';
import { discoveryFor, filterTasks, groupTasks } from '@renderer/tasks-view';

const t = (source: TaskDef['source'], name: string, description?: string): TaskDef =>
  ({ id: `${source}:${name}`, source, name, command: [name], ...(description ? { description } : {}) });

describe('filterTasks', () => {
  const tasks = [t('mise', 'Build:Web'), t('mise', 'lint', 'Run ESLint'), t('npm', 'dev')];
  it('matches mise tasks by name, case-insensitively', () => {
    expect(filterTasks(tasks, 'build').map((x) => x.id)).toEqual(['mise:Build:Web']);
  });
  it('matches by description, case-insensitively', () => {
    expect(filterTasks(tasks, 'ESLINT').map((x) => x.id)).toEqual(['mise:lint']);
  });
  it('returns everything for a blank query and nothing for a miss', () => {
    expect(filterTasks(tasks, '  ')).toHaveLength(3);
    expect(filterTasks(tasks, 'zzz')).toEqual([]);
  });
});

describe('groupTasks', () => {
  it('has a key for every source, empty when unused', () => {
    expect(Object.keys(groupTasks([]))).toEqual([...TASK_SOURCES]);
    expect(groupTasks([]).mise).toEqual([]);
  });
  it('keeps order within a group and routes by source', () => {
    const g = groupTasks([t('mise', 'b'), t('npm', 'x'), t('mise', 'a')]);
    expect(g.mise.map((x) => x.name)).toEqual(['b', 'a']);
    expect(g.npm.map((x) => x.name)).toEqual(['x']);
  });
});

describe('discoveryFor', () => {
  const state = { projectId: 1, tasks: [t('npm', 'dev')], notices: [{ source: 'mise' as const, kind: 'not-found' as const }] };
  it('returns the stored discovery for its own project', () => {
    expect(discoveryFor(state, 1).tasks).toHaveLength(1);
    expect(discoveryFor(state, 1).notices).toHaveLength(1);
  });
  it('is empty for any other project', () => {
    expect(discoveryFor(state, 2)).toEqual({ tasks: [], notices: [] });
  });
});
