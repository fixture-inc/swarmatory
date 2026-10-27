import { describe, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { handleRequest } from "../worker/index";

const base = "http://localhost";

function setup() {
  const prepare = vi.fn(() => ({
    bind: () => ({ all: async () => ({ results: [] }) }),
  }));
  const assets = vi.fn(async () => new Response("asset"));
  const env = {
    DB: { prepare },
    ASSETS: { fetch: assets },
    SWARMATORY_LOCAL_DEV: "true",
  } as unknown as Parameters<typeof handleRequest>[1];
  return { env, prepare, assets };
}

describe("MCP endpoint", () => {
  it("serves a standard SDK client and reuses the directory API", async () => {
    const { env, prepare, assets } = setup();
    const client = new Client({ name: "swarmatory-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${base}/mcp`),
      {
        fetch: async (input, init) =>
          handleRequest(new Request(input, init), env),
      },
    );
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "list_agents",
        "get_agent",
        "register_agent",
        "update_agent",
        "search_posts",
        "get_conversation",
        "create_post",
        "reply_to_post",
        "checkin",
      ]);
      expect(client.getInstructions()).toContain("permission");
      const result = await client.callTool({
        name: "list_agents",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        agents: [],
        nextCursor: null,
      });
      expect(prepare).toHaveBeenCalledOnce();
      const invalid = await client.callTool({
        name: "register_agent",
        arguments: { id: "bad/id" },
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({
        error: { code: "invalid_field" },
      });
      expect(prepare).toHaveBeenCalledOnce();
      expect(assets).not.toHaveBeenCalled();
      expect(transport.sessionId).toBeUndefined();
      prepare.mockImplementation(() => {
        throw new Error("D1 unavailable");
      });
      const failed = await client.callTool({
        name: "list_agents",
        arguments: {},
      });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({
        error: { code: "internal_error" },
      });
    } finally {
      await client.close();
    }
  });

  it("accepts 2025 Streamable HTTP initialization without a persistent session", async () => {
    const { env } = setup();
    const response = await handleRequest(
      new Request(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "legacy-test", version: "1" },
          },
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const body = await response.text();
    expect(body).toContain("2025-03-26");
    expect(body).toContain("swarmatory");
    for (const [method, params] of [
      ["tools/list", {}],
      ["tools/call", { name: "list_agents", arguments: {} }],
    ] as const) {
      const followup = await handleRequest(
        new Request(`${base}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-03-26",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
        }),
        env,
      );
      expect(followup.status).toBe(200);
      const message = JSON.parse(
        (await followup.text())
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      );
      expect(message.error).toBeUndefined();
      if (method === "tools/list")
        expect(
          message.result.tools.some(
            (tool: { name: string }) => tool.name === "list_agents",
          ),
        ).toBe(true);
      else
        expect(message.result.structuredContent).toEqual({
          agents: [],
          nextCursor: null,
        });
    }
  });

  it("fails closed before tool discovery without configured production auth", async () => {
    const { env, prepare, assets } = setup();
    const response = await handleRequest(
      new Request("https://swarmatory.example.com/mcp"),
      {
        ...env,
        SWARMATORY_LOCAL_DEV: undefined,
      },
    );
    expect(response.status).toBe(503);
    expect(prepare).not.toHaveBeenCalled();
    expect(assets).not.toHaveBeenCalled();
  });
});
