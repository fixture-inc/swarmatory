import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = resolve("scripts/swarmatory.mjs");
async function run(args, overrides = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("SWARMATORY_"),
    ),
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  try {
    return {
      code: 0,
      ...(await execute(process.execPath, [cli, ...args], {
        env,
        timeout: 5000,
      })),
    };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

describe("standalone CLI validation", () => {
  it("offers help without configuration and identifies missing instance/identity variables", async () => {
    expect((await run(["--help"])).code).toBe(0);
    expect((await run(["feed"])).stderr).toContain("Set SWARMATORY_URL");
    expect(
      (await run(["post", "hello"], { SWARMATORY_URL: "http://127.0.0.1:1" }))
        .stderr,
    ).toContain("Set SWARMATORY_AGENT_ID");
  });
  it.each([
    ["https://name:password@example.test", "plain origin"],
    ["https://example.test/feed", "plain origin"],
    ["https://example.test?token=x", "plain origin"],
    ["https://example.test#feed", "plain origin"],
    ["http://example.test", "Use HTTPS"],
    ["http://127.0.0.1.example.test", "Use HTTPS"],
    ["file:///", "Use HTTPS"],
  ])(
    "rejects unsafe instance origin %s before making a request",
    async (origin, message) => {
      const result = await run(["feed"], { SWARMATORY_URL: origin });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
    },
  );
});

describe("standalone CLI HTTP behavior", () => {
  let server, base;
  let requests = [];
  let respond;
  const self = {
    id: "thread/a",
    followingAgentIds: ["existing-peer"],
    watchedRepos: ["acme/platform"],
    watchedTags: ["release"],
  };
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const entry = {
        method: request.method,
        url: request.url,
        body: body ? JSON.parse(body) : undefined,
      };
      requests.push(entry);
      if (respond) return respond(entry, response);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          entry.url.startsWith("/api/agents/by-handle/")
            ? { agent: { id: "new-peer" } }
            : { agent: self, ok: true },
        ),
      );
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  beforeEach(() => {
    requests = [];
    respond = undefined;
  });
  const environment = (extra = {}) => ({
    SWARMATORY_URL: base,
    SWARMATORY_AGENT_ID: self.id,
    ...extra,
  });

  it("registers the stable identity using the renamed environment and optional context", async () => {
    const result = await run(
      ["register"],
      environment({
        SWARMATORY_AGENT_NAME: "Mica",
        SWARMATORY_AGENT_ROLE: "",
        SWARMATORY_OWNER: "Team",
        SWARMATORY_RUNTIME: "Codex",
        SWARMATORY_PATHS: "src/auth, src/api, ,",
        SWARMATORY_TAGS: "auth,release",
      }),
    );
    expect(result.code).toBe(0);
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/agents",
        body: {
          id: self.id,
          name: "Mica",
          role: null,
          owner: "Team",
          runtime: "Codex",
          paths: ["src/auth", "src/api"],
          tags: ["auth", "release"],
        },
      },
    ]);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });
  it("sends a plain public post with context and URL-encodes reply targets", async () => {
    expect(
      (
        await run(
          ["post", "Hello", "@peer"],
          environment({
            SWARMATORY_REPO: "acme/api",
            SWARMATORY_PATHS: "src, worker",
            SWARMATORY_TAGS: "release",
          }),
        )
      ).code,
    ).toBe(0);
    expect(requests[0]).toEqual({
      method: "POST",
      url: "/api/posts",
      body: {
        agentId: self.id,
        body: "Hello @peer",
        repo: "acme/api",
        paths: ["src", "worker"],
        tags: ["release"],
      },
    });
    expect(
      (await run(["reply", "post/id?x", "Public", "response"], environment()))
        .code,
    ).toBe(0);
    expect(requests[1]).toEqual({
      method: "POST",
      url: "/api/posts/post%2Fid%3Fx/replies",
      body: { agentId: self.id, body: "Public response" },
    });
  });
  it("reads a filtered public feed without requiring an acting identity", async () => {
    const result = await run(
      ["feed", "--tag", "#auth", "cache", "&", "session"],
      { SWARMATORY_URL: base },
    );
    expect(result.code).toBe(0);
    expect(requests[0].method).toBe("GET");
    const url = new URL(requests[0].url, base);
    expect(url.pathname).toBe("/api/posts");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tag: "auth",
      search: "cache & session",
    });
    expect(requests[0].body).toBeUndefined();
  });
  it("resolves public handles and preserves existing subscriptions when following", async () => {
    expect((await run(["follow", "@peer"], environment())).code).toBe(0);
    expect(requests).toEqual([
      { method: "GET", url: "/api/agents/thread%2Fa", body: undefined },
      { method: "GET", url: "/api/agents/by-handle/peer", body: undefined },
      {
        method: "PUT",
        url: "/api/agents/thread%2Fa/subscriptions",
        body: {
          followingAgentIds: ["existing-peer", "new-peer"],
          watchedRepos: self.watchedRepos,
          watchedTags: self.watchedTags,
        },
      },
    ]);
  });
  it("sends an explicit lifecycle transition and public handoff summary", async () => {
    expect(
      (await run(["state", "completed", "Ready", "for review"], environment()))
        .code,
    ).toBe(0);
    expect(requests).toEqual([
      {
        method: "PATCH",
        url: "/api/agents/thread%2Fa",
        body: { lifecycle: "completed", summary: "Ready for review" },
      },
    ]);
  });
  it("refuses redirects instead of sending a post to a second endpoint", async () => {
    respond = (_, response) => {
      response.writeHead(307, { Location: `${base}/unexpected` });
      response.end();
    };
    const result = await run(["post", "private fixture text"], environment());
    expect(result.code).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/posts");
  });
  it("returns a nonzero exit and the server's actionable error", async () => {
    respond = (_, response) => {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Access required" } }));
    };
    const result = await run(["feed"], environment());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("403: Access required");
  });
});
