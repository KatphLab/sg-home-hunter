# House Hunter

House Hunter is an installable, client-only PWA for finding Singapore neighbourhoods within 500 m straight-line distance of public transit stops that offer a qualifying commute to a workplace. See [spec.md](.scratch/commute-zones/spec.md) for product requirements, [GLOSSARY.md](GLOSSARY.md) for domain terms, [PRODUCT.md](PRODUCT.md) for durable product context, and [DESIGN.md](DESIGN.md) for the HDB Town Precinct Directory design system.

## Features

- **Direct OneMap browser sign-in:** Connects with your own OneMap email and password directly from the browser (no backend proxy or shared token; passwords are never stored or logged).
- **Workplace & search rules:** Supports 6-digit Singapore postal codes (preserving leading zeros) or exact line-specific MRT/LRT stations, defaults the search date to the next non-holiday Singapore workday (including observed Sunday-to-Monday public holidays), enforces an inclusive 15-minute arrival window (`[officeStart - 15m, officeStart]`), and separates in-vehicle ride time from walking and transfers.
- **Progressive breadth-first discovery:** Checks every candidate stop in the bundled dated inventory (`public/data/stops.tsv`) on pass 1 before revisiting unmatched stops, streaming 500 m union patches live onto a Leaflet map and an accessible synced stop list.
- **Offline viewing:** Service Worker (`src/sw.ts`) caches the PWA shell and bundled inventory, while `localStorage` retains only the last **completed** search (workplace, 500 m zone over an offline Singapore coastline layer, stop/journey details, original date, start time, and ride cap) without requiring sign-in or overwriting when a later search stops early.

## Getting started

Requires Bun 1.4.4 or newer and Node.js 24/26 for static-analysis tooling.

```sh
bun install
bun run build
bun run start
```

Open `http://127.0.0.1:3000/` in a browser (set `PORT=4173` to override). All PWA assets in `dist/public/` use relative `./` paths and can also be deployed directly to static hosting without the Bun server.

## Project layout

- `public/`: Source static assets (`index.html`, `styles.css`, `data/stops.tsv`).
- `dist/public/`: Runnable built output produced by `bun run build:pwa` (copies `public/` plus bundled scripts and vendor assets such as `leaflet.css`; run static asset audits such as `impeccable detect` against `dist/public/`).
- `src/**/__tests__/*.test.ts`: Unit tests executed by Bun (`bun run test:ci`).
- `e2e/*.test.ts`: Browser acceptance tests executed by Playwright (`bun run test:e2e`, which builds and serves `dist/public/`).

## Commands

| Command                     | Purpose                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `bun run dev`               | Build PWA assets and run the static server with Bun's watcher                                 |
| `bun run build:pwa`         | Bundle browser TypeScript/Service Worker and copy `public/` + `leaflet.css` to `dist/public/` |
| `bun run build`             | Typecheck, build PWA assets, and bundle the Bun static server into `dist/`                    |
| `bun run start`             | Serve `dist/public/` via `dist/index.js`                                                      |
| `bun run inventory:refresh` | Refresh `public/data/stops.tsv` from BusRouter SG and SGRailData                              |
| `bun run lint`              | Biome formatting, linting, accessibility, and import checks; warnings fail                    |
| `bun run fix`               | Apply Biome fixes, then Knip fixes                                                            |
| `bun run typecheck`         | Strict TypeScript checking without emitting files                                             |
| `bun run test`              | Run Bun's built-in unit test runner                                                           |
| `bun run test:ci`           | Run Bun unit tests with 90% line and function coverage gates                                  |
| `bun run test:e2e`          | Build and run Playwright Chromium browser acceptance tests (`e2e/`)                           |
| `bun run depcruise`         | Enforce dependency and architecture boundaries                                                |
| `bun run knip`              | Detect unused files, exports, and dependencies                                                |
| `bun run dupcheck`          | Reject duplication above 1%                                                                   |
| `bun run check`             | Run all six local quality gates                                                               |
| `bun run danger:ci`         | Enforce PR size and generated-artifact policies in GitHub CI                                  |

## Deployment (Cloudflare Pages)

[`.github/workflows/deploy-cloudflare-pages.yml`](.github/workflows/deploy-cloudflare-pages.yml) builds `dist/public/` and deploys automatically whenever a PR is merged into `main` (and supports manual triggers via `workflow_dispatch`). `public/_headers` configures Cloudflare Pages to serve `/sw.js` with `Cache-Control: no-cache`.

Configure these GitHub Actions repository secrets (pre-created with `REPLACE_ME` placeholders under **Settings → Secrets and variables → Actions**):

- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with **Cloudflare Pages — Edit** permission.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare Account ID.
- `CLOUDFLARE_PAGES_PROJECT_NAME`: Target Cloudflare Pages project name.

## Runtime dependencies

- [`leaflet`](https://leafletjs.com/) (`BSD-2-Clause`): Interactive map rendering, uniform-opacity SVG pane for 500 m catchment unions, offline GeoJSON coastline layer, and OneMap tile integration.

See [AGENTS.md](AGENTS.md) for contributor instructions and [CODING_STANDARDS.md](CODING_STANDARDS.md) for architecture and review standards.
