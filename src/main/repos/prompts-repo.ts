import type { Database } from 'better-sqlite3';

export interface PromptRow {
  id: string;
  projectId: number | null;   // null → global
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
}

interface RawRow {
  id: string;
  project_id: number | null;
  title: string;
  body: string;
  tags_json: string;
  updated_at: string;
}

function decode(r: RawRow): PromptRow {
  let tags: string[] = [];
  try { const parsed = JSON.parse(r.tags_json); if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === 'string'); }
  catch { /* keep empty */ }
  return { id: r.id, projectId: r.project_id, title: r.title, body: r.body, tags, updatedAt: r.updated_at };
}

/**
 * Prompt library repo. Rows without a `project_id` are visible in every
 * project (globals); project-scoped rows only surface when that project is
 * open. Ids are opaque strings so the renderer can mint UUIDs client-side
 * without a round-trip to persist a brand-new row.
 */
export class PromptsRepo {
  constructor(private readonly db: Database) {}

  /** Returns globals ∪ project-scoped for the given project, newest first. */
  list(projectId: number | null): PromptRow[] {
    const rows = projectId != null
      ? this.db.prepare<[number]>('SELECT * FROM prompts WHERE project_id IS NULL OR project_id = ? ORDER BY updated_at DESC').all(projectId) as RawRow[]
      : this.db.prepare('SELECT * FROM prompts WHERE project_id IS NULL ORDER BY updated_at DESC').all() as RawRow[];
    return rows.map(decode);
  }

  upsert(p: Omit<PromptRow, 'updatedAt'>): PromptRow {
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    this.db.prepare(
      'INSERT INTO prompts (id, project_id, title, body, tags_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, body=excluded.body, tags_json=excluded.tags_json, updated_at=excluded.updated_at',
    ).run(p.id, p.projectId, p.title, p.body, JSON.stringify(p.tags ?? []), now);
    return { ...p, updatedAt: now };
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }
}
