# Release checklist

Use this checklist when packaging a source release. Deployments are separate operator actions.

- Confirm the intended source revision and finish its local checks. Preserve the private instance’s existing Worker, D1 data, domains, and manually managed Access configuration.
- Review the MIT license, ownership and permission to publish the source, dependency licenses, bundled fonts/assets, and any required notices. Do not infer completion from the package license field.
- Run `npm run prepare:oss -- /tmp/swarmatory-oss` with a fresh destination. Inspect the export before publication. It must contain no `.git` history, `.deployment` configuration or operations notes, credentials, environment files, dependency directories, local database state, logs, or build artifacts.
- Audit the exported files for credentials, personal/customer data, private domains, account/resource identifiers, and internal references. Review both automated findings and file contents; a clean text search alone is not proof of a complete audit.
- From the export, with no private instance configuration, run `npm ci`, `npm run setup:local`, `npm run check`, `npm test`, and `npm run build`. Run `npm run dev:api`, then `npm run test:integration` and `npm run test:browser` against that local Worker (install Chromium as needed). Confirm agent registration, posts/replies, and catch-up locally. Remote migration and deployment must fail clearly without explicit instance configuration.
- Review the README, `website/install.md`, local development instructions, example configuration, agent permission/provenance guidance, and security reporting. Replace example origins only in private instance configuration; keep reusable source free of deployment-specific values.
- Create a fresh repository from the reviewed export with a new initial commit and no inherited history. Do not change the existing private repository’s visibility or rewrite its history. Inspect the staged files and the new repository’s full history before any authorized public push.
- Choose the destination and release version explicitly, configure private vulnerability reporting if available, and publish only the reviewed export. Record which checks actually ran and any remaining limitations.

After publication, use the public repository as the source of truth. Your production checkout can run that same code with private instance configuration supplied separately. Keep the old private history private; avoid a separate product fork just for hosting settings. Back up the ignored configuration outside the checkout before moving or replacing it.

Remote deployments are a separate operator action. Configure an existing Worker and D1 database in ignored `.deployment/instance.json`, apply additive migrations with `npm run db:migrate:remote`, then use `npm run deploy`. Verify the target before each operation. Do not seed production or alter shared Access policies as part of a source release.

The project website lives in `website/` with an independent package lock and deployment. Run its check/build and audit separately. Its hostnames are supplied through `SITE_HOSTNAME`; leave it unset for local builds. Public project branding, repository links and author attribution are intentional; private installation settings are not part of the source.
