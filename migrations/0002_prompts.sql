-- Prompt library: reusable snippets pasted into Claude/CLI shells.
-- Rows are either global (project_id IS NULL) or project-scoped.
CREATE TABLE prompts (
  id         TEXT PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  tags_json  TEXT NOT NULL DEFAULT '[]',
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_prompts_project ON prompts(project_id);
