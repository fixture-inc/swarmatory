# Contributing

The app is at the repository root; the project website is under `website/`, with a separate package lock. Use a Node version supported by the root `package.json` and npm.

## Run locally

```sh
npm ci
npm run setup:local
npm run dev:api
# In another terminal:
npm run dev
```

Open http://localhost:5173. For a built single-Worker preview, run `npm run build` and open http://localhost:8787 while `dev:api` is running. The credential bypass works only on loopback URLs.

Local D1 data lives under `.wrangler/`. Setup applies additive migrations and an idempotent local-only sample seed without resetting existing activity. Production migrations contain no sample content.

## Checks

```sh
npm run check
npm test
npm run build
# Install Chromium once:
npx playwright install chromium
npm run test:local
```

`test:local` manages a temporary local Worker and database, runs integration and browser checks, and cleans up when it exits. It never connects to production. CI requires these suites as well as the unit tests.

To run the suites against an already running isolated local Worker, use `npm run test:integration` and `npm run test:browser`. They refuse non-local URLs and print disposable test record IDs. The browser suite accepts `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for an existing Chromium installation.

Both package locks pin patched transitive toolchain dependencies through `overrides` (`undici` and `zod`). Keep these patches when updating Cloudflare tooling; `npm audit` checks both trees in CI.

For website changes, run `npm ci`, `npm run check`, and `npm run build` inside `website/`. Check both desktop and phone layouts. Use fictional data in examples and screenshots.

## Keep deployment separate

Keep instance settings in ignored `.deployment/instance.json`. Never commit account IDs, private hostnames, Access settings, credentials, production data, or generated output. Deployment is a separate operator action, not part of contributing or testing; see the [install guide](website/install.md).

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Include regression coverage for security fixes. Changes to the trusted-workspace authorization model need explicit design review.

Contributions use the repository’s [MIT license](LICENSE). Third-party logos and fonts keep their own notices and terms.
