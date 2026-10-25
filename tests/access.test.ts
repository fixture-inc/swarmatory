import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { handleRequest } from "../worker/index";

const issuer = "https://example-team.cloudflareaccess.com";
const audience =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const app = "https://swarmatory.example.com";
const access = {
  ACCESS_TEAM_DOMAIN: issuer,
  ACCESS_AUD: audience,
  PUBLIC_ORIGIN: app,
  LEGACY_HOSTS: "old-swarmatory.example.com",
};
let signingKey: CryptoKey;
let wrongKey: CryptoKey;
const fetchKeys = vi.fn();

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  wrongKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "access-key" };
  fetchKeys.mockImplementation(async (url: string) => {
    expect(String(url)).toBe(`${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  });
  vi.stubGlobal("fetch", fetchKeys);
});
afterAll(() => vi.unstubAllGlobals());

async function token(claims: JWTPayload = {}, key = signingKey) {
  return new SignJWT({
    iss: issuer,
    aud: [audience],
    sub: "access-user-id",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "access-key" })
    .sign(key);
}

function setup(overrides = {}) {
  const prepare = vi.fn(() => ({
    bind: () => ({ all: async () => ({ results: [] }) }),
  }));
  const env = {
    DB: { prepare },
    ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
    ...access,
    ...overrides,
  } as unknown as Parameters<typeof handleRequest>[1];
  return { env, prepare };
}

async function assertDenied(assertion: string | undefined, expected = 401) {
  const { env, prepare } = setup();
  const response = await handleRequest(
    new Request(`${app}/api/agents`, {
      headers: assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {},
    }),
    env,
  );
  expect(response.status).toBe(expected);
  expect(await response.json()).toEqual({
    error: {
      code: "unauthorized",
      message: "Cloudflare Access authentication required.",
    },
  });
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(prepare).not.toHaveBeenCalled();
}

describe("Cloudflare Access API boundary", () => {
  it("verifies signed identity and reuses the fixed team JWKS", async () => {
    const { env, prepare } = setup();
    const assertion = await token();
    for (let i = 0; i < 2; i++) {
      const response = await handleRequest(
        new Request(`${app}/api/agents`, {
          headers: { "Cf-Access-Jwt-Assertion": assertion },
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ agents: [], nextCursor: null });
    }
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it("rejects missing or malformed assertions and the old bearer key", async () => {
    await assertDenied(undefined);
    await assertDenied("not-a-jwt");
    const { env, prepare } = setup();
    const response = await handleRequest(
      new Request(`${app}/api/agents`, {
        headers: { authorization: "Bearer old-key" },
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects unsigned, forged, expired, premature, or wrongly scoped JWTs", async () => {
    const unsigned = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(
      JSON.stringify({ iss: issuer, aud: [audience], sub: "forged" }),
    )}.`;
    await assertDenied(unsigned);
    await assertDenied(await token({}, wrongKey));
    await assertDenied(await token({ exp: Math.floor(Date.now() / 1000) - 1 }));
    await assertDenied(
      await token({ nbf: Math.floor(Date.now() / 1000) + 300 }),
    );
    await assertDenied(await token({ aud: "different-app" }));
    await assertDenied(
      await token({ iss: "https://other.cloudflareaccess.com" }),
    );
    await assertDenied(await token({ exp: undefined }));
    await assertDenied(await token({ sub: undefined }));
    await assertDenied(await token({ sub: "" }));
  });

  it.each([
    { ACCESS_TEAM_DOMAIN: undefined },
    { ACCESS_AUD: undefined },
    { ACCESS_TEAM_DOMAIN: "" },
    { ACCESS_AUD: "" },
    { ACCESS_TEAM_DOMAIN: "http://example-team.cloudflareaccess.com" },
    { ACCESS_TEAM_DOMAIN: `${issuer}/path` },
    { ACCESS_TEAM_DOMAIN: "https://attacker.example" },
    { ACCESS_AUD: "invalid" },
  ])(
    "fails closed for missing or invalid configuration: %o",
    async (config) => {
      const { env, prepare } = setup(config);
      const response = await handleRequest(
        new Request(`${app}/api/agents`),
        env,
      );
      expect(response.status).toBe(503);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("not_configured");
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("rejects cross-site and mismatched-origin writes before database access", async () => {
    const assertion = await token();
    const rejectedHeaders: Record<string, string>[] = [
      { origin: "https://attacker.example" },
      { origin: "null" },
      { origin: app, "sec-fetch-site": "cross-site" },
    ];
    for (const extra of rejectedHeaders) {
      const { env, prepare } = setup();
      const response = await handleRequest(
        new Request(`${app}/api/agents`, {
          method: "POST",
          headers: { "Cf-Access-Jwt-Assertion": assertion, ...extra },
        }),
        env,
      );
      expect(response.status).toBe(403);
      expect(prepare).not.toHaveBeenCalled();
    }
    const allowedHeaders: Record<string, string>[] = [{}, { origin: app }];
    for (const headers of allowedHeaders) {
      const { env } = setup();
      const response = await handleRequest(
        new Request(`${app}/api/unknown`, {
          method: "POST",
          headers: { "Cf-Access-Jwt-Assertion": assertion, ...headers },
        }),
        env,
      );
      expect(response.status).toBe(404);
    }
  });

  it("continues serving non-API assets", async () => {
    const { env, prepare } = setup();
    const response = await handleRequest(
      new Request(`${app}/`, {
        headers: { "Cf-Access-Jwt-Assertion": await token() },
      }),
      env,
    );
    expect(await response.text()).toBe("asset");
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("hostname migration", () => {
  it("does not turn an invalid canonical origin into an open redirect", async () => {
    for (const publicOrigin of [
      undefined,
      "http://swarmatory.example.com",
      "https://swarmatory.example.com/path",
      "https://old-swarmatory.example.com",
    ]) {
      const { env } = setup({ PUBLIC_ORIGIN: publicOrigin });
      const response = await handleRequest(
        new Request("https://old-swarmatory.example.com/skill.md", {
          headers: { "Cf-Access-Jwt-Assertion": await token() },
        }),
        env,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("serves instance-specific skill examples without publishing private configuration", async () => {
    const { env } = setup();
    const source =
      "# Swarmatory\nUse https://swarmatory.example.com/api/posts and https://swarmatory.example.com/skill.md";
    env.ASSETS.fetch = vi.fn(
      async () => new Response(source),
    ) as typeof env.ASSETS.fetch;
    const response = await handleRequest(
      new Request("https://another.example.org/skill.md", {
        headers: { "Cf-Access-Jwt-Assertion": await token() },
      }),
      env,
    );
    expect(await response.text()).toBe(
      source.replaceAll(
        "https://swarmatory.example.com",
        "https://another.example.org",
      ),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("text/markdown");
  });

  it("protects both hosts and static assets before redirecting or serving", async () => {
    for (const host of [app, "https://old-swarmatory.example.com"]) {
      for (const path of ["/", "/skill.md", "/api/posts"]) {
        const { env, prepare } = setup();
        const response = await handleRequest(new Request(host + path), env);
        expect(response.status).toBe(401);
        expect(response.headers.get("location")).toBeNull();
        expect(prepare).not.toHaveBeenCalled();
        expect(env.ASSETS.fetch).not.toHaveBeenCalled();
      }
    }
  });
  it("permanently redirects legacy paths and queries without reading or writing data", async () => {
    for (const method of ["GET", "HEAD", "POST"]) {
      const { env, prepare } = setup();
      const response = await handleRequest(
        new Request(
          "https://old-swarmatory.example.com/api/posts?search=a%20b&tag=auth",
          {
            method,
            headers: { "Cf-Access-Jwt-Assertion": await token() },
            ...(method === "POST" ? { body: '{"body":"example"}' } : {}),
          },
        ),
        env,
      );
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe(
        `${app}/api/posts?search=a%20b&tag=auth`,
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    }
  });
});

describe("explicit local development bypass", () => {
  const localConfig = {
    SWARMATORY_LOCAL_DEV: "true",
    ACCESS_TEAM_DOMAIN: undefined,
    ACCESS_AUD: undefined,
  };

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows explicit loopback development at %s",
    async (host) => {
      const { env, prepare } = setup(localConfig);
      const response = await handleRequest(
        new Request(`http://${host}:8787/api/agents`),
        env,
      );
      expect(response.status).toBe(200);
      expect(prepare).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { SWARMATORY_LOCAL_DEV: undefined },
    { SWARMATORY_LOCAL_DEV: "false" },
    { SWARMATORY_LOCAL_DEV: "TRUE" },
    { ACCESS_TEAM_DOMAIN: "" },
    { ACCESS_AUD: "" },
    { ACCESS_TEAM_DOMAIN: issuer },
    { ACCESS_AUD: audience },
  ])(
    "does not bypass partial, empty, or implicit configuration: %o",
    async (config) => {
      const { env, prepare } = setup({ ...localConfig, ...config });
      const response = await handleRequest(
        new Request("http://localhost:8787/api/agents"),
        env,
      );
      expect(response.status).toBe(503);
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("never bypasses a deployed hostname or configured Access", async () => {
    const remote = setup(localConfig);
    expect(
      (await handleRequest(new Request(`${app}/api/agents`), remote.env))
        .status,
    ).toBe(503);
    expect(remote.prepare).not.toHaveBeenCalled();
    const configured = setup({ SWARMATORY_LOCAL_DEV: "true" });
    expect(
      (
        await handleRequest(
          new Request("http://localhost/api/agents"),
          configured.env,
        )
      ).status,
    ).toBe(401);
    expect(configured.prepare).not.toHaveBeenCalled();
  });

  it("allows the loopback Vite origin but rejects external and cross-site writes", async () => {
    for (const [headers, status] of [
      [{ origin: "http://127.0.0.1:5173" }, 404],
      [{ origin: "https://attacker.example" }, 403],
      [{ "sec-fetch-site": "cross-site" }, 403],
    ] as const) {
      const { env, prepare } = setup(localConfig);
      const response = await handleRequest(
        new Request("http://127.0.0.1:8787/api/unknown", {
          method: "POST",
          headers,
        }),
        env,
      );
      expect(response.status).toBe(status);
      expect(prepare).not.toHaveBeenCalled();
    }
  });
});
