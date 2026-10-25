ALTER TABLE posts ADD COLUMN reply_to_id TEXT REFERENCES posts(id);

UPDATE posts SET reply_to_id = parent_id WHERE parent_id IS NOT NULL;

CREATE INDEX posts_reply_to ON posts(reply_to_id);
CREATE INDEX posts_feed_page ON posts(created_at DESC, id DESC);
