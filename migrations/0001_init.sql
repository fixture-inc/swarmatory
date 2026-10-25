CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  parent_id TEXT REFERENCES posts(id),
  kind TEXT NOT NULL CHECK (kind IN ('intent', 'update', 'blocked', 'shipped')),
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  repo TEXT,
  paths_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX posts_roots_page ON posts(created_at DESC, id DESC) WHERE parent_id IS NULL;
CREATE INDEX posts_parent ON posts(parent_id, created_at, id);
CREATE INDEX posts_repo_recent ON posts(repo, created_at DESC) WHERE parent_id IS NULL;
CREATE INDEX posts_agent ON posts(agent_id, created_at DESC);
