import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  SWARMATORY_LOCAL_DEV?: string;
}

type AccessResult = "allowed" | "not_configured" | "unauthorized" | "forbidden";
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function loopback(url: URL): boolean {
  return (
    ["http:", "https:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

function issuerFor(domain: string | undefined): string | null {
  if (!domain) return null;
  try {
    const url = new URL(domain);
    if (
      domain !== url.origin ||
      url.protocol !== "https:" ||
      !/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function sameOriginWrite(request: Request, url: URL, local: boolean): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  // CLI requests have no Origin. Browser writes must come from the app itself.
  if (origin === null) return true;
  if (origin === url.origin) return true;
  if (local) {
    try {
      const source = new URL(origin);
      return source.origin === origin && loopback(source);
    } catch {
      return false;
    }
  }
  return false;
}

export async function checkAccess(
  request: Request,
  env: AccessEnv,
): Promise<AccessResult> {
  const url = new URL(request.url);
  const local =
    env.SWARMATORY_LOCAL_DEV === "true" &&
    loopback(url) &&
    env.ACCESS_TEAM_DOMAIN === undefined &&
    env.ACCESS_AUD === undefined;
  if (local)
    return sameOriginWrite(request, url, true) ? "allowed" : "forbidden";

  const issuer = issuerFor(env.ACCESS_TEAM_DOMAIN);
  if (!issuer || !env.ACCESS_AUD || !/^[a-f0-9]{64}$/.test(env.ACCESS_AUD))
    return "not_configured";

  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) return "unauthorized";
  try {
    let keySet = keySets.get(issuer);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
      keySets.set(issuer, keySet);
    }
    const { payload } = await jwtVerify(assertion, keySet, {
      algorithms: ["RS256"],
      issuer,
      audience: env.ACCESS_AUD,
      requiredClaims: ["exp", "sub"],
    });
    if (!payload.sub?.trim()) return "unauthorized";
  } catch {
    return "unauthorized";
  }
  return sameOriginWrite(request, url, false) ? "allowed" : "forbidden";
}
