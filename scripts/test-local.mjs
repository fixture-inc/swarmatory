import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Never reuse a developer's D1 state or contact a remote Worker/database.
const port = 8799;
const base = `http://127.0.0.1:${port}`;
const state = await mkdtemp(join(tmpdir(), "swarmatory-tests-"));
await mkdir("test-results", { recursive: true });
const workerLog = createWriteStream("test-results/worker.log");
const envFile = join(state, "test.vars");
await writeFile(envFile, "SWARMATORY_LOCAL_DEV=true\n");
const env = {
  ...process.env,
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
  SWARMATORY_URL: base,
};
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
const local = [
  "--local",
  "--persist-to",
  join(state, "d1"),
  "--env-file",
  envFile,
];
const children = new Set();
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(new Error(`Interrupted by ${signal}`));
  });
}
function start(args, log = false) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: log ? ["ignore", "pipe", "pipe"] : "inherit",
    detached: process.platform !== "win32",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (log) {
    child.stdout.pipe(workerLog, { end: false });
    child.stderr.pipe(workerLog, { end: false });
  }
  return child;
}
async function run(args) {
  controller.signal.throwIfAborted();
  const child = start(args);
  const [code, signal] = await once(child, "exit", {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
  });
  if (code !== 0)
    throw new Error(`${args.join(" ")} failed (${signal || code})`);
}
function kill(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
try {
  // Fail if another process owns the port rather than testing that process.
  const { createServer } = await import("node:net");
  const probe = createServer();
  probe.listen(port, "127.0.0.1");
  await once(probe, "listening");
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  await run([wrangler, "d1", "migrations", "apply", "swarmatory", ...local]);
  await run([
    wrangler,
    "d1",
    "execute",
    "swarmatory",
    ...local,
    "--file",
    "scripts/seed.sql",
  ]);
  // A port can be claimed after the probe. Prove this server owns our D1 state
  // before the suites may write any fixtures over HTTP.
  const sentinelId = `gate-${randomUUID().replaceAll("-", "")}`;
  const sentinelName = randomUUID();
  await run([
    wrangler,
    "d1",
    "execute",
    "swarmatory",
    ...local,
    "--command",
    `INSERT INTO agents (id, name, role, handle, lifecycle, last_seen_at, created_at)
     VALUES ('${sentinelId}', '${sentinelName}', 'CI ownership sentinel', '${sentinelId}',
             'completed', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`,
  ]);
  const worker = start(
    [
      wrangler,
      "dev",
      ...local,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
    ],
    true,
  );
  let workerError;
  worker.once("error", (error) => {
    workerError = error;
  });
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    if (workerError) throw workerError;
    if (worker.exitCode !== null || worker.signalCode)
      throw new Error("Local Worker exited; see test-results/worker.log");
    try {
      const response = await fetch(`${base}/api/agents/${sentinelId}`, {
        signal: AbortSignal.timeout(1000),
      });
      const agent = response.ok ? (await response.json()).agent : null;
      const html = await fetch(base, { signal: AbortSignal.timeout(1000) });
      if (
        agent?.id === sentinelId &&
        agent.name === sentinelName &&
        html.ok &&
        (await html.text()).includes('<div id="root">')
      ) {
        ready = true;
        break;
      }
    } catch {
      /* Startup is bounded by the deadline. */
    }
    await delay(250, undefined, { signal: controller.signal });
  }
  if (!ready)
    throw new Error(
      "Local Worker was not ready after 60s; see test-results/worker.log",
    );
  await run(["tests/integration.mjs"]);
  await run(["tests/browser.mjs"]);
} catch (error) {
  console.error(error);
  process.exitCode ||= 1;
} finally {
  const remaining = [...children];
  for (const child of remaining) kill(child, "SIGTERM");
  await Promise.race([
    Promise.all(remaining.map((child) => once(child, "exit").catch(() => {}))),
    delay(3000),
  ]);
  for (const child of remaining) kill(child, "SIGKILL");
  await rm(state, { recursive: true, force: true });
  await new Promise((resolve) => workerLog.end(resolve));
}
