// @ts-ignore Node built-ins are provided by the test runtime, without Node types in the worker TS config.
import { readFileSync } from "node:fs";
// @ts-ignore Node built-ins are provided by the test runtime, without Node types in the worker TS config.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Checkin, Post } from "../shared/types";
import { handleRequest } from "../worker/index";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0002_agent_activity.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0003_agent_directory.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0004_agent_search.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0005_quote_replies.sql", "utf8"));
  const queries: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          queries.push({ sql, args });
          return {
            first: async () => sqlite.prepare(sql).get(...(args as [])) ?? null,
            all: async () => ({
              results: sqlite.prepare(sql).all(...(args as [])),
            }),
            run: async () => sqlite.prepare(sql).run(...(args as [])),
          };
        },
        all: async () => ({ results: sqlite.prepare(sql).all() }),
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const env = {
    DB: db,
    SWARMATORY_LOCAL_DEV: "true",
    ASSETS: { fetch: async () => new Response("asset") },
  } as unknown as Parameters<typeof handleRequest>[1];
  async function call(path: string, method = "GET", body?: unknown) {
    const response = await handleRequest(
      new Request(`http://localhost/api${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  }
  return { sqlite, call, queries };
}
async function register(
  call: ReturnType<typeof setup>["call"],
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const response = await call("/agents", "POST", {
    id,
    name,
    role: "Engineer",
    ...extra,
  });
  expect(response.status).toBe(200);
  return response.body.agent as Agent;
}
async function publish(
  call: ReturnType<typeof setup>["call"],
  agentId: string,
  body: string,
  extra: Record<string, unknown> = {},
) {
  const response = await call("/posts", "POST", {
    agentId,
    body,
    kind: "update",
    channel: "engineering",
    ...extra,
  });
  expect(response.status).toBe(201);
  return response.body.post as Post;
}

afterEach(() => vi.useRealTimers());

describe("agent directory aging", () => {
  const now = "2026-10-22T12:00:00.000Z";
  function freeze() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  }

  it("pages recent and archived complements with a stable custom-ID cursor and global search", async () => {
    freeze();
    const { call, sqlite } = setup();
    for (const id of ["tie_A", "tie-B", "older", "boundary", "stale", "done"])
      await register(call, id, id, {
        task: id === "stale" ? "Historic billing audit" : null,
      });
    sqlite
      .prepare("UPDATE agents SET last_seen_at=? WHERE id='older'")
      .run("2026-10-21T12:00:00.000Z");
    sqlite
      .prepare("UPDATE agents SET last_seen_at=? WHERE id='boundary'")
      .run("2026-10-15T12:00:00.000Z");
    sqlite
      .prepare("UPDATE agents SET last_seen_at=? WHERE id='stale'")
      .run("2026-10-15T11:59:59.999Z");
    await call("/agents/done", "PATCH", { lifecycle: "completed" });
    const first = await call("/agents?limit=1");
    expect(first.body.agents.map((a: Agent) => a.id)).toEqual(["tie_A"]);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await call(
      `/agents?limit=1&before=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.body.agents.map((a: Agent) => a.id)).toEqual(["tie-B"]);
    const last = await call(
      `/agents?limit=1&before=${encodeURIComponent(second.body.nextCursor)}`,
    );
    expect(last.body.agents.map((a: Agent) => a.id)).toEqual(["older"]);
    expect(last.body.nextCursor).toBeNull();
    expect(
      (await call("/agents?scope=archived")).body.agents.map(
        (a: Agent) => a.id,
      ),
    ).toEqual(["done", "boundary", "stale"]);
    expect((await call("/agents?scope=all")).body.agents).toHaveLength(6);
    expect(
      (
        await call("/agents?scope=all&search=%20%20BILLING%20%20")
      ).body.agents.map((a: Agent) => a.id),
    ).toEqual(["stale"]);
    expect((await call("/agents?search=Historic")).body.agents).toEqual([]);
    expect(
      (await call("/agents?scope=archived&search=tie")).body.agents,
    ).toEqual([]);
    expect((await call("/agents?search=%20%20%20")).status).toBe(200);
    const historical = await call("/agents/stale");
    expect(historical.body.agent.lastSeenAt).toBe("2026-10-15T11:59:59.999Z");
    expect((await call("/agents/by-handle/STALE")).body.agent.id).toBe("stale");
    expect((await call("/agents/by-handle/missing")).status).toBe(404);
    expect((await call("/agents/by-handle/stal")).status).toBe(404);
    expect(
      (await call("/agents?scope=all")).body.agents.find(
        (a: Agent) => a.id === "stale",
      ).lastSeenAt,
    ).toBe(historical.body.agent.lastSeenAt);
  });

  it("bounds default pages at fifty and validates directory input and custom cursors", async () => {
    freeze();
    const { call, sqlite } = setup();
    const insert = sqlite.prepare(
      "INSERT INTO agents(id,name,handle,role,last_seen_at,created_at) VALUES(?,?,?,'Engineer',?,?)",
    );
    for (let i = 0; i < 105; i++) {
      const id = `agent_${String(i).padStart(3, "0")}`;
      insert.run(id, id, id.replace("_", "-"), now, now);
    }
    expect((await call("/agents")).body.agents).toHaveLength(50);
    const large = await call("/agents?limit=100");
    expect(large.body.agents).toHaveLength(100);
    expect(large.body.nextCursor).toBeTruthy();
    const rest = await call(
      `/agents?limit=100&before=${encodeURIComponent(large.body.nextCursor)}`,
    );
    expect(rest.body.agents).toHaveLength(5);
    expect(rest.body.nextCursor).toBeNull();
    for (const query of [
      "scope=unknown",
      "limit=0",
      "limit=101",
      "limit=1.5",
      "limit=",
      `search=${"x".repeat(121)}`,
      "before=",
      "before=bad",
      `before=${btoa(JSON.stringify([now, "bad/id"]))}`,
      `before=${btoa(JSON.stringify([now, "a".repeat(65)]))}`,
      `before=${btoa(JSON.stringify(["invalid", "a"]))}`,
    ])
      expect((await call(`/agents?${query}`)).status, query).toBe(400);
  });

  it("indexes token prefixes across names, handles, and context and keeps metadata changes current", async () => {
    freeze();
    const { call, sqlite } = setup();
    await register(call, "marnie", "Marnie Vale", {
      owner: "Quin Hoxie",
      runtime: "GPT-6.1",
      task: "Reconcile billing ledger",
      repo: "acme/platform",
      paths: ["src/security"],
      tags: ["launch"],
    });
    const ids = async (search: string, scope = "all") => {
      const result = await call(
        `/agents?scope=${scope}&search=${encodeURIComponent(search)}`,
      );
      expect(result.status).toBe(200);
      return result.body.agents.map((agent: Agent) => agent.id);
    };
    for (const search of [
      "val",
      "MARN VA",
      "hox",
      "gpt-6.1",
      "rec bill",
      "plat",
      "secur",
      "laun",
      "marnie-vale",
    ])
      expect(await ids(search), search).toEqual(["marnie"]);
    for (const search of [
      "arnie",
      '" OR *',
      "***",
      "name:missing",
      "marnie NOT unknown",
    ])
      expect(await ids(search), search).toEqual([]);
    const changes = () =>
      (sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    let before = changes();
    await call("/agents/marnie/heartbeat", "POST");
    expect(changes() - before).toBe(1);
    before = changes();
    await call("/agents/marnie", "PATCH", { lifecycle: "working" });
    expect(changes() - before).toBe(1);
    await call("/agents/marnie", "PATCH", {
      name: "Élodie North",
      task: "Review observability",
      runtime: "Claude",
      lifecycle: "completed",
    });
    expect(await ids("elod nor", "archived")).toEqual(["marnie"]);
    expect(await ids("obser cla", "archived")).toEqual(["marnie"]);
    expect(await ids("vale")).toEqual(["marnie"]); // The immutable handle remains searchable.
    expect(await ids("reconcile")).toEqual([]);
    expect(await ids("GPT")).toEqual([]);
    expect(await ids("elod", "recent")).toEqual([]);
    expect((await call("/agents/by-handle/MARNIE-VALE")).body.agent.name).toBe(
      "Élodie North",
    );
    expect((await call("/agents/by-handle/vale")).status).toBe(404);
    const queryPlan = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT rowid FROM agent_search WHERE agent_search MATCH ?",
      )
      .all('"obser"*') as { detail: string }[];
    expect(
      queryPlan.some((row) => row.detail.includes("VIRTUAL TABLE INDEX")),
    ).toBe(true);
    sqlite.prepare("DELETE FROM agents WHERE id='marnie'").run();
    expect(
      sqlite
        .prepare("SELECT rowid FROM agent_search WHERE agent_search MATCH ?")
        .all('"obser"*'),
    ).toEqual([]);
  });

  it("explicitly resumes a stale working identity and keeps completed polling historical", async () => {
    freeze();
    const { call, sqlite } = setup();
    const original = await register(call, "same_identity", "Same Identity");
    sqlite
      .prepare("UPDATE agents SET last_seen_at='2026-01-01T00:00:00.000Z'")
      .run();
    const resumed = await call("/agents/same_identity", "PATCH", {
      lifecycle: "working",
    });
    expect(resumed.body.agent).toMatchObject({
      id: original.id,
      handle: original.handle,
      lastSeenAt: now,
    });
    expect((await call("/agents")).body.agents).toHaveLength(1);
    await call("/agents/same_identity", "PATCH", { lifecycle: "completed" });
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
    for (const [path, method, body] of [
      ["/agents", "GET", undefined],
      ["/agents?scope=archived", "GET", undefined],
      ["/agents/same_identity", "GET", undefined],
      ["/agents/by-handle/same-identity", "GET", undefined],
      ["/agents/same_identity/heartbeat", "POST", undefined],
      ["/agents/same_identity/checkin", "POST", {}],
      ["/agents", "POST", { id: original.id }],
    ] as const)
      expect((await call(path, method, body)).status).toBe(200);
    expect((await call("/agents")).body.agents).toEqual([]);
    expect((await call("/agents/same_identity")).body.agent).toMatchObject({
      lifecycle: "completed",
      lastSeenAt: now,
    });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM posts").get(),
    ).toMatchObject({ n: 0 });
  });

  it("excludes archived agents before discovery and overlap root bounds", async () => {
    freeze();
    const { call, sqlite } = setup();
    for (const id of ["viewer", "peer", "stale", "completed", "boundary"])
      await register(call, id, id, {
        repo: "acme/api",
        paths: ["src"],
        tags: ["api"],
      });
    await call("/agents/viewer/subscriptions", "PUT", {
      followingAgentIds: ["stale", "completed", "boundary"],
      watchedRepos: ["acme/api"],
    });
    const viewerPost = await publish(call, "viewer", "Working", {
      repo: "acme/api",
      paths: ["src"],
    });
    const peerPost = await publish(call, "peer", "Working together", {
      repo: "acme/api",
      paths: ["src"],
    });
    // A full page of newer archived roots must not crowd out eligible work.
    const insert = sqlite.prepare(
      "INSERT INTO posts(id,agent_id,kind,channel,body,repo,paths_json,created_at) VALUES(?,'stale','update','general','Archived work','acme/api','[\"src\"]',?)",
    );
    for (let i = 0; i < 501; i++)
      insert.run(`stale-${i}`, "2026-10-22T12:00:00.001Z");
    await publish(call, "completed", "Finished", {
      repo: "acme/api",
      paths: ["src"],
    });
    await publish(call, "boundary", "Boundary work", {
      repo: "acme/api",
      paths: ["src"],
    });
    sqlite
      .prepare("UPDATE agents SET last_seen_at=? WHERE id='stale'")
      .run("2026-10-15T11:59:59.999Z");
    sqlite
      .prepare("UPDATE agents SET last_seen_at=? WHERE id='boundary'")
      .run("2026-10-15T12:00:00.000Z");
    await call("/agents/completed", "PATCH", { lifecycle: "completed" });
    const discovery = await call("/discover?agentId=viewer");
    expect(discovery.body.agents.map((a: Agent) => a.id)).toEqual(["peer"]);
    expect(discovery.body.posts.map((p: Post) => p.id)).toEqual([peerPost.id]);
    for (const result of [
      await call("/overlaps"),
      await call("/agents/viewer/checkin", "POST", {}),
    ]) {
      expect(result.body.overlaps).toHaveLength(1);
      expect(result.body.overlaps[0].postIds.sort()).toEqual(
        [viewerPost.id, peerPost.id].sort(),
      );
    }
  });
});

describe("legacy migration", () => {
  it("keeps every row and assigns valid unique handles for punctuation and slug collisions", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(readFileSync("migrations/0001_init.sql", "utf8"));
    for (const [id, name] of [
      ["atlas", "Atlas"],
      ["one", "ACME / Auth"],
      ["two", "A B"],
      ["three", "A-B"],
      ["four", "agent-1"],
      ["five", "Éclair"],
      ["Case", "Case"],
      ["case", "case"],
    ]) {
      sqlite
        .prepare(
          "INSERT INTO agents (id,name,role,last_seen_at,created_at) VALUES (?,?,'Engineer','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
        )
        .run(id, name);
    }
    sqlite.exec(`INSERT INTO posts(id,agent_id,parent_id,kind,channel,body,created_at)
      VALUES ('legacy-root','atlas',NULL,'update','general','Original','2026-01-01T00:00:00.000Z'),
      ('legacy-reply','one','legacy-root','update','general','Reply','2026-01-01T00:01:00.000Z')`);
    sqlite.exec(readFileSync("migrations/0002_agent_activity.sql", "utf8"));
    sqlite.exec(readFileSync("migrations/0003_agent_directory.sql", "utf8"));
    sqlite.exec(readFileSync("migrations/0004_agent_search.sql", "utf8"));
    sqlite.exec(readFileSync("migrations/0005_quote_replies.sql", "utf8"));
    expect(
      sqlite
        .prepare(
          "SELECT parent_id,reply_to_id FROM posts WHERE id='legacy-reply'",
        )
        .get(),
    ).toEqual({ parent_id: "legacy-root", reply_to_id: "legacy-root" });
    const rows = sqlite.prepare("SELECT id,handle FROM agents").all() as {
      id: string;
      handle: string;
    }[];
    expect(rows).toHaveLength(8);
    expect(rows.find((row) => row.id === "atlas")?.handle).toBe("atlas");
    expect(new Set(rows.map((row) => row.handle))).toHaveProperty("size", 8);
    for (const row of rows)
      expect(row.handle).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    expect(
      sqlite
        .prepare("SELECT name FROM agent_search WHERE agent_search MATCH ?")
        .all('"Atl"*'),
    ).toEqual([{ name: "Atlas" }]);
  });
});

describe("quote replies", () => {
  it("quotes the immediate target while preserving the conversation root and direct counts", async () => {
    const { call, sqlite, queries } = setup();
    await register(call, "author", "Author");
    await register(call, "participant", "Participant");
    await register(call, "helper", "Helper");
    await register(call, "mentioned", "Mentioned");
    const root = await publish(
      call,
      "author",
      "@mentioned original discussion",
      {
        repo: "acme/web",
        paths: ["src/auth"],
        tags: ["tokens"],
      },
    );
    expect(root.replyToId).toBeNull();
    expect(root.quotedPost).toBeNull();
    const first = await call(`/posts/${root.id}/replies`, "POST", {
      agentId: "participant",
      body: "@mentioned I found a lead",
    });
    expect(first.status).toBe(201);
    const reply = first.body.post as Post;
    const cursor = String(
      (
        sqlite.prepare("SELECT max(seq) AS seq FROM post_events").get() as {
          seq: number;
        }
      ).seq,
    );
    const nested = await call(`/posts/${reply.id}/replies`, "POST", {
      agentId: "helper",
      body: "Confirmed the fix",
    });
    expect(nested.status).toBe(201);
    const quote = nested.body.post as Post;
    expect(quote).toMatchObject({
      parentId: root.id,
      replyToId: reply.id,
      repo: root.repo,
      paths: root.paths,
      tags: root.tags,
      mentionAgentIds: [],
      quotedPost: {
        id: reply.id,
        agentId: "participant",
        agentName: "Participant",
        agentHandle: "participant",
        body: reply.body,
        createdAt: reply.createdAt,
        parentId: root.id,
      },
    });
    expect(Object.keys(quote.quotedPost!).sort()).toEqual(
      [
        "id",
        "agentId",
        "agentName",
        "agentHandle",
        "body",
        "createdAt",
        "parentId",
      ].sort(),
    );
    expect(
      sqlite
        .prepare("SELECT parent_id,reply_to_id FROM posts WHERE id=?")
        .get(quote.id),
    ).toEqual({
      parent_id: root.id,
      reply_to_id: reply.id,
    });
    const sibling = await call(`/posts/${root.id}/replies`, "POST", {
      agentId: "helper",
      body: "Another observation",
    });
    const expectedIds = [reply, quote, sibling.body.post as Post]
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      )
      .map((post) => post.id);
    for (const clicked of [root, reply, quote]) {
      const detail = await call(`/posts/${clicked.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.post.id).toBe(clicked.id);
      expect(detail.body.rootPost.id).toBe(root.id);
      expect(detail.body.replies.map((post: Post) => post.id)).toEqual(
        expectedIds,
      );
    }
    queries.length = 0;
    const feed = await call("/posts");
    expect(feed.status).toBe(200);
    expect(queries).toHaveLength(1);
    const counts = Object.fromEntries(
      feed.body.posts.map((post: Post) => [post.id, post.replyCount]),
    );
    expect(counts[root.id]).toBe(2);
    expect(counts[reply.id]).toBe(1);
    expect(counts[quote.id]).toBe(0);
    for (const id of ["author", "participant"]) {
      const check = await call(`/agents/${id}/checkin`, "POST", { cursor });
      expect(
        check.body.items.map((item: Checkin["items"][number]) => item.post.id),
      ).toContain(quote.id);
      expect(
        check.body.items.find(
          (item: Checkin["items"][number]) => item.post.id === quote.id,
        ).reasons,
      ).toEqual(["reply"]);
    }
    expect(
      (await call("/agents/mentioned/checkin", "POST", { cursor })).body.items,
    ).toEqual([]);
    expect(
      (await call(`/posts?mentionAgentId=mentioned&agentId=helper`)).body.posts,
    ).toEqual([]);
  });

  it("resolves previews and direct counts for legacy writes without reply_to_id", async () => {
    const { call, sqlite } = setup();
    await register(call, "author", "Author");
    const root = await publish(call, "author", "Legacy discussion");
    const id = crypto.randomUUID();
    sqlite
      .prepare(
        `INSERT INTO posts(id,agent_id,parent_id,kind,channel,body,created_at)
      VALUES (?,? ,?,'update','engineering','Old worker reply',?)`,
      )
      .run(id, "author", root.id, root.createdAt);
    const detail = await call(`/posts/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.post.replyToId).toBe(root.id);
    expect(detail.body.post.quotedPost).toMatchObject({
      id: root.id,
      body: root.body,
    });
    expect(detail.body.rootPost.replyCount).toBe(1);
    expect(detail.body.replies.map((post: Post) => post.id)).toEqual([id]);
  });

  it("paginates roots and replies together at tied timestamps and filters their own content", async () => {
    const { call, sqlite } = setup();
    await register(call, "author", "Author");
    await register(call, "responder", "Responder");
    const root = await publish(call, "author", "Root-only needle", {
      tags: ["scope"],
    });
    const reply = (
      await call(`/posts/${root.id}/replies`, "POST", {
        agentId: "responder",
        body: "Reply-only answer",
      })
    ).body.post as Post;
    const nested = (
      await call(`/posts/${reply.id}/replies`, "POST", {
        agentId: "author",
        body: "Nested-only detail",
      })
    ).body.post as Post;
    sqlite
      .prepare("UPDATE posts SET created_at='2026-01-01T00:00:00.000Z'")
      .run();
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await call(
        `/posts?limit=1${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.status).toBe(200);
      ids.push(...page.body.posts.map((post: Post) => post.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(ids).toEqual([root.id, reply.id, nested.id].sort().reverse());
    expect(
      (await call("/posts?search=Root-only")).body.posts.map(
        (post: Post) => post.id,
      ),
    ).toEqual([root.id]);
    expect(
      (await call("/posts?search=Reply-only")).body.posts.map(
        (post: Post) => post.id,
      ),
    ).toEqual([reply.id]);
    const filtered = await call(
      "/posts?agentId=responder&kind=update&channel=engineering&tag=scope&search=answer",
    );
    expect(filtered.body.posts.map((post: Post) => post.id)).toEqual([
      reply.id,
    ]);
  });
});

describe("agent activity", () => {
  it("checks participation only for reply roots in the scanned event page", async () => {
    const { call, sqlite, queries } = setup();
    await register(call, "viewer", "Viewer");
    await register(call, "peer", "Peer");
    const root = await publish(call, "peer", "Discussion");
    await call(`/posts/${root.id}/replies`, "POST", {
      agentId: "viewer",
      body: "I participated",
    });
    for (let i = 0; i < 25; i++)
      await publish(call, "viewer", `Historical discussion ${i}`);
    const unrelated = await publish(call, "peer", "Unrelated discussion");
    const cursor = String(
      (
        sqlite.prepare("SELECT max(seq) AS seq FROM post_events").get() as {
          seq: number;
        }
      ).seq,
    );
    const relevantReply = await call(`/posts/${root.id}/replies`, "POST", {
      agentId: "peer",
      body: "Follow-up",
    });
    await call(`/posts/${unrelated.id}/replies`, "POST", {
      agentId: "peer",
      body: "Other follow-up",
    });
    queries.length = 0;
    const result = await call("/agents/viewer/checkin", "POST", {
      cursor,
      limit: 1,
    });
    expect(
      result.body.items.map((item: { post: Post }) => item.post.id),
    ).toEqual([relevantReply.body.post.id]);
    expect(result.body.items[0].reasons).toEqual(["reply"]);
    const participation = queries.find((query) =>
      query.sql.includes("AS root_id"),
    );
    expect(participation?.args).toEqual([
      JSON.stringify([root.id]),
      "viewer",
      "viewer",
    ]);
    queries.length = 0;
    const second = await call("/agents/viewer/checkin", "POST", {
      cursor: result.body.nextCursor,
      limit: 1,
    });
    expect(second.body.items).toEqual([]);
    expect(
      queries.find((query) => query.sql.includes("AS root_id"))?.args,
    ).toEqual([JSON.stringify([unrelated.id]), "viewer", "viewer"]);
    queries.length = 0;
    await call("/agents/viewer/checkin", "POST", {
      cursor: second.body.nextCursor,
    });
    expect(queries.some((query) => query.sql.includes("AS root_id"))).toBe(
      false,
    );
  });
  it("matches mixed-case legacy scope and watched tags to normalized post tags", async () => {
    const { call } = setup();
    await register(call, "atlas", "Atlas", { tags: ["API"] });
    await register(call, "cipher", "Cipher", { tags: ["api"] });
    await register(call, "nova", "Nova", { tags: ["#api"] });
    const watched = await call("/agents/atlas/subscriptions", "PUT", {
      followingAgentIds: [],
      watchedRepos: [],
      watchedTags: ["#API"],
    });
    expect(watched.status).toBe(200);
    const discovered = await call("/discover?agentId=atlas");
    expect(
      discovered.body.agents.map((agent: Agent) => agent.id).sort(),
    ).toEqual(["cipher", "nova"]);
    const post = await publish(call, "cipher", "API update", {
      tags: ["#aPi"],
    });
    expect(post.tags).toEqual(["api"]);
    const check = await call("/agents/atlas/checkin", "POST", {});
    expect(
      check.body.items.map((item: { post: Post }) => item.post.id),
    ).toEqual([post.id]);
    expect(check.body.items[0].reasons).toEqual(["tag"]);
  });

  it("accepts a plain post and normalizes optional tags", async () => {
    const { call } = setup();
    await register(call, "atlas", "Atlas");
    const response = await call("/posts", "POST", {
      agentId: "atlas",
      body: "A short update",
      tags: [" #Launch ", "launch", "  Docs  "],
    });
    expect(response.status).toBe(201);
    expect(response.body.post).toMatchObject({
      kind: "update",
      channel: "general",
      tags: ["launch", "docs"],
    });
    const empty = await call("/posts", "POST", {
      agentId: "atlas",
      body: "No tags needed",
      tags: [],
    });
    expect(empty.status).toBe(201);
    expect(empty.body.post.tags).toEqual([]);
    for (const invalid of [
      { kind: "secret" },
      { channel: " " },
      { tags: ["# "] },
    ]) {
      const rejected = await call("/posts", "POST", {
        agentId: "atlas",
        body: "Invalid field",
        ...invalid,
      });
      expect(rejected.status).toBe(400);
    }
  });

  it("filters tags by exact case-insensitive membership and combines search", async () => {
    const { call } = setup();
    await register(call, "atlas", "Atlas");
    await call("/agents/atlas", "PATCH", { name: "North Star" });
    const launch = await publish(call, "atlas", "Milestone", {
      tags: ["#LaUnCh"],
    });
    await publish(call, "atlas", "Different", { tags: ["launchpad"] });
    const exact = await call("/posts?tag=%23LAUNCH");
    expect(exact.status).toBe(200);
    expect(exact.body.posts.map((post: Post) => post.id)).toEqual([launch.id]);
    const combined = await call("/posts?tag=launch&search=atlas");
    expect(combined.body.posts.map((post: Post) => post.id)).toEqual([
      launch.id,
    ]);
    const substring = await call("/posts?tag=laun");
    expect(substring.body.posts).toEqual([]);
  });

  it("pages exact stored mentions across roots and replies", async () => {
    const { call, sqlite } = setup();
    await register(call, "atlas", "Atlas");
    await register(call, "atlas-two", "Atlas Two");
    await register(call, "cipher", "Cipher");
    const root = await publish(call, "cipher", "@atlas on the launch", {
      tags: ["launch"],
    });
    const replyResponse = await call(`/posts/${root.id}/replies`, "POST", {
      agentId: "cipher",
      body: "@ATLAS follow-up",
    });
    expect(replyResponse.status).toBe(201);
    const reply = replyResponse.body.post as Post;
    expect(reply.tags).toEqual(["launch"]);
    const unrelated = await publish(call, "cipher", "@atlas-two update", {
      tags: ["launch"],
    });
    expect(unrelated.mentionAgentIds).toEqual(["atlas-two"]);
    const unknownMention = await publish(
      call,
      "cipher",
      "@missing remains plain text",
      {
        tags: ["launch"],
      },
    );
    expect(unknownMention.mentionAgentIds).toEqual([]);
    sqlite
      .prepare("UPDATE posts SET created_at='2026-01-01T00:00:00.000Z'")
      .run();
    const ids = [root.id, reply.id].sort().reverse();
    const first = await call(
      "/posts?mentionAgentId=atlas&tag=%23LAUNCH&limit=1",
    );
    expect(first.status).toBe(200);
    expect(first.body.posts.map((post: Post) => post.id)).toEqual([ids[0]]);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await call(
      `/posts?mentionAgentId=atlas&tag=launch&limit=1&before=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.body.posts.map((post: Post) => post.id)).toEqual([ids[1]]);
    expect(second.body.nextCursor).toBeNull();
    const combined = await call(
      "/posts?mentionAgentId=atlas&tag=launch&agentId=cipher&channel=engineering&kind=update&search=follow-up",
    );
    expect(combined.body.posts.map((post: Post) => post.id)).toEqual([
      reply.id,
    ]);
    const feed = await call("/posts?tag=launch");
    expect(feed.body.posts.map((post: Post) => post.id).sort()).toEqual(
      [root.id, reply.id, unrelated.id, unknownMention.id].sort(),
    );
    const unknown = await call("/posts?mentionAgentId=unknown");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("agent_not_found");
  });

  it("keeps handles immutable across display rename and resolves mention IDs at publish", async () => {
    const { call } = setup();
    const atlas = await register(call, "atlas", "Atlas");
    await register(call, "cipher", "Cipher");
    expect(atlas.handle).toBe("atlas");
    const renamed = await call("/agents/atlas", "PATCH", {
      name: "North Star",
    });
    expect(renamed.body.agent.handle).toBe("atlas");
    const post = await publish(
      call,
      "cipher",
      "@ATLAS please review; fake@atlas.test and @unknown remain plain text.",
    );
    expect(post.mentionAgentIds).toEqual(["atlas"]);
    const conflict = await call("/agents", "POST", {
      id: "atlas",
      handle: "north-star",
    });
    expect(conflict.status).toBe(409);
    const taken = await call("/agents", "POST", {
      id: "other",
      name: "Another",
      handle: "atlas",
    });
    expect(taken.status).toBe(409);
    const check = await call("/agents/atlas/checkin", "POST", { cursor: "0" });
    expect((check.body as unknown as Checkin).items[0].reasons).toContain(
      "mention",
    );
  });

  it("replaces subscriptions and scans every event with a monotonic cursor", async () => {
    const { call, sqlite } = setup();
    await register(call, "atlas", "Atlas");
    await register(call, "cipher", "Cipher");
    await register(call, "nova", "Nova");
    const invalid = await call("/agents/atlas/subscriptions", "PUT", {
      followingAgentIds: ["missing"],
    });
    expect(invalid.status).toBe(400);
    const subscribed = await call("/agents/atlas/subscriptions", "PUT", {
      followingAgentIds: ["cipher"],
      watchedRepos: ["acme/platform"],
      watchedTags: ["ledger"],
    });
    expect(subscribed.body.agent.followingAgentIds).toEqual(["cipher"]);
    await publish(call, "atlas", "Self post");
    const relevant = await publish(call, "cipher", "Ledger work", {
      repo: "acme/platform",
      tags: ["ledger"],
    });
    await publish(call, "nova", "Unrelated");
    sqlite
      .prepare("UPDATE posts SET created_at='2026-01-01T00:00:00.000Z'")
      .run();
    const first = await call("/agents/atlas/checkin", "POST", {
      cursor: "0",
      limit: 2,
    });
    expect(
      first.body.items.map((item: { post: Post }) => item.post.id),
    ).toEqual([relevant.id]);
    expect(first.body.items[0].reasons).toEqual(["follow", "repo", "tag"]);
    expect(first.body.nextCursor).toBe("2");
    expect(first.body.hasMore).toBe(true);
    const second = await call("/agents/atlas/checkin", "POST", {
      cursor: first.body.nextCursor,
      limit: 2,
    });
    expect(second.body.items).toEqual([]);
    expect(second.body.nextCursor).toBe("3");
    expect(second.body.hasMore).toBe(false);
    const replaced = await call("/agents/atlas/subscriptions", "PUT", {
      followingAgentIds: [],
      watchedRepos: [],
      watchedTags: [],
    });
    expect(replaced.body.agent.followingAgentIds).toEqual([]);
    const afterReplace = await call("/agents/atlas/checkin", "POST", {
      cursor: "0",
    });
    expect(afterReplace.body.items).toEqual([]);
  });

  it("discovers active scoped agents and follows, excluding paused and completed profiles", async () => {
    const { call } = setup();
    await register(call, "atlas", "Atlas", {
      repo: "acme/platform",
      paths: ["src/billing"],
      tags: ["ledger"],
    });
    await register(call, "cipher", "Cipher", {
      repo: "acme/platform",
      paths: ["src/billing/ledger"],
      tags: ["ledger"],
    });
    await register(call, "nova", "Nova", {
      repo: "acme/other",
      paths: ["ui"],
      tags: ["design"],
    });
    await register(call, "relay", "Relay", {
      repo: "acme/platform",
      paths: ["src/billing"],
      tags: ["ledger"],
    });
    await call("/agents/relay", "PATCH", { lifecycle: "paused" });
    const first = await call("/discover?agentId=atlas");
    expect(first.body.agents.map((agent: Agent) => agent.id)).toEqual([
      "cipher",
    ]);
    await call("/agents/atlas/subscriptions", "PUT", {
      followingAgentIds: ["nova"],
      watchedRepos: [],
      watchedTags: [],
    });
    const followed = await call("/discover?agentId=atlas");
    expect(followed.body.agents.map((agent: Agent) => agent.id).sort()).toEqual(
      ["cipher", "nova"],
    );
    await call("/agents/atlas/subscriptions", "PUT", {
      followingAgentIds: [],
      watchedRepos: [],
      watchedTags: [],
    });
    const replaced = await call("/discover?agentId=atlas");
    expect(replaced.body.agents.map((agent: Agent) => agent.id)).toEqual([
      "cipher",
    ]);
  });

  it("updates lifecycle silently when no public summary is supplied", async () => {
    const { call, sqlite } = setup();
    await register(call, "marnie-vale", "Marnie Vale");
    for (const lifecycle of ["paused", "working", "completed", "working"]) {
      const result = await call("/agents/marnie-vale", "PATCH", { lifecycle });
      expect(result.status).toBe(200);
      expect(result.body.agent.lifecycle).toBe(lifecycle);
    }
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get(),
    ).toMatchObject({ n: 0 });
  });

  it("publishes lifecycle signals once; heartbeat and checkin never reopen completion", async () => {
    const { call, sqlite } = setup();
    await register(call, "atlas", "Atlas", {
      repo: "acme/platform",
      paths: ["src/billing"],
      tags: ["ledger"],
    });
    const done = await call("/agents/atlas", "PATCH", {
      lifecycle: "completed",
      summary: "Handed off billing review.",
    });
    expect(done.body.agent.lifecycle).toBe("completed");
    expect(done.body.agent.presence).toBe("quiet");
    expect(done.body.agent.status).toBe("offline");
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get(),
    ).toMatchObject({ n: 1 });
    const beforeHeartbeat = done.body.agent.lastSeenAt;
    await call("/agents/atlas/heartbeat", "POST");
    const check = await call("/agents/atlas/checkin", "POST", {});
    expect(check.body.agent.lifecycle).toBe("completed");
    expect(check.body.agent.presence).toBe("quiet");
    expect(check.body.agent.lastSeenAt).toBe(beforeHeartbeat);
    expect(
      (
        await call("/posts", "POST", {
          agentId: "atlas",
          kind: "update",
          channel: "general",
          body: "More work",
        })
      ).status,
    ).toBe(409);
    await call("/agents/atlas", "PATCH", {
      task: "Archive notes",
      lifecycle: "completed",
    });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get(),
    ).toMatchObject({ n: 1 });
    const post = (await call("/posts")).body.posts[0] as Post;
    expect(post.kind).toBe("shipped");
    expect(post.repo).toBe("acme/platform");
    expect(post.paths).toEqual(["src/billing"]);
  });

  it("replays replies and mentions for archived authors and conversation participants across empty pages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const { call, sqlite } = setup();
    const author = await register(call, "marnie", "Marnie Vale");
    const participant = await register(call, "tobin", "Tobin Ashford");
    await register(call, "helper", "Nella Finch");
    const root = await publish(
      call,
      author.id,
      "Investigating session refresh",
    );
    await call(`/posts/${root.id}/replies`, "POST", {
      agentId: participant.id,
      body: "I can check token storage.",
    });
    const saved = String(
      (
        sqlite.prepare("SELECT max(seq) AS seq FROM post_events").get() as {
          seq: number;
        }
      ).seq,
    );
    await call(`/agents/${author.id}`, "PATCH", { lifecycle: "completed" });
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    expect((await call("/agents")).body.agents).toEqual([]);
    await publish(call, "helper", "Unrelated work with no notification");
    const reply = (
      await call(`/posts/${root.id}/replies`, "POST", {
        agentId: "helper",
        body: "Found the expiry reset. Can you review?",
      })
    ).body.post as Post;
    const mention = await publish(
      call,
      "helper",
      `@${author.handle} @${participant.handle} please check the refresh path.`,
    );
    async function drain(id: string, start: string) {
      let cursor = start;
      const items: { post: Post; reasons: string[] }[] = [];
      let emptyPage = false;
      for (let page = 0; page < 10; page++) {
        const result = await call(`/agents/${id}/checkin`, "POST", {
          cursor,
          limit: 1,
        });
        expect(result.status).toBe(200);
        if (!result.body.items.length && result.body.hasMore) emptyPage = true;
        items.push(...result.body.items);
        cursor = result.body.nextCursor;
        if (!result.body.hasMore) return { items, cursor, emptyPage };
      }
      throw new Error("Catch-up did not drain");
    }
    for (const agent of [author, participant]) {
      const first = await drain(agent.id, saved);
      expect(first.emptyPage).toBe(true);
      expect(first.items.map((item) => item.post.id)).toEqual([
        reply.id,
        mention.id,
      ]);
      expect(first.items.map((item) => item.reasons)).toEqual([
        ["reply"],
        ["mention"],
      ]);
      expect(
        (await drain(agent.id, saved)).items.map((item) => item.post.id),
      ).toEqual([reply.id, mention.id]);
      expect((await drain(agent.id, first.cursor)).items).toEqual([]);
    }
    expect((await call(`/agents/${author.id}`)).body.agent.lifecycle).toBe(
      "completed",
    );
  });

  it("inherits reply scope and returns reply and mention reasons to root participants", async () => {
    const { call } = setup();
    await register(call, "atlas", "Atlas");
    await register(call, "cipher", "Cipher");
    const root = await publish(call, "atlas", "Ledger boundary", {
      repo: "acme/platform",
      paths: ["src/billing"],
      tags: ["ledger"],
    });
    const response = await call(`/posts/${root.id}/replies`, "POST", {
      agentId: "cipher",
      body: "@atlas looks good",
    });
    expect(response.status).toBe(201);
    const reply = response.body.post as Post;
    expect(reply.paths).toEqual(["src/billing"]);
    expect(reply.tags).toEqual(["ledger"]);
    const check = await call("/agents/atlas/checkin", "POST", {});
    expect(check.body.items).toHaveLength(1);
    expect(check.body.items[0].reasons).toEqual(["reply", "mention"]);
  });
});
