import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/prepare-oss.mjs", import.meta.url),
);
const temporary = [];
afterEach(() =>
  temporary
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "swarmatory-export-"));
  temporary.push(root);
  const repo = join(root, "source");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, ".gitignore"), ".deployment/\n.dev.vars\n");
  writeFileSync(join(repo, "README.md"), "# Swarmatory\n");
  writeFileSync(join(repo, ".dev.vars"), "local-only-data");
  mkdirSync(join(repo, ".deployment"));
  const config = {
    accountId: "c".repeat(32),
    workerName: "test",
    databaseName: "test",
    databaseId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    publicOrigin: "https://private.example.invalid",
    legacyHosts: [],
    accessTeamDomain: "https://private-team.cloudflareaccess.com",
    accessAud: "c".repeat(64),
  };
  writeFileSync(
    join(repo, ".deployment/instance.json"),
    JSON.stringify(config),
  );
  return { repo, destination: join(root, "export"), config };
}
function run(repo, destination) {
  return spawnSync(process.execPath, [script, destination], {
    cwd: repo,
    encoding: "utf8",
  });
}

describe("OSS source export", () => {
  it("copies current source without Git metadata, private config or local environment", () => {
    const { repo, destination } = fixture();
    expect(run(repo, destination).status).toBe(0);
    expect(readFileSync(join(destination, "README.md"), "utf8")).toBe(
      "# Swarmatory\n",
    );
    for (const path of [".git", ".deployment", ".dev.vars"])
      expect(existsSync(join(destination, path))).toBe(false);
  });
  it("stops before writing when a source file contains an instance identifier", () => {
    const { repo, destination, config } = fixture();
    writeFileSync(join(repo, "README.md"), config.accountId);
    const result = run(repo, destination);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Private instance reference");
    expect(result.stderr).not.toContain(config.accountId);
    expect(existsSync(destination)).toBe(false);
  });
  it("refuses to overwrite files or export inside the checkout", () => {
    const { repo, destination } = fixture();
    mkdirSync(destination);
    expect(run(repo, destination).status).not.toBe(0);
    expect(run(repo, join(repo, "export")).status).not.toBe(0);
  });
});

describe("monorepo export boundaries", () => {
  it("includes website sources and CI without local installation state", () => {
    const { repo, destination } = fixture();
    mkdirSync(join(repo, "website"));
    writeFileSync(join(repo, "website/index.html"), "<h1>Swarmatory</h1>");
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(join(repo, ".github/workflows/ci.yml"), "name: Checks\n");
    expect(run(repo, destination).status).toBe(0);
    expect(readFileSync(join(destination, "website/index.html"), "utf8")).toContain("Swarmatory");
    expect(existsSync(join(destination, ".github/workflows/ci.yml"))).toBe(true);
  });
  for (const nested of [".deployment/instance.json", ".dev.vars", "node_modules/package.json", ".cloudflare/output.json", ".env.production"]) {
    it(`rejects tracked website installation state: ${nested}`, () => {
      const { repo, destination } = fixture();
      const path = join(repo, "website", nested);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "private state must not export");
      execFileSync("git", ["add", "-f", "website"], { cwd: repo });
      const result = run(repo, destination);
      expect(result.status).not.toBe(0);
      expect(existsSync(destination)).toBe(false);
    });
  }
});
