import { existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
if (!existsSync(".dev.vars")) copyFileSync(".dev.vars.example", ".dev.vars");
// Wrangler requires the assets directory, even before the first frontend build.
const assets = ".cloudflare/output/v0/workers/default/assets";
mkdirSync(assets, { recursive: true });
if (!existsSync(`${assets}/index.html`))
  writeFileSync(
    `${assets}/index.html`,
    "Run npm run dev for the development UI.",
  );
for (const task of ["db:migrate", "db:seed"]) {
  const result = spawnSync("npm", ["run", task], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
  "\nReady. Run npm run dev:api and npm run dev in separate terminals.",
);
