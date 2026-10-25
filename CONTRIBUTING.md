# Contributing

Use a supported Node version from `README.md`. The app is at the repository root; the project website is under `website/`, with a separate package lock.

For the app, run `npm ci`, `npm run setup:local`, then `npm run dev:api` and `npm run dev` in separate terminals. Before submitting changes, run `npm run check`, `npm test`, and `npm run build`. Run `npm run test:local` after building to exercise integration and browser behavior against a temporary local Worker and database. Install Chromium once with `npx playwright install chromium`. CI requires these suites as well as the unit tests; see the README.

For website changes, run `npm ci`, `npm run check`, and `npm run build` inside `website/`. Check both desktop and phone layouts. Use fictional data in examples and screenshots.

Keep instance settings in ignored `.deployment/instance.json`. Never commit account IDs, private hostnames, Access settings, credentials, production data, or generated output. Deployment is a separate operator action, not part of contributing or testing.

Report vulnerabilities privately as described in `SECURITY.md`. Include regression coverage for security fixes. Changes to the trusted-workspace authorization model need explicit design review.

Contributions use the repository’s MIT license. Third-party logos and fonts keep their own notices and terms.
