-- Search canonical agent metadata without scanning historical profile text.
CREATE VIRTUAL TABLE agent_search USING fts5(
  name, handle, role, owner, runtime, task, repo, paths_json, tags_json,
  content='agents', content_rowid='rowid', prefix='2 3 4'
);

CREATE TRIGGER agents_search_insert AFTER INSERT ON agents BEGIN
  INSERT INTO agent_search(rowid,name,handle,role,owner,runtime,task,repo,paths_json,tags_json)
  VALUES(new.rowid,new.name,new.handle,new.role,new.owner,new.runtime,new.task,new.repo,new.paths_json,new.tags_json);
END;

CREATE TRIGGER agents_search_delete AFTER DELETE ON agents BEGIN
  INSERT INTO agent_search(agent_search,rowid,name,handle,role,owner,runtime,task,repo,paths_json,tags_json)
  VALUES('delete',old.rowid,old.name,old.handle,old.role,old.owner,old.runtime,old.task,old.repo,old.paths_json,old.tags_json);
END;

CREATE TRIGGER agents_search_update
AFTER UPDATE OF name,handle,role,owner,runtime,task,repo,paths_json,tags_json ON agents
WHEN old.name IS NOT new.name OR old.handle IS NOT new.handle OR old.role IS NOT new.role
  OR old.owner IS NOT new.owner OR old.runtime IS NOT new.runtime OR old.task IS NOT new.task
  OR old.repo IS NOT new.repo OR old.paths_json IS NOT new.paths_json OR old.tags_json IS NOT new.tags_json
BEGIN
  INSERT INTO agent_search(agent_search,rowid,name,handle,role,owner,runtime,task,repo,paths_json,tags_json)
  VALUES('delete',old.rowid,old.name,old.handle,old.role,old.owner,old.runtime,old.task,old.repo,old.paths_json,old.tags_json);
  INSERT INTO agent_search(rowid,name,handle,role,owner,runtime,task,repo,paths_json,tags_json)
  VALUES(new.rowid,new.name,new.handle,new.role,new.owner,new.runtime,new.task,new.repo,new.paths_json,new.tags_json);
END;

INSERT INTO agent_search(agent_search) VALUES('rebuild');

-- Each checkin probes only the at-most-100 roots in its current event page.
CREATE INDEX posts_root_participant ON posts(parent_id, agent_id);
