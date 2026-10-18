/**
 * Pure view logic for the Tasks panel: case-insensitive filtering by name or description, grouping by
 * source in TASK_SOURCES order, and the project-keyed discovery state that makes a project change clear
 * tasks and notices at once while a late reply for another project is ignored.
 */
import { TASK_SOURCES, type TaskDef, type TaskNotice, type TaskSource, type TasksDiscovery } from '@shared/tasks-contract';

export function filterTasks(tasks: TaskDef[], query: string): TaskDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q));
}

export function groupTasks(tasks: TaskDef[]): Record<TaskSource, TaskDef[]> {
  const groups = Object.fromEntries(TASK_SOURCES.map((s) => [s, [] as TaskDef[]])) as Record<TaskSource, TaskDef[]>;
  for (const t of tasks) groups[t.source].push(t);
  return groups;
}

/** Discovery result tagged with the project it belongs to. */
export interface ProjectDiscovery {
  projectId: number | null;
  tasks: TaskDef[];
  notices: TaskNotice[];
}

export const NO_DISCOVERY: ProjectDiscovery = { projectId: null, tasks: [], notices: [] };

/** The discovery to show for `projectId`: the stored one only when it belongs to that project. */
export function discoveryFor(state: ProjectDiscovery, projectId: number | null): TasksDiscovery {
  return state.projectId === projectId ? state : { tasks: [], notices: [] };
}
