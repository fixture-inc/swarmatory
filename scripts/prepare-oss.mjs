import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { loadInstance } from "./instance-config.mjs";

const root = realpathSync(process.cwd());
const requested = process.argv[2] && resolve(process.argv[2]);
if (!requested)
  throw new Error("Usage: npm run prepare:oss -- /absolute/path/to/new-export");
// Resolve parent symlinks too, so /tmp and /private/tmp cannot bypass this check.
const destination = resolve(
  realpathSync(dirname(requested)),
  basename(requested),
);
const fromRoot = relative(root, destination);
if (
  fromRoot !== ".." &&
  !fromRoot.startsWith(`..${sep}`) &&
  !isAbsolute(fromRoot)
)
  throw new Error("Choose a destination outside this checkout.");
if (existsSync(destination))
  throw new Error("Destination already exists. Choose a new directory.");

const topLevel = new Set([
  ".gitignore",
  ".dev.vars.example",
  "README.md",
  "AGENT_INTEGRATION.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "cloudflare.config.ts",
  "index.html",
  "instance.example.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "wrangler.jsonc",
]);
const sourceRoots = [
  "src/",
  "worker/",
  "shared/",
  "scripts/",
  "migrations/",
  "tests/",
  "public/",
  "docs/",
  "website/",
  ".github/workflows/",
];
const files = [
  ...new Set(
    execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean),
  ),
].sort();
// Compare against this instance without putting its values in public source.
const instanceFile = resolve(
  process.env.SWARMATORY_INSTANCE_FILE || ".deployment/instance.json",
);
const privateValues = existsSync(instanceFile)
  ? (() => {
      const instance = loadInstance({ required: true });
      return [
        instance.accountId,
        instance.databaseId,
        instance.accessAud,
        instance.accessTeamDomain,
        new URL(instance.publicOrigin).hostname,
        ...instance.legacyHosts,
      ];
    })()
  : [];
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})/,
];
for (const file of files) {
  if (
    (!topLevel.has(file) &&
      !sourceRoots.some((prefix) => file.startsWith(prefix))) ||
    file
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          part.startsWith(".env") ||
          (part.startsWith(".dev.vars") && part !== ".dev.vars.example") ||
          [".git", ".deployment", "node_modules", ".wrangler", ".cloudflare", ".build", "dist", "test-results", "playwright-report"].includes(part),
      )
  )
    throw new Error(
      `Unexpected export path: ${file}. Review before including it.`,
    );
  const source = resolve(root, file);
  if (!lstatSync(source).isFile())
    throw new Error(`Export requires plain files: ${file}`);
  const text = readFileSync(source, "utf8");
  if (privateValues.some((value) => text.includes(value)))
    throw new Error(`Private instance reference in ${file}; export stopped.`);
  if (credentialPatterns.some((pattern) => pattern.test(text)))
    throw new Error(
      `Possible credential in ${file}; export stopped (value suppressed).`,
    );
}
// Validate everything before writing. This exports the current files, not old Git history.
mkdirSync(destination);
for (const file of files) {
  const target = resolve(destination, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, file), target);
}
console.log(
  `Prepared ${files.length} source files in ${destination}. No Git history, instance settings, build output, dependencies, or local database included.`,
);
console.log(
  "Source export complete. Review credentials and dependency licenses before distribution. Nothing was published.",
);
