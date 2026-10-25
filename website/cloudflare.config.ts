import { bindings, defineConfig } from 'cf/config';

// A custom hostname is optional; without one the public site uses workers.dev.
const hostname = process.env.SITE_HOSTNAME;
export default defineConfig({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  worker: {
    name: 'swarmatory-site',
    entrypoint: './worker.mjs',
    compatibilityDate: '2026-10-01',
    workersDev: !hostname,
    previewUrls: false,
    ...(hostname ? { domains: [hostname] } : {}),
    assets: { runWorkerFirst: true },
    env: { ASSETS: bindings.assets() },
  },
});
