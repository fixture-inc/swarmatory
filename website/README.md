# Swarmatory project website

The project website for [fixture-inc/swarmatory](https://github.com/fixture-inc/swarmatory) lives in `website/`. The Swarmatory application lives at the repository root. Each has its own build and deployment.

## Local development

From the repository root:

```sh
cd website
npm ci
npm run dev
# http://127.0.0.1:4321
```

Use a current Node.js release supported by the pinned Vite and Cloudflare tooling. This directory has its own `package.json` and lockfile; install its dependencies separately from the root application.

```sh
npm run check
npm run build
```

These commands only validate and build the website. They do not publish it. `server.mjs` is a loopback-only source preview for local development, not a production host.

## Independent website deployment

Use the globally installed Cloudflare `cf` CLI and your existing Cloudflare login. Follow [Cloudflare’s CLI setup documentation](https://developers.cloudflare.com/cf/get-started/) if the command or login is missing. Do not paste credentials into source files or create a separate auth profile.

Choose the Cloudflare account for this public site. Run these commands from `website/`:

```sh
export CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID
# Optional: a hostname in a zone you control, without a scheme or path.
export SITE_HOSTNAME=www.example.com
npm run deploy
```

`npm run deploy` builds, then runs `cf deploy --prebuilt`. The public Worker is named `swarmatory-site`; choose a distinct name in `cloudflare.config.ts` if that name is already in use in your account. With `SITE_HOSTNAME` set, it serves that custom domain and disables its `workers.dev` URL. Without that variable, it uses the Worker's public `workers.dev` URL. Preview URLs are disabled.

The site has only a static-assets binding. It does not provision, deploy, or access a Swarmatory application instance, database, or sign-in policy. Its public availability is independent from the private application. Before publishing a fork on a new hostname, update the canonical and Open Graph URLs in `index.html` and the maintained install-guide URL in `prompts.js` and `index.html`.

`npm run build` prepares the allowlisted public assets in `.build/public` and produces deployment output in `.cloudflare/output`. The build does not serve the source preview server, README files, configuration, dependency directories, or local environment files. Generated directories and local configuration are ignored by `website/.gitignore`.

## Content and assets

`index.html`, `style.css`, `script.js`, `prompts.js`, `story.css`, `story.js`, `install.md`, and `assets/` are the site sources. The install console links to the maintained `install.md` guide; its application commands run from the repository root, not `website/`. Application installation does not require building or deploying this website.

The screenshots show the actual application with fictional agents and conversations from an isolated local database. No production records are used. Screenshot provenance is recorded in `assets/screenshots/README.md`. The illustrated workflow follows a fictional Sentry issue through human instructions, agent coordination, and a reviewed PR. Normal page scrolling drives the example; a static transcript and reduced-motion behavior are included. Keep the existing SVG icons rather than substituting decorative text symbols.

The website makes no runtime API or model calls and includes no analytics or forms. Fonts and brand images are served locally. Font licenses are in `assets/licenses/`; brand ownership and provenance are in `assets/README.md`. The “Made by Fixture” link uses Fixture’s official mark and a referral URL. Brand marks remain owned by their respective owners and are excluded from the source-code license.
