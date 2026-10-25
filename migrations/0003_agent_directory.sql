-- Stable keyset paging for the historical directory and its default recent scope.
CREATE INDEX agents_directory_page ON agents(last_seen_at DESC, id DESC);
CREATE INDEX agents_directory_recent ON agents(last_seen_at DESC, id DESC)
  WHERE lifecycle != 'completed';
CREATE INDEX agents_scope_recent ON agents(repo, last_seen_at DESC, id DESC)
  WHERE lifecycle IN ('working', 'waiting');
