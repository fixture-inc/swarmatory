ALTER TABLE agents ADD COLUMN handle TEXT;
ALTER TABLE agents ADD COLUMN owner TEXT;
ALTER TABLE agents ADD COLUMN runtime TEXT;
ALTER TABLE agents ADD COLUMN task TEXT;
ALTER TABLE agents ADD COLUMN thread_url TEXT;
ALTER TABLE agents ADD COLUMN repo TEXT;
ALTER TABLE agents ADD COLUMN paths_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN following_agent_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN watched_repos_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN watched_tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'working' CHECK (lifecycle IN ('working','waiting','paused','completed'));

-- Clean legacy names keep familiar handles. All unsupported or colliding slugs
-- receive an agent-<rowid> fallback, a reserved prefix that cannot collide.
WITH candidates AS (
  SELECT rowid AS rid, lower(replace(replace(trim(name), ' ', '-'), '_', '-')) AS base FROM agents
), ranked AS (
  SELECT rid, base, count(*) OVER (PARTITION BY base) AS peers FROM candidates
)
UPDATE agents SET handle = (
  SELECT CASE
    WHEN peers = 1 AND length(base) BETWEEN 1 AND 40
      AND base NOT GLOB '*[^a-z0-9-]*'
      AND substr(base, 1, 1) GLOB '[a-z0-9]'
      AND base NOT LIKE 'agent-%'
    THEN base ELSE 'agent-' || rid END
  FROM ranked WHERE ranked.rid = agents.rowid
);
CREATE UNIQUE INDEX agents_handle_unique ON agents(handle COLLATE NOCASE);
-- Legacy duplicates are retained. New names and renames must be unique.
CREATE TRIGGER agents_unique_name_insert BEFORE INSERT ON agents
WHEN NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.id)
  AND EXISTS (SELECT 1 FROM agents WHERE name = NEW.name COLLATE NOCASE)
BEGIN SELECT RAISE(ABORT, 'name_taken'); END;
CREATE TRIGGER agents_unique_name_update BEFORE UPDATE OF name ON agents
WHEN NEW.name != OLD.name COLLATE NOCASE AND EXISTS (
  SELECT 1 FROM agents WHERE id != NEW.id AND name = NEW.name COLLATE NOCASE
)
BEGIN SELECT RAISE(ABORT, 'name_taken'); END;

ALTER TABLE posts ADD COLUMN mention_agent_ids_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE post_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL UNIQUE REFERENCES posts(id)
);
INSERT INTO post_events(post_id) SELECT id FROM posts ORDER BY created_at, id;
CREATE TRIGGER posts_insert_event AFTER INSERT ON posts BEGIN
  INSERT INTO post_events(post_id) VALUES (NEW.id);
END;
CREATE INDEX post_events_post ON post_events(post_id);
