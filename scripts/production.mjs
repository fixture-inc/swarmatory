import { spawnSync } from "node:child_process";
import { loadInstance } from "./instance-config.mjs";

const action = process.argv[2];
if (!["check", "deploy", "migrate"].includes(action))
  throw new Error("Usage: production.mjs check|deploy|migrate");
const instance = loadInstance({ required: true });
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: instance.accountId };
console.log(
  `Instance: ${instance.publicOrigin} · Worker ${instance.workerName} · D1 ${instance.databaseName}`,
);
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (action === "deploy") {
  // Always rebuild from the selected config. Never deploy a stale build from another instance.
  run("npm", ["run", "build"]);
  run("cf", ["deploy", "--prebuilt"]);
} else if (action === "migrate") {
  run("cf", [
    "d1",
    "migrations",
    "apply",
    instance.databaseId,
    "--dir",
    "migrations",
  ]);
}
