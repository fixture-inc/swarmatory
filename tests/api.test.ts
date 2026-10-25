import { describe, expect, it } from "vitest";
import type { Post } from "../shared/types";
import { handleRequest } from "../worker/index";
import {
  findOverlaps,
  findOverlapPage,
  MAX_OVERLAPS,
  MAX_OVERLAP_WORK,
  pathsOverlap,
} from "../worker/overlaps";

const url = "http://localhost/api/posts";
const auth = {
  "content-type": "application/json",
};
const assetFetch = async () => new Response("asset");

function env(db: unknown) {
  return {
    DB: db,
    SWARMATORY_LOCAL_DEV: "true",
    ASSETS: { fetch: assetFetch },
  } as unknown as Parameters<typeof handleRequest>[1];
}

function post(overrides: Partial<Post>): Post {
  return {
    id: crypto.randomUUID(),
    agentId: "atlas",
    agentName: "Atlas",
    agentHandle: "atlas",
    mentionAgentIds: [],
    kind: "intent",
    channel: "engineering",
    body: "Working on billing",
    repo: "acme/platform",
    paths: [],
    tags: [],
    parentId: null,
    replyToId: null,
    quotedPost: null,
    createdAt: new Date().toISOString(),
    replyCount: 0,
    ...overrides,
  };
}

describe("API boundary", () => {
  it("requires configured Access and authenticates before database access", async () => {
    const db = {
      prepare: () => {
        throw new Error("should not reach database");
      },
    };
    const missing = await handleRequest(new Request(url), {
      ...env(db),
      SWARMATORY_LOCAL_DEV: undefined,
    });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({
      error: {
        code: "not_configured",
        message: "Cloudflare Access is not configured.",
      },
    });
    const unauthorized = await handleRequest(
      new Request(url, { headers: { authorization: "Bearer wrong" } }),
      {
        ...env(db),
        ACCESS_TEAM_DOMAIN: "https://example-team.cloudflareaccess.com",
        ACCESS_AUD:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects malformed, oversized, and invalid post bodies", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: "atlas",
            name: "Atlas",
            role: "Engineer",
            last_seen_at: new Date().toISOString(),
          }),
        }),
      }),
    };
    const malformed = await handleRequest(
      new Request(url, { method: "POST", headers: auth, body: "{" }),
      env(db),
    );
    expect(malformed.status).toBe(400);
    const oversized = await handleRequest(
      new Request(url, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ body: "x".repeat(32769) }),
      }),
      env(db),
    );
    expect(oversized.status).toBe(413);
    const badKind = await handleRequest(
      new Request(url, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          agentId: "atlas",
          kind: "secret",
          channel: "engineering",
          body: "hello",
        }),
      }),
      env(db),
    );
    expect(badKind.status).toBe(400);
    expect(
      ((await badKind.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_field");
  });

  it("cancels an oversized unknown-length stream without consuming the remaining body", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(8192));
          if (pulled === 100) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(url, {
      method: "POST",
      headers: auth,
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: string });
    expect(request.headers.has("content-length")).toBe(false);
    const response = await handleRequest(
      request,
      env({
        prepare() {
          throw new Error("must not reach DB");
        },
      }),
    );
    expect(response.status).toBe(413);
    expect(pulled).toBe(5);
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
  });

  it("counts bytes despite a misleading length and decodes split UTF-8 at the exact limit", async () => {
    const oversized = await handleRequest(
      new Request(url, {
        method: "POST",
        headers: { ...auth, "content-length": "1" },
        body: "é".repeat(17000),
      }),
      env({}),
    );
    expect(oversized.status).toBe(413);
    const encoded = new TextEncoder().encode(JSON.stringify({ agentId: "é" }));
    const bytes = new Uint8Array(32768).fill(32);
    bytes.set(encoded);
    const split = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      },
    });
    const response = await handleRequest(
      new Request(url, {
        method: "POST",
        headers: auth,
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: string }),
      env({
        prepare: () => ({
          bind: (id: string) => {
            expect(id).toBe("é");
            return { first: async () => null };
          },
        }),
      }),
    );
    expect(response.status).toBe(404);
    expect(stream.locked).toBe(false);
    const unsupported = await handleRequest(
      new Request(url, {
        method: "POST",
        body: "{}",
      }),
      env({}),
    );
    expect(unsupported.status).toBe(415);
    const declaredLarge = await handleRequest(
      new Request(url, {
        method: "POST",
        headers: { ...auth, "content-length": "32769" },
        body: "{}",
      }),
      env({}),
    );
    expect(declaredLarge.status).toBe(413);
  });

  it("adds defensive headers to assets, API responses, and authentication errors", async () => {
    const assetEnv = {
      ...env({}),
      ASSETS: {
        fetch: async () =>
          new Response("app asset", {
            status: 203,
            headers: { "content-type": "text/html", etag: "asset-version" },
          }),
      },
    };
    const asset = await handleRequest(
      new Request("http://localhost/"),
      assetEnv as unknown as Parameters<typeof handleRequest>[1],
    );
    const apiResponse = await handleRequest(
      new Request("http://localhost/api/unknown"),
      env({}),
    );
    const unauthorized = await handleRequest(new Request(url), {
      ...env({}),
      SWARMATORY_LOCAL_DEV: undefined,
    });
    for (const response of [asset, apiResponse, unauthorized]) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toBe(
        "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      );
    }
    expect(asset.status).toBe(203);
    expect(asset.headers.get("content-type")).toBe("text/html");
    expect(asset.headers.get("etag")).toBe("asset-version");
    expect(await asset.text()).toBe("app asset");
    expect(apiResponse.status).toBe(404);
    expect(unauthorized.status).toBe(503);
  });

  it("returns a 404 for unknown posting agents", async () => {
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    };
    const response = await handleRequest(
      new Request(url, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          agentId: "unknown",
          kind: "intent",
          channel: "engineering",
          body: "hello",
        }),
      }),
      env(db),
    );
    expect(response.status).toBe(404);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("agent_not_found");
  });

  it("paginates posts with a stable date-and-id cursor", async () => {
    const created = "2026-10-21T12:00:00.000Z";
    const rows = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        agent_id: "atlas",
        agent_name: "Atlas",
        agent_handle: "atlas",
        mention_agent_ids_json: "[]",
        kind: "intent",
        channel: "engineering",
        body: "First",
        repo: null,
        paths_json: "[]",
        tags_json: "[]",
        parent_id: null,
        created_at: created,
        reply_count: 0,
      },
      {
        id: "99999999-9999-4999-8999-999999999999",
        agent_id: "atlas",
        agent_name: "Atlas",
        agent_handle: "atlas",
        mention_agent_ids_json: "[]",
        kind: "intent",
        channel: "engineering",
        body: "Second",
        repo: null,
        paths_json: "[]",
        tags_json: "[]",
        parent_id: null,
        created_at: created,
        reply_count: 0,
      },
    ];
    const calls: unknown[][] = [];
    const db = {
      prepare: () => ({
        bind: (...args: unknown[]) => {
          calls.push(args);
          return {
            all: async () => ({
              results: args.length === 1 ? rows : [rows[1]],
            }),
          };
        },
      }),
    };
    const first = await handleRequest(
      new Request(`${url}?limit=1`, { headers: auth }),
      env(db),
    );
    const firstBody = (await first.json()) as {
      posts: Post[];
      nextCursor: string;
    };
    expect(firstBody.posts.map((item) => item.id)).toEqual([rows[0].id]);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await handleRequest(
      new Request(
        `${url}?limit=1&before=${encodeURIComponent(firstBody.nextCursor)}`,
        { headers: auth },
      ),
      env(db),
    );
    const secondBody = (await second.json()) as {
      posts: Post[];
      nextCursor: string | null;
    };
    expect(secondBody.posts.map((item) => item.id)).toEqual([rows[1].id]);
    expect(secondBody.nextCursor).toBeNull();
    expect(calls[1]).toEqual([created, created, rows[0].id, 2]);

    const replyRows = [...rows]
      .reverse()
      .map((row) => ({ ...row, parent_id: rows[0].id }));
    const threadCalls: { sql: string; args: unknown[] }[] = [];
    const threadDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          threadCalls.push({ sql, args });
          return {
            first: async () => rows[0],
            all: async () => ({
              results: args.length === 2 ? replyRows : [replyRows[1]],
            }),
          };
        },
      }),
    };
    const threadFirst = await handleRequest(
      new Request(`${url}/${rows[0].id}?limit=1`),
      env(threadDb),
    );
    const threadBody = (await threadFirst.json()) as {
      replies: Post[];
      nextCursor: string;
    };
    expect(threadBody.replies.map((reply) => reply.id)).toEqual([
      replyRows[0].id,
    ]);
    expect(threadBody.nextCursor).toBeTruthy();
    const threadNext = await handleRequest(
      new Request(
        `${url}/${rows[0].id}?limit=1&after=${encodeURIComponent(threadBody.nextCursor)}`,
      ),
      env(threadDb),
    );
    const nextBody = (await threadNext.json()) as {
      replies: Post[];
      nextCursor: string | null;
    };
    expect(nextBody.replies.map((reply) => reply.id)).toEqual([
      replyRows[1].id,
    ]);
    expect(nextBody.nextCursor).toBeNull();
    expect(threadCalls[1].args).toEqual([rows[0].id, 2]);
    expect(threadCalls[3].args).toEqual([
      rows[0].id,
      created,
      created,
      replyRows[0].id,
      2,
    ]);
    expect(threadCalls[3].sql).toContain("p.id>?");
    expect(threadCalls[3].sql).toContain(
      "ORDER BY p.created_at ASC,p.id ASC LIMIT ?",
    );
    for (const suffix of [
      "after=invalid",
      "after=",
      "limit=0",
      "limit=101",
      "limit=1.5",
      "limit=",
    ]) {
      const invalid = await handleRequest(
        new Request(`${url}/${rows[0].id}?${suffix}`),
        env({
          prepare() {
            throw new Error("Invalid input must fail before querying DB");
          },
        }),
      );
      expect(invalid.status).toBe(400);
    }
  });
});

describe("overlap heuristic", () => {
  it("matches mixed-case and prefixed legacy tags", () => {
    const now = Date.now();
    const a = post({
      id: "a",
      agentId: "atlas",
      tags: ["#API"],
      createdAt: new Date(now - 1000).toISOString(),
    });
    const b = post({
      id: "b",
      agentId: "cipher",
      tags: ["api"],
      createdAt: new Date(now - 500).toISOString(),
    });
    expect(findOverlaps([a, b], now)).toMatchObject([{ sharedTags: ["api"] }]);
  });

  it("matches exact or ancestor paths with a slash boundary", () => {
    expect(pathsOverlap("src/billing", "src/billing/ledger")).toBe(
      "src/billing",
    );
    expect(pathsOverlap("./src/billing/", "src/billing/ledger.ts")).toBe(
      "src/billing",
    );
    expect(pathsOverlap("src\\billing\\", "src//billing/ledger.ts")).toBe(
      "src/billing",
    );
    expect(pathsOverlap("src/bill", "src/billing")).toBeNull();
  });

  it("uses only the latest recent unshipped root per agent and repository", () => {
    const now = Date.now();
    const a = post({
      id: "a",
      paths: ["src/billing"],
      tags: ["ledger"],
      createdAt: new Date(now - 60_000).toISOString(),
    });
    const b = post({
      id: "b",
      agentId: "cipher",
      paths: ["src/billing/ledger"],
      createdAt: new Date(now - 30_000).toISOString(),
    });
    const olderSameAgent = post({
      id: "c",
      agentId: "cipher",
      paths: ["src/other"],
      tags: ["ledger"],
      createdAt: new Date(now - 120_000).toISOString(),
    });
    const shipped = post({
      id: "d",
      agentId: "pixel",
      kind: "shipped",
      paths: ["src/billing"],
    });
    const stale = post({
      id: "e",
      agentId: "relay",
      createdAt: new Date(now - 25 * 3600_000).toISOString(),
      tags: ["ledger"],
    });
    const otherRepo = post({
      id: "f",
      agentId: "orbit",
      repo: "acme/web",
      tags: ["ledger"],
    });
    expect(
      findOverlaps([olderSameAgent, shipped, otherRepo, a, stale, b], now),
    ).toEqual([
      {
        agentIds: ["cipher", "atlas"],
        postIds: ["b", "a"],
        repo: "acme/platform",
        sharedPaths: ["src/billing"],
        sharedTags: [],
      },
    ]);
  });

  it("does not revive an older intent after that agent ships", () => {
    const now = Date.now();
    const oldIntent = post({
      id: "a",
      paths: ["src/billing"],
      createdAt: new Date(now - 120_000).toISOString(),
    });
    const shipped = post({
      id: "b",
      kind: "shipped",
      paths: ["src/billing"],
      createdAt: new Date(now - 60_000).toISOString(),
    });
    const other = post({
      id: "c",
      agentId: "cipher",
      paths: ["src/billing"],
      createdAt: new Date(now - 30_000).toISOString(),
    });
    expect(findOverlaps([oldIntent, shipped, other], now)).toEqual([]);
  });
  it("caps dense overlap output and sparse adversarial comparison work", () => {
    const now = Date.now();
    const dense = Array.from({ length: 500 }, (_, i) =>
      post({
        id: `dense-${i}`,
        agentId: `agent-${i}`,
        paths: ["src/shared"],
      }),
    );
    const densePage = findOverlapPage(dense, now);
    expect(densePage.overlaps).toHaveLength(MAX_OVERLAPS);
    expect(densePage.truncated).toBe(true);
    expect(densePage.work).toBeLessThanOrEqual(MAX_OVERLAP_WORK);
    const sparse = dense.map((item, i) => ({
      ...item,
      paths: Array.from({ length: 12 }, (_, j) => `src/unique-${i}-${j}`),
      tags: Array.from({ length: 12 }, (_, j) => `tag-${i}-${j}`),
    }));
    const sparsePage = findOverlapPage(sparse, now);
    expect(sparsePage.overlaps).toEqual([]);
    expect(sparsePage.truncated).toBe(true);
    expect(sparsePage.work).toBe(MAX_OVERLAP_WORK);
  });

  it("scopes comparisons before unrelated matches can exhaust the output or work budget", () => {
    const now = Date.now();
    const unrelated = Array.from({ length: 498 }, (_, i) =>
      post({
        id: `unrelated-${i}`,
        agentId: `unrelated-${i}`,
        paths: ["src/unrelated"],
        createdAt: new Date(now - 1000).toISOString(),
      }),
    );
    const relevant = [
      post({
        id: "target",
        agentId: "target",
        paths: ["src/target"],
        createdAt: new Date(now - 2000).toISOString(),
      }),
      post({
        id: "peer",
        agentId: "peer",
        paths: ["src/target"],
        createdAt: new Date(now - 2000).toISOString(),
      }),
    ];
    const page = findOverlapPage([...unrelated, ...relevant], now, {
      agentId: "target",
    });
    expect(page.truncated).toBe(false);
    expect(page.overlaps).toHaveLength(1);
    expect(page.overlaps[0].agentIds).toContain("target");
    expect(page.overlaps[0].agentIds).toContain("peer");
    expect(page.work).toBeLessThan(MAX_OVERLAP_WORK);
  });
});
