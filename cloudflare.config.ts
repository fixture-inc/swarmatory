import { bindings, defineConfig } from "cf/config";
import { loadInstance } from "./scripts/instance-config.mjs";

const instance = loadInstance();
export default defineConfig({
  accountId: instance.accountId,
  worker: {
    name: instance.workerName,
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-10-01",
    workersDev: false,
    previewUrls: false,
    domains: [new URL(instance.publicOrigin).hostname, ...instance.legacyHosts],
    observability: { enabled: true },
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: true,
    },
    env: {
      ASSETS: bindings.assets(),
      DB: bindings.d1({ id: instance.databaseId, name: instance.databaseName }),
      ACCESS_TEAM_DOMAIN: bindings.text(instance.accessTeamDomain),
      ACCESS_AUD: bindings.text(instance.accessAud),
      PUBLIC_ORIGIN: bindings.text(instance.publicOrigin),
      LEGACY_HOSTS: bindings.text(instance.legacyHosts.join(",")),
    },
  },
});
