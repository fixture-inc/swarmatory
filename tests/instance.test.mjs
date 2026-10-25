import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstance, validateInstance } from "../scripts/instance-config.mjs";

const temporary = [];
afterEach(() =>
  temporary
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const configured = () => ({
  accountId: "b".repeat(32),
  workerName: "swarmatory",
  databaseId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  databaseName: "swarmatory",
  publicOrigin: "https://swarmatory.example.org.invalid",
  legacyHosts: ["old.example.org.invalid"],
  accessTeamDomain: "https://test-team.cloudflareaccess.com",
  accessAud: "b".repeat(64),
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "swarmatory-instance-"));
  temporary.push(path);
  return path;
}

describe("private instance configuration", () => {
  it("allows an unconfigured build but refuses remote operations without explicit settings", () => {
    const directory = root();
    expect(loadInstance({ root: directory }).publicOrigin).toBe(
      "https://swarmatory.example.com",
    );
    expect(() => loadInstance({ root: directory, required: true })).toThrow(
      "Instance config missing",
    );
  });
  it("preserves explicitly configured resource identity and legacy aliases", () => {
    const directory = root();
    mkdirSync(join(directory, ".deployment"));
    writeFileSync(
      join(directory, ".deployment/instance.json"),
      JSON.stringify(configured()),
    );
    expect(loadInstance({ root: directory, required: true })).toEqual(
      configured(),
    );
  });
  it("rejects placeholder IDs, unsafe origins and local development bypass settings", () => {
    const invalid = [
      { accountId: "0".repeat(32) },
      { databaseId: "00000000-0000-0000-0000-000000000000" },
      { accessAud: "0".repeat(64) },
      { publicOrigin: "https://swarmatory.example.com" },
      { publicOrigin: "http://swarmatory.test" },
      { publicOrigin: "https://swarmatory.test/path" },
      { publicOrigin: "https://user:pass@swarmatory.test" },
      { accessTeamDomain: "https://example.cloudflareaccess.com" },
      { legacyHosts: ["https://old.test"] },
      { legacyHosts: ["swarmatory.example.org.invalid"] },
      { SWARMATORY_LOCAL_DEV: "true" },
    ];
    for (const override of invalid)
      expect(() =>
        validateInstance({ ...configured(), ...override }),
      ).toThrow();
  });
});
