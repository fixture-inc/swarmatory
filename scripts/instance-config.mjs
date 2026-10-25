import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadInstance({ required = false, root = process.cwd() } = {}) {
  const filename = resolve(
    root,
    process.env.SWARMATORY_INSTANCE_FILE || ".deployment/instance.json",
  );
  if (!existsSync(filename)) {
    if (required || process.env.SWARMATORY_INSTANCE_FILE)
      throw new Error(
        "Instance config missing. Copy instance.example.json to .deployment/instance.json and fill in your existing resources.",
      );
    // Build-only defaults. Remote commands always require explicit instance settings.
    return {
      accountId: "00000000000000000000000000000000",
      workerName: "swarmatory",
      databaseId: "00000000-0000-0000-0000-000000000000",
      databaseName: "swarmatory",
      publicOrigin: "https://swarmatory.example.com",
      legacyHosts: [],
      accessTeamDomain: "https://example.cloudflareaccess.com",
      accessAud: "0".repeat(64),
    };
  }
  const config = JSON.parse(readFileSync(filename, "utf8"));
  validateInstance(config);
  return config;
}

export function validateInstance(config) {
  const fields = [
    "accountId",
    "workerName",
    "databaseId",
    "databaseName",
    "publicOrigin",
    "legacyHosts",
    "accessTeamDomain",
    "accessAud",
  ];
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Instance config must be an object.");
  for (const key of Object.keys(config))
    if (!fields.includes(key))
      throw new Error(`Unknown instance field: ${key}`);
  for (const key of fields.filter((key) => key !== "legacyHosts"))
    if (typeof config[key] !== "string" || !config[key].trim())
      throw new Error(`Missing instance field: ${key}`);
  if (!/^[a-f0-9]{32}$/.test(config.accountId) || /^0+$/.test(config.accountId))
    throw new Error("Set a real accountId.");
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(config.databaseId) ||
    /^0[-0]+$/.test(config.databaseId)
  )
    throw new Error("Set an existing databaseId.");
  for (const key of ["workerName", "databaseName"])
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(config[key]))
      throw new Error(`Invalid ${key}.`);
  if (!/^[a-f0-9]{64}$/.test(config.accessAud) || /^0+$/.test(config.accessAud))
    throw new Error("Set a real accessAud.");
  const origin = new URL(config.publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== config.publicOrigin ||
    origin.port ||
    origin.hostname === "localhost" ||
    /(^|\.)example\.(com|org|net)$/.test(origin.hostname)
  )
    throw new Error(
      "publicOrigin must be your HTTPS origin, without a path or trailing slash.",
    );
  if (
    !/^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(
      config.accessTeamDomain,
    ) ||
    /\/\/(example|your-team)\./.test(config.accessTeamDomain)
  )
    throw new Error("Set your Access team HTTPS origin.");
  if (
    !Array.isArray(config.legacyHosts) ||
    config.legacyHosts.some(
      (host) =>
        typeof host !== "string" ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ||
        host === origin.hostname,
    )
  )
    throw new Error(
      "legacyHosts must contain hostname aliases, excluding the canonical host.",
    );
}
