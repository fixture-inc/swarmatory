import type {
  Agent,
  CheckinReason,
  Lifecycle,
  Post,
  PostKind,
} from "../shared/types";
import {
  canonicalTag,
  findOverlapPage,
  pathsOverlap,
  sameTag,
} from "./overlaps";
import { checkAccess, type AccessEnv } from "./access";
import { handleMcp } from "./mcp";

interface Env extends AccessEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_ORIGIN?: string;
  LEGACY_HOSTS?: string;
}
interface AgentRow {
  id: string;
  name: string;
  handle: string;
  role: string;
  owner: string | null;
  runtime: string | null;
  task: string | null;
  thread_url: string | null;
  repo: string | null;
  paths_json: string;
  tags_json: string;
  following_agent_ids_json: string;
  watched_repos_json: string;
  watched_tags_json: string;
  lifecycle: Lifecycle;
  last_seen_at: string;
}
interface PostRow {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_handle: string;
  kind: PostKind;
  channel: string;
  body: string;
  repo: string | null;
  paths_json: string;
  tags_json: string;
  parent_id: string | null;
  reply_to_id: string | null;
  quoted_id: string | null;
  quoted_agent_id: string | null;
  quoted_agent_name: string | null;
  quoted_agent_handle: string | null;
  quoted_body: string | null;
  quoted_created_at: string | null;
  quoted_parent_id: string | null;
  created_at: string;
  reply_count: number;
  mention_agent_ids_json: string;
  seq?: number;
}
const postSelect = `SELECT p.*, a.name AS agent_name, a.handle AS agent_handle,
  (SELECT COUNT(*) FROM posts r WHERE r.reply_to_id = p.id OR
    (r.reply_to_id IS NULL AND r.parent_id = p.id)) AS reply_count,
  q.id AS quoted_id, q.agent_id AS quoted_agent_id, qa.name AS quoted_agent_name,
  qa.handle AS quoted_agent_handle, q.body AS quoted_body,
  q.created_at AS quoted_created_at, q.parent_id AS quoted_parent_id
  FROM posts p JOIN agents a ON a.id = p.agent_id
  LEFT JOIN posts q ON q.id = COALESCE(p.reply_to_id, p.parent_id)
  LEFT JOIN agents qa ON qa.id = q.agent_id`;
const kinds: PostKind[] = ["intent", "update", "blocked", "shipped"];
const lifecycles: Lifecycle[] = ["working", "waiting", "paused", "completed"];
const botNames = [
  "Atlas",
  "Nova",
  "Orbit",
  "Pixel",
  "Relay",
  "Sentry",
  "Cipher",
  "Mosaic",
  "Comet",
  "Vector",
  "Echo",
  "Scout",
];
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}
async function payload(request: Request): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Expected application/json.",
    );
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 32768) {
    void request.body?.cancel().catch(() => {});
    throw new ApiError(413, "payload_too_large", "Request body exceeds 32 KB.");
  }
  // Count incoming bytes before decoding, including unknown-length bodies.
  const bytes = new Uint8Array(32768);
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (size + value.byteLength > bytes.byteLength) {
          // Cancellation must not delay rejection if a source stalls in cancel().
          void reader.cancel().catch(() => {});
          throw new ApiError(
            413,
            "payload_too_large",
            "Request body exceeds 32 KB.",
          );
        }
        bytes.set(value, size);
        size += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  // Decode once so multibyte UTF-8 characters split across chunks stay intact.
  const body = new TextDecoder().decode(bytes.subarray(0, size));
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ApiError(400, "invalid_json", "Expected a JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(400, "invalid_json", "Expected a JSON object.");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ApiError(
      400,
      "invalid_field",
      `${name} must be a nonempty string of at most ${max} characters.`,
    );
  return value.trim();
}
function optionalString(
  value: unknown,
  name: string,
  max: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, name, max);
}
function boundedArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems)
    throw new ApiError(
      400,
      "invalid_field",
      `${name} must contain at most ${maxItems} strings.`,
    );
  return [
    ...new Set(
      value.map((item, index) =>
        requiredString(item, `${name}[${index}]`, maxLength),
      ),
    ),
  ];
}
function normalizedTag(value: string, name: string): string {
  const tag = canonicalTag(value);
  if (!tag)
    throw new ApiError(400, "invalid_field", `${name} must be a nonempty tag.`);
  return tag;
}
function postTags(value: unknown): string[] {
  return [
    ...new Set(
      boundedArray(value, "tags", 12, 40).map((tag, index) =>
        normalizedTag(tag, `tags[${index}]`),
      ),
    ),
  ];
}
function threadUrl(value: unknown): string | null {
  const raw = optionalString(value, "threadUrl", 1000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (["https:", "http:"].includes(url.protocol) && url.hostname) return raw;
    if (url.protocol === "codex:" && url.pathname && !/[\s<>]/.test(raw))
      return raw;
  } catch {
    /* invalid URL */
  }
  throw new ApiError(
    400,
    "invalid_field",
    "threadUrl must be an HTTP(S) or codex:// link.",
  );
}
function handleValue(value: unknown): string {
  const handle = requiredString(value, "handle", 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle))
    throw new ApiError(
      400,
      "invalid_field",
      "handle must use lowercase letters, numbers, and hyphens.",
    );
  return handle;
}
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 35) || "agent"
  );
}
function fromAgent(row: AgentRow, now = Date.now()): Agent {
  const age = now - Date.parse(row.last_seen_at);
  const presence =
    row.lifecycle === "completed" || age >= 300000 ? "quiet" : "active";
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    role: row.role,
    owner: row.owner,
    runtime: row.runtime,
    task: row.task,
    threadUrl: row.thread_url,
    lastSeenAt: row.last_seen_at,
    status:
      row.lifecycle === "completed"
        ? "offline"
        : age < 300000
          ? "active"
          : age < 1800000
            ? "idle"
            : "offline",
    presence,
    lifecycle: row.lifecycle,
    repo: row.repo,
    paths: JSON.parse(row.paths_json),
    tags: JSON.parse(row.tags_json),
    followingAgentIds: JSON.parse(row.following_agent_ids_json),
    watchedRepos: JSON.parse(row.watched_repos_json),
    watchedTags: JSON.parse(row.watched_tags_json),
  };
}
function fromPost(row: PostRow): Post {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentHandle: row.agent_handle,
    kind: row.kind,
    channel: row.channel,
    body: row.body,
    repo: row.repo,
    paths: JSON.parse(row.paths_json),
    tags: JSON.parse(row.tags_json),
    parentId: row.parent_id,
    replyToId: row.reply_to_id ?? row.parent_id,
    quotedPost: row.quoted_id
      ? {
          id: row.quoted_id,
          agentId: row.quoted_agent_id!,
          agentName: row.quoted_agent_name!,
          agentHandle: row.quoted_agent_handle!,
          body: row.quoted_body!,
          createdAt: row.quoted_created_at!,
          parentId: row.quoted_parent_id,
        }
      : null,
    createdAt: row.created_at,
    replyCount: row.reply_count,
    mentionAgentIds: JSON.parse(row.mention_agent_ids_json),
  };
}
function encodeCursor(post: Post): string {
  return btoa(JSON.stringify([post.createdAt, post.id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decodeCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(
      atob(cursor.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value[0]) &&
      typeof value[1] === "string" &&
      /^[0-9a-f-]{36}$/.test(value[1])
    )
      return value as [string, string];
  } catch {
    /* invalid */
  }
  throw new ApiError(400, "invalid_cursor", "Invalid pagination cursor.");
}
function decimalCursor(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,14})$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new ApiError(
      400,
      "invalid_cursor",
      "cursor must be a decimal sequence.",
    );
  return Number(value);
}
async function agentRow(db: D1Database, id: string): Promise<AgentRow> {
  const row = await db
    .prepare("SELECT * FROM agents WHERE id = ?")
    .bind(id)
    .first<AgentRow>();
  if (!row) throw new ApiError(404, "agent_not_found", "Agent not found.");
  return row;
}
async function getPost(db: D1Database, id: string): Promise<PostRow> {
  const row = await db
    .prepare(`${postSelect} WHERE p.id = ?`)
    .bind(id)
    .first<PostRow>();
  if (!row) throw new ApiError(404, "post_not_found", "Post not found.");
  return row;
}
const archiveAge = 7 * 86400000;
function recentCutoff(): string {
  return new Date(Date.now() - archiveAge).toISOString();
}
function agentCursor(agent: Agent): string {
  return btoa(JSON.stringify([agent.lastSeenAt, agent.id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decodeAgentCursor(cursor: string): [string, string] {
  try {
    if (cursor.length > 256) throw new Error("oversized cursor");
    const value: unknown = JSON.parse(
      atob(cursor.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value[0]) &&
      Number.isFinite(Date.parse(value[0])) &&
      typeof value[1] === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value[1])
    )
      return value as [string, string];
  } catch {
    /* invalid */
  }
  throw new ApiError(400, "invalid_cursor", "Invalid agent pagination cursor.");
}
async function agentDirectory(
  db: D1Database,
  params: URLSearchParams,
): Promise<Response> {
  const scope = params.get("scope") ?? "recent";
  if (!["recent", "archived", "all"].includes(scope))
    throw new ApiError(
      400,
      "invalid_field",
      "scope must be recent, archived, or all.",
    );
  const limit = params.has("limit") ? Number(params.get("limit")) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError(
      400,
      "invalid_field",
      "limit must be an integer from 1 to 100.",
    );
  const search = (params.get("search") ?? "").trim();
  if (search.length > 120)
    throw new ApiError(
      400,
      "invalid_field",
      "search must be at most 120 characters.",
    );
  const filters: string[] = [];
  const bindings: unknown[] = [];
  if (scope !== "all") {
    filters.push(
      scope === "recent"
        ? "(lifecycle!='completed' AND last_seen_at>?)"
        : "(lifecycle='completed' OR last_seen_at<=?)",
    );
    bindings.push(recentCutoff());
  }
  if (search) {
    // Quote each word so punctuation and FTS operators remain ordinary input.
    const tokens = search.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length) {
      filters.push(
        "rowid IN (SELECT rowid FROM agent_search WHERE agent_search MATCH ?)",
      );
      bindings.push(tokens.map((token) => `"${token}"*`).join(" AND "));
    } else filters.push("0");
  }
  if (params.has("before")) {
    const [seen, id] = decodeAgentCursor(params.get("before")!);
    filters.push("(last_seen_at<? OR (last_seen_at=? AND id<?))");
    bindings.push(seen, seen, id);
  }
  const rows = await db
    .prepare(
      `SELECT * FROM agents${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY last_seen_at DESC, id DESC LIMIT ?`,
    )
    .bind(...bindings, limit + 1)
    .all<AgentRow>();
  const agents = rows.results.slice(0, limit).map((row) => fromAgent(row));
  return json({
    agents,
    nextCursor:
      rows.results.length > limit ? agentCursor(agents.at(-1)!) : null,
  });
}

// Match legacy mixed-case/prefixed tags without materializing the agent directory.
const normalizedSqlTag = (value: string) =>
  `lower(trim(CASE WHEN substr(trim(${value}),1,1)='#' THEN substr(trim(${value}),2) ELSE trim(${value}) END))`;
function scopeCandidates(agent: Agent): { sql: string; bindings: unknown[] } {
  return {
    sql: `(a.id IN (SELECT value FROM json_each(?)) OR a.repo IN (SELECT value FROM json_each(?)) OR a.repo=? OR
      EXISTS (SELECT 1 FROM json_each(a.tags_json) t JOIN json_each(?) watched ON ${normalizedSqlTag("t.value")}=${normalizedSqlTag("watched.value")}))`,
    bindings: [
      JSON.stringify(agent.followingAgentIds),
      JSON.stringify(agent.watchedRepos),
      agent.repo,
      JSON.stringify([...agent.tags, ...agent.watchedTags]),
    ],
  };
}
function validLifecycle(value: unknown): Lifecycle {
  if (typeof value !== "string" || !lifecycles.includes(value as Lifecycle))
    throw new ApiError(400, "invalid_field", "Invalid lifecycle.");
  return value as Lifecycle;
}
function scope(
  body: Record<string, unknown>,
  previous?: AgentRow,
): { repo: string | null; paths: string[]; tags: string[] } {
  return {
    repo:
      body.repo === undefined
        ? (previous?.repo ?? null)
        : optionalString(body.repo, "repo", 160),
    paths:
      body.paths === undefined
        ? JSON.parse(previous?.paths_json ?? "[]")
        : boundedArray(body.paths, "paths", 12, 240),
    tags:
      body.tags === undefined
        ? JSON.parse(previous?.tags_json ?? "[]")
        : boundedArray(body.tags, "tags", 12, 40),
  };
}
async function uniqueName(
  db: D1Database,
  name: string,
  id: string,
): Promise<boolean> {
  return !(await db
    .prepare("SELECT id FROM agents WHERE name = ? COLLATE NOCASE AND id != ?")
    .bind(name, id)
    .first());
}
async function uniqueHandle(
  db: D1Database,
  handle: string,
  id: string,
): Promise<boolean> {
  return !(await db
    .prepare(
      "SELECT id FROM agents WHERE handle = ? COLLATE NOCASE AND id != ?",
    )
    .bind(handle, id)
    .first());
}
async function chooseName(db: D1Database, id: string): Promise<string> {
  let hash = 0;
  for (const char of id)
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const base = botNames[hash % botNames.length];
  let name = base;
  let suffix = 2;
  while (!(await uniqueName(db, name, id))) name = `${base} ${suffix++}`;
  return name;
}
async function chooseHandle(
  db: D1Database,
  base: string,
  id: string,
): Promise<string> {
  let handle = slug(base);
  let suffix = 2;
  while (!(await uniqueHandle(db, handle, id)))
    handle = `${slug(base).slice(0, 35)}-${suffix++}`;
  return handle;
}
async function mentions(db: D1Database, body: string): Promise<string[]> {
  const handles = [
    ...new Set(
      [
        ...body.matchAll(
          /(^|[^\w@.])@([A-Za-z0-9][A-Za-z0-9-]{0,39})(?![\w-])/g,
        ),
      ].map((match) => match[2].toLowerCase()),
    ),
  ];
  if (!handles.length) return [];
  const rows = await db
    .prepare(
      `SELECT id, handle FROM agents WHERE handle COLLATE NOCASE IN (${handles.map(() => "?").join(",")})`,
    )
    .bind(...handles)
    .all<{ id: string; handle: string }>();
  return rows.results.map((row) => row.id);
}
function related(a: Agent, b: Agent): boolean {
  return (
    a.followingAgentIds.includes(b.id) ||
    (!!b.repo && a.watchedRepos.includes(b.repo)) ||
    (!!b.repo &&
      a.repo === b.repo &&
      (!a.paths.length ||
        !b.paths.length ||
        a.paths.some((p) => b.paths.some((q) => pathsOverlap(p, q))))) ||
    a.tags.some((tag) => b.tags.some((other) => sameTag(tag, other))) ||
    b.tags.some((tag) => a.watchedTags.some((watched) => sameTag(tag, watched)))
  );
}
function relevance(
  agent: Agent,
  post: Post,
  repliedRoots: Set<string>,
): CheckinReason[] {
  if (post.agentId === agent.id) return [];
  const reasons: CheckinReason[] = [];
  if (post.parentId && repliedRoots.has(post.parentId)) reasons.push("reply");
  if (post.mentionAgentIds.includes(agent.id)) reasons.push("mention");
  if (agent.followingAgentIds.includes(post.agentId)) reasons.push("follow");
  if (post.repo && agent.watchedRepos.includes(post.repo)) reasons.push("repo");
  if (
    post.tags.some((tag) =>
      agent.watchedTags.some((watched) => sameTag(tag, watched)),
    )
  )
    reasons.push("tag");
  return reasons;
}
async function recentRoots(
  db: D1Database,
  candidate?: { sql: string; bindings: unknown[] },
): Promise<Post[]> {
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  const rows = await db
    .prepare(
      `${postSelect} WHERE p.parent_id IS NULL AND p.created_at >= ?
       AND a.lifecycle IN ('working','waiting') AND a.last_seen_at>?
       ${candidate ? `AND (${candidate.sql})` : ""}
       ORDER BY p.created_at DESC, p.id DESC LIMIT 500`,
    )
    .bind(cutoff, recentCutoff(), ...(candidate?.bindings ?? []))
    .all<PostRow>();
  return rows.results.map(fromPost);
}
function dbConflict(cause: unknown): never {
  if (String(cause).includes("name_taken"))
    throw new ApiError(409, "name_taken", "Display name is already in use.");
  if (String(cause).includes("UNIQUE constraint failed"))
    throw new ApiError(409, "conflict", "Name or handle is already in use.");
  throw cause;
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const db = env.DB,
    path = url.pathname,
    method = request.method;
  if (path === "/api/agents" && method === "GET")
    return agentDirectory(db, url.searchParams);
  if (path === "/api/agents" && method === "POST") {
    const body = await payload(request);
    const id = requiredString(body.id, "id", 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
      throw new ApiError(
        400,
        "invalid_field",
        "id must contain letters, numbers, hyphens, or underscores.",
      );
    const existing = await db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .bind(id)
      .first<AgentRow>();
    const name =
      body.name === undefined
        ? (existing?.name ?? (await chooseName(db, id)))
        : requiredString(body.name, "name", 80);
    if (
      (!existing || name.toLowerCase() !== existing.name.toLowerCase()) &&
      !(await uniqueName(db, name, id))
    )
      throw new ApiError(409, "name_taken", "Display name is already in use.");
    const proposedHandle =
      body.handle === undefined ? undefined : handleValue(body.handle);
    if (existing && proposedHandle && proposedHandle !== existing.handle)
      throw new ApiError(
        409,
        "handle_immutable",
        "Agent handle cannot change.",
      );
    const handle =
      existing?.handle ?? proposedHandle ?? (await chooseHandle(db, name, id));
    if (!(await uniqueHandle(db, handle, id)))
      throw new ApiError(409, "handle_taken", "Handle is already in use.");
    const role =
      body.role === undefined
        ? (existing?.role ?? "Coding agent")
        : requiredString(body.role, "role", 120);
    const owner =
      body.owner === undefined
        ? (existing?.owner ?? null)
        : optionalString(body.owner, "owner", 120);
    const runtime =
      body.runtime === undefined
        ? (existing?.runtime ?? null)
        : optionalString(body.runtime, "runtime", 120);
    const task =
      body.task === undefined
        ? (existing?.task ?? null)
        : optionalString(body.task, "task", 500);
    const link =
      body.threadUrl === undefined
        ? (existing?.thread_url ?? null)
        : threadUrl(body.threadUrl);
    const s = scope(body, existing ?? undefined);
    const now = new Date().toISOString();
    try {
      await db
        .prepare(
          `INSERT INTO agents (id,name,handle,role,owner,runtime,task,thread_url,repo,paths_json,tags_json,last_seen_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,owner=excluded.owner,runtime=excluded.runtime,task=excluded.task,thread_url=excluded.thread_url,repo=excluded.repo,paths_json=excluded.paths_json,tags_json=excluded.tags_json,last_seen_at=CASE WHEN agents.lifecycle='completed' THEN agents.last_seen_at ELSE excluded.last_seen_at END`,
        )
        .bind(
          id,
          name,
          handle,
          role,
          owner,
          runtime,
          task,
          link,
          s.repo,
          JSON.stringify(s.paths),
          JSON.stringify(s.tags),
          now,
          now,
        )
        .run();
    } catch (cause) {
      dbConflict(cause);
    }
    return json({ agent: fromAgent(await agentRow(db, id)) });
  }
  const byHandle = /^\/api\/agents\/by-handle\/([^/]+)$/.exec(path);
  if (byHandle && method === "GET") {
    const handle = handleValue(decodeURIComponent(byHandle[1]));
    const row = await db
      .prepare("SELECT * FROM agents WHERE handle = ? COLLATE NOCASE")
      .bind(handle)
      .first<AgentRow>();
    if (!row) throw new ApiError(404, "agent_not_found", "Agent not found.");
    return json({ agent: fromAgent(row) });
  }
  const agentRoute = /^\/api\/agents\/([^/]+)$/.exec(path);
  if (agentRoute && method === "GET")
    return json({
      agent: fromAgent(await agentRow(db, decodeURIComponent(agentRoute[1]))),
    });
  if (agentRoute && method === "PATCH") {
    const id = decodeURIComponent(agentRoute[1]);
    const existing = await agentRow(db, id);
    const body = await payload(request);
    if (body.handle !== undefined || body.id !== undefined)
      throw new ApiError(
        400,
        "invalid_field",
        "Agent ID and handle cannot change.",
      );
    const name =
      body.name === undefined
        ? existing.name
        : requiredString(body.name, "name", 80);
    if (
      name.toLowerCase() !== existing.name.toLowerCase() &&
      !(await uniqueName(db, name, id))
    )
      throw new ApiError(409, "name_taken", "Display name is already in use.");
    const role =
      body.role === undefined
        ? existing.role
        : requiredString(body.role, "role", 120);
    const owner =
      body.owner === undefined
        ? existing.owner
        : optionalString(body.owner, "owner", 120);
    const runtime =
      body.runtime === undefined
        ? existing.runtime
        : optionalString(body.runtime, "runtime", 120);
    const task =
      body.task === undefined
        ? existing.task
        : optionalString(body.task, "task", 500);
    const link =
      body.threadUrl === undefined
        ? existing.thread_url
        : threadUrl(body.threadUrl);
    const s = scope(body, existing);
    const lifecycle =
      body.lifecycle === undefined
        ? existing.lifecycle
        : validLifecycle(body.lifecycle);
    const changed = lifecycle !== existing.lifecycle;
    const now = new Date().toISOString();
    const updates = db
      .prepare(
        "UPDATE agents SET name=?,role=?,owner=?,runtime=?,task=?,thread_url=?,repo=?,paths_json=?,tags_json=?,lifecycle=?,last_seen_at=coalesce(?,last_seen_at) WHERE id=?",
      )
      .bind(
        name,
        role,
        owner,
        runtime,
        task,
        link,
        s.repo,
        JSON.stringify(s.paths),
        JSON.stringify(s.tags),
        lifecycle,
        body.lifecycle === "working" ? now : null,
        id,
      );
    try {
      if (changed && body.summary !== undefined) {
        const summary = requiredString(body.summary, "summary", 8000);
        const mentionIds = await mentions(db, summary);
        const post = db
          .prepare(
            `INSERT INTO posts (id,agent_id,parent_id,kind,channel,body,repo,paths_json,tags_json,created_at,mention_agent_ids_json)
          VALUES (?,?,NULL,?,'general',?,?,?,?,?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            lifecycle === "completed" ? "shipped" : "update",
            summary,
            s.repo,
            JSON.stringify(s.paths),
            JSON.stringify(s.tags),
            now,
            JSON.stringify(mentionIds),
          );
        await db.batch([updates, post]);
      } else await updates.run();
    } catch (cause) {
      dbConflict(cause);
    }
    return json({ agent: fromAgent(await agentRow(db, id)) });
  }
  const heartbeat = /^\/api\/agents\/([^/]+)\/heartbeat$/.exec(path);
  if (heartbeat && method === "POST") {
    const id = decodeURIComponent(heartbeat[1]);
    await agentRow(db, id);
    await db
      .prepare(
        "UPDATE agents SET last_seen_at=? WHERE id=? AND lifecycle!='completed'",
      )
      .bind(new Date().toISOString(), id)
      .run();
    return json({ agent: fromAgent(await agentRow(db, id)) });
  }
  const subscriptions = /^\/api\/agents\/([^/]+)\/subscriptions$/.exec(path);
  if (subscriptions && method === "PUT") {
    const id = decodeURIComponent(subscriptions[1]);
    await agentRow(db, id);
    const body = await payload(request);
    const following = boundedArray(
      body.followingAgentIds,
      "followingAgentIds",
      50,
      64,
    );
    const repos = boundedArray(body.watchedRepos, "watchedRepos", 50, 160);
    const tags = boundedArray(body.watchedTags, "watchedTags", 50, 40);
    if (following.includes(id))
      throw new ApiError(
        400,
        "invalid_field",
        "An agent cannot follow itself.",
      );
    if (following.length) {
      const rows = await db
        .prepare(
          `SELECT id FROM agents WHERE id IN (${following.map(() => "?").join(",")})`,
        )
        .bind(...following)
        .all<{ id: string }>();
      if (rows.results.length !== following.length)
        throw new ApiError(400, "invalid_field", "Unknown followed agent.");
    }
    await db
      .prepare(
        "UPDATE agents SET following_agent_ids_json=?,watched_repos_json=?,watched_tags_json=? WHERE id=?",
      )
      .bind(
        JSON.stringify(following),
        JSON.stringify(repos),
        JSON.stringify(tags),
        id,
      )
      .run();
    return json({ agent: fromAgent(await agentRow(db, id)) });
  }
  const checkin = /^\/api\/agents\/([^/]+)\/checkin$/.exec(path);
  if (checkin && method === "POST") {
    const id = decodeURIComponent(checkin[1]);
    await agentRow(db, id);
    const body = await payload(request);
    const cursor = decimalCursor(body.cursor);
    const limit = body.limit === undefined ? 50 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(
        400,
        "invalid_field",
        "limit must be an integer from 1 to 100.",
      );
    await db
      .prepare(
        "UPDATE agents SET last_seen_at=? WHERE id=? AND lifecycle!='completed'",
      )
      .bind(new Date().toISOString(), id)
      .run();
    const agent = fromAgent(await agentRow(db, id));
    const rows = await db
      .prepare(
        `${postSelect.replace("SELECT p.*", "SELECT e.seq AS seq, p.*")} JOIN post_events e ON e.post_id=p.id WHERE e.seq>? ORDER BY e.seq ASC LIMIT ?`,
      )
      .bind(cursor, limit + 1)
      .all<PostRow>();
    const scanned = rows.results.slice(0, limit);
    const replyRoots = [
      ...new Set(
        scanned.flatMap((row) => (row.parent_id ? [row.parent_id] : [])),
      ),
    ];
    const participated = replyRoots.length
      ? await db
          .prepare(
            `SELECT candidate.value AS root_id FROM json_each(?) candidate WHERE
         EXISTS (SELECT 1 FROM posts root WHERE root.id=candidate.value AND root.agent_id=?) OR
         EXISTS (SELECT 1 FROM posts reply WHERE reply.parent_id=candidate.value AND reply.agent_id=?)`,
          )
          .bind(JSON.stringify(replyRoots), id, id)
          .all<{ root_id: string }>()
      : { results: [] };
    const roots = new Set(participated.results.map((row) => row.root_id));
    const items = scanned
      .map((row) => {
        const post = fromPost(row);
        return { post, reasons: relevance(agent, post, roots) };
      })
      .filter((item) => item.reasons.length);
    const overlapPage = findOverlapPage(await recentRoots(db), Date.now(), {
      agentId: id,
    });
    return json({
      agent,
      items,
      overlaps: overlapPage.overlaps,
      overlapsTruncated: overlapPage.truncated,
      nextCursor: String(scanned.at(-1)?.seq ?? cursor),
      hasMore: rows.results.length > limit,
    });
  }
  if (path === "/api/discover" && method === "GET") {
    const id = requiredString(url.searchParams.get("agentId"), "agentId", 64);
    const agent = fromAgent(await agentRow(db, id));
    const candidates = scopeCandidates(agent);
    const rows = await db
      .prepare(
        `SELECT a.* FROM agents a WHERE a.id!=?
      AND a.lifecycle IN ('working','waiting') AND a.last_seen_at>?
      AND ${candidates.sql} ORDER BY a.last_seen_at DESC,a.id DESC LIMIT 500`,
      )
      .bind(
        id,
        new Date(Date.now() - 300000).toISOString(),
        ...candidates.bindings,
      )
      .all<AgentRow>();
    const agents = rows.results
      .map((row) => fromAgent(row))
      .filter(
        (other) =>
          other.id !== id &&
          (other.lifecycle === "working" || other.lifecycle === "waiting") &&
          other.presence === "active" &&
          related(agent, other),
      );
    const ids = new Set(agents.map((other) => other.id));
    const roots = await recentRoots(db, {
      sql: `p.agent_id!=? AND (a.id IN (SELECT value FROM json_each(?)) OR
        a.id IN (SELECT value FROM json_each(?)) OR p.repo IN (SELECT value FROM json_each(?)) OR
        EXISTS (SELECT 1 FROM json_each(p.tags_json) t JOIN json_each(?) watched ON ${normalizedSqlTag("t.value")}=${normalizedSqlTag("watched.value")}) OR
        EXISTS (SELECT 1 FROM json_each(p.mention_agent_ids_json) m WHERE m.value=?))`,
      bindings: [
        id,
        JSON.stringify([...ids]),
        JSON.stringify(agent.followingAgentIds),
        JSON.stringify(agent.watchedRepos),
        JSON.stringify(agent.watchedTags),
        id,
      ],
    });
    const posts = roots
      .filter(
        (post) =>
          post.agentId !== id &&
          (ids.has(post.agentId) ||
            relevance(agent, post, new Set()).length > 0),
      )
      .slice(0, 50);
    return json({ agents, posts });
  }
  if (path === "/api/posts" && method === "GET") {
    const search = optionalString(
      url.searchParams.get("search"),
      "search",
      120,
    );
    const channel = optionalString(
      url.searchParams.get("channel"),
      "channel",
      40,
    );
    const kind = optionalString(url.searchParams.get("kind"), "kind", 20);
    const agentId = optionalString(
      url.searchParams.get("agentId"),
      "agentId",
      64,
    );
    const tag = optionalString(url.searchParams.get("tag"), "tag", 40);
    const mentionAgentId = optionalString(
      url.searchParams.get("mentionAgentId"),
      "mentionAgentId",
      64,
    );
    if (kind && !kinds.includes(kind as PostKind))
      throw new ApiError(400, "invalid_field", "Invalid post kind.");
    if (mentionAgentId) await agentRow(db, mentionAgentId);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(
        400,
        "invalid_field",
        "limit must be an integer from 1 to 100.",
      );
    const filters: string[] = [];
    const bindings: unknown[] = [];
    if (search) {
      const fields = [
        "p.body",
        "a.name",
        "a.handle",
        "p.repo",
        "p.paths_json",
        "p.tags_json",
      ];
      filters.push(
        `(${fields.map((field) => `${field} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
      );
      const term = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      bindings.push(...fields.map(() => term));
    }
    if (channel) {
      filters.push("p.channel=?");
      bindings.push(channel);
    }
    if (kind) {
      filters.push("p.kind=?");
      bindings.push(kind);
    }
    if (agentId) {
      filters.push("p.agent_id=?");
      bindings.push(agentId);
    }
    if (tag) {
      filters.push(
        "EXISTS (SELECT 1 FROM json_each(p.tags_json) WHERE lower(value)=?)",
      );
      bindings.push(normalizedTag(tag, "tag"));
    }
    if (mentionAgentId) {
      filters.push(
        "EXISTS (SELECT 1 FROM json_each(p.mention_agent_ids_json) WHERE value=?)",
      );
      bindings.push(mentionAgentId);
    }
    const before = url.searchParams.get("before");
    if (before) {
      const [date, id] = decodeCursor(before);
      filters.push("(p.created_at<? OR (p.created_at=? AND p.id<?))");
      bindings.push(date, date, id);
    }
    const rows = await db
      .prepare(
        `${postSelect}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY p.created_at DESC,p.id DESC LIMIT ?`,
      )
      .bind(...bindings, limit + 1)
      .all<PostRow>();
    const page = rows.results.slice(0, limit).map(fromPost);
    return json({
      posts: page,
      nextCursor:
        rows.results.length > limit
          ? encodeCursor(page[page.length - 1])
          : null,
    });
  }
  if (path === "/api/posts" && method === "POST") {
    const body = await payload(request);
    const agentId = requiredString(body.agentId, "agentId", 64);
    const postingAgent = await agentRow(db, agentId);
    if (postingAgent.lifecycle === "completed")
      throw new ApiError(
        409,
        "agent_completed",
        "Resume the agent before posting.",
      );
    const kind = (
      body.kind === undefined ? "update" : requiredString(body.kind, "kind", 20)
    ) as PostKind;
    if (!kinds.includes(kind))
      throw new ApiError(400, "invalid_field", "Invalid post kind.");
    const channel =
      body.channel === undefined
        ? "general"
        : requiredString(body.channel, "channel", 40);
    const content = requiredString(body.body, "body", 8000);
    const repo = optionalString(body.repo, "repo", 160);
    const paths = boundedArray(body.paths, "paths", 12, 240);
    const tags = postTags(body.tags);
    const id = crypto.randomUUID(),
      now = new Date().toISOString(),
      mentionIds = await mentions(db, content);
    await db.batch([
      db
        .prepare(
          `INSERT INTO posts (id,agent_id,parent_id,kind,channel,body,repo,paths_json,tags_json,created_at,mention_agent_ids_json) VALUES (?,?,NULL,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          id,
          agentId,
          kind,
          channel,
          content,
          repo,
          JSON.stringify(paths),
          JSON.stringify(tags),
          now,
          JSON.stringify(mentionIds),
        ),
      db
        .prepare(
          "UPDATE agents SET last_seen_at=? WHERE id=? AND lifecycle!='completed'",
        )
        .bind(now, agentId),
    ]);
    return json({ post: fromPost(await getPost(db, id)) }, 201);
  }
  const postMatch = /^\/api\/posts\/([^/]+)$/.exec(path);
  if (postMatch && method === "GET") {
    const id = decodeURIComponent(postMatch[1]);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(
        400,
        "invalid_field",
        "limit must be an integer from 1 to 100.",
      );
    const after = url.searchParams.get("after");
    const cursor = after === null ? null : decodeCursor(after);
    const post = fromPost(await getPost(db, id));
    const rootPost = post.parentId
      ? fromPost(await getPost(db, post.parentId))
      : post;
    const rows = await db
      .prepare(
        `${postSelect} WHERE p.parent_id=?${cursor ? " AND (p.created_at>? OR (p.created_at=? AND p.id>?))" : ""} ORDER BY p.created_at ASC,p.id ASC LIMIT ?`,
      )
      .bind(
        rootPost.id,
        ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []),
        limit + 1,
      )
      .all<PostRow>();
    const replies = rows.results.slice(0, limit).map(fromPost);
    return json({
      post,
      rootPost,
      replies,
      nextCursor:
        rows.results.length > limit
          ? encodeCursor(replies[replies.length - 1])
          : null,
    });
  }
  const replies = /^\/api\/posts\/([^/]+)\/replies$/.exec(path);
  if (replies && method === "POST") {
    const parentId = decodeURIComponent(replies[1]);
    const parent = await getPost(db, parentId);
    const body = await payload(request);
    const agentId = requiredString(body.agentId, "agentId", 64);
    const postingAgent = await agentRow(db, agentId);
    if (postingAgent.lifecycle === "completed")
      throw new ApiError(
        409,
        "agent_completed",
        "Resume the agent before posting.",
      );
    const content = requiredString(body.body, "body", 8000),
      now = new Date().toISOString(),
      id = crypto.randomUUID(),
      mentionIds = await mentions(db, content);
    await db.batch([
      db
        .prepare(
          `INSERT INTO posts (id,agent_id,parent_id,reply_to_id,kind,channel,body,repo,paths_json,tags_json,created_at,mention_agent_ids_json) VALUES (?,?,?,?,'update',?,?,?,?,?,?,?)`,
        )
        .bind(
          id,
          agentId,
          parent.parent_id ?? parent.id,
          parent.id,
          parent.channel,
          content,
          parent.repo,
          parent.paths_json,
          parent.tags_json,
          now,
          JSON.stringify(mentionIds),
        ),
      db
        .prepare(
          "UPDATE agents SET last_seen_at=? WHERE id=? AND lifecycle!='completed'",
        )
        .bind(now, agentId),
    ]);
    return json({ post: fromPost(await getPost(db, id)) }, 201);
  }
  if (path === "/api/overlaps" && method === "GET") {
    const page = findOverlapPage(await recentRoots(db));
    return json({ overlaps: page.overlaps, overlapsTruncated: page.truncated });
  }
  throw new ApiError(
    404,
    "not_found",
    path.startsWith("/api/") ? "API route not found." : "Not found.",
  );
}
async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const access = await checkAccess(request, env);
  if (access === "not_configured")
    return error(503, "not_configured", "Cloudflare Access is not configured.");
  if (access === "unauthorized")
    return error(
      401,
      "unauthorized",
      "Cloudflare Access authentication required.",
    );
  if (access === "forbidden")
    return error(403, "forbidden", "Cross-origin writes are not allowed.");
  const legacyHosts = env.LEGACY_HOSTS?.split(",").filter(Boolean) || [];
  if (legacyHosts.includes(url.hostname)) {
    let canonical: URL;
    try {
      canonical = new URL(env.PUBLIC_ORIGIN || "");
      if (
        canonical.protocol !== "https:" ||
        canonical.origin !== env.PUBLIC_ORIGIN ||
        canonical.hostname === url.hostname
      )
        throw new Error("Invalid canonical origin");
    } catch {
      return error(
        503,
        "not_configured",
        "Canonical origin is not configured.",
      );
    }
    canonical.pathname = url.pathname;
    canonical.search = url.search;
    return Response.redirect(canonical.href, 308);
  }
  if (
    url.pathname === "/skill.md" &&
    ["GET", "HEAD"].includes(request.method)
  ) {
    const asset = await env.ASSETS.fetch(
      new Request(request.url, { method: "GET", headers: request.headers }),
    );
    if (!asset.ok) return asset;
    // Keep the checked-in skill reusable; serve examples for this instance.
    const body = (await asset.text()).replaceAll(
      "https://swarmatory.example.com",
      url.origin,
    );
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  }
  if (url.pathname === "/mcp")
    return handleMcp(request, (path, method = "GET", body) => {
      const target = new URL(path, url.origin);
      return apiResponse(
        new Request(target, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        env,
        target,
      );
    });
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/"))
    return env.ASSETS.fetch(request);
  return apiResponse(request, env, url);
}
async function apiResponse(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  try {
    return await api(request, env, url);
  } catch (cause) {
    if (cause instanceof ApiError)
      return error(cause.status, cause.code, cause.message);
    return error(500, "internal_error", "An internal error occurred.");
  }
}
export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const response = await routeRequest(request, env);
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
