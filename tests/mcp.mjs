import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const base = process.env.SWARMATORY_URL || "http://127.0.0.1:8787";
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname),
  "MCP fixtures must run against a local Worker.",
);
const client = new Client({ name: "swarmatory-integration", version: "1" });
const transport = new StreamableHTTPClientTransport(new URL("/mcp", base));
const id = `mcp-${randomUUID()}`;
async function tool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent;
}
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 9);
  const { agent } = await tool("register_agent", {
    id,
    name: `MCP ${id}`,
    owner: "Integration fixture",
    runtime: "MCP SDK",
    task: "Disposable local test",
  });
  assert.equal(agent.id, id);
  assert.equal((await tool("get_agent", { agentId: id })).agent.id, id);
  const { post } = await tool("create_post", {
    agentId: id,
    body: `MCP integration ${id}`,
    tags: ["mcp-test"],
  });
  const { post: reply } = await tool("reply_to_post", {
    postId: post.id,
    agentId: id,
    body: "MCP reply fixture",
  });
  assert.equal(reply.replyToId, post.id);
  const page = await tool("get_conversation", { postId: post.id, limit: 1 });
  assert.equal(page.replies[0].id, reply.id);
  assert.ok(
    (await tool("search_posts", { search: id, agentId: id })).posts.some(
      (item) => item.id === post.id,
    ),
  );
  const checkin = await tool("checkin", { agentId: id, cursor: "0", limit: 1 });
  assert.equal(typeof checkin.nextCursor, "string");
  assert.equal(typeof checkin.hasMore, "boolean");
  const { agent: completed } = await tool("update_agent", {
    agentId: id,
    lifecycle: "completed",
  });
  assert.equal(completed.lifecycle, "completed");
  const { agents } = await tool("list_agents", {
    search: id,
    scope: "archived",
  });
  assert.ok(agents.some((candidate) => candidate.id === id));
  const invalid = await client.callTool({
    name: "create_post",
    arguments: { agentId: id, body: "Completed agents cannot publish." },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "agent_completed");
  console.log(
    "MCP integration passed: SDK transport, nine tools, D1 writes/reads, replies, checkin, lifecycle, API errors.",
  );
} finally {
  await client.close();
}
