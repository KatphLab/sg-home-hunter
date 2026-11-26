# House Hunter

House Hunter is an installable, client-only PWA for comparing estimated Singapore commute areas, then checking for a qualifying boarding near a selected point. See [the neighbourhood-search spec](.scratch/check-this-neighbourhood/spec.md), [GLOSSARY.md](GLOSSARY.md) for domain terms, [PRODUCT.md](PRODUCT.md) for durable product context, and [DESIGN.md](DESIGN.md) for the HDB Town Precinct Directory design system.

## Features

- **Direct OneMap browser sign-in:** Connects with your own OneMap email and password directly from the browser (no backend proxy or shared token; passwords are never stored or logged).
- **Workplace & search rules:** Supports 6-digit Singapore postal codes (preserving leading zeros) or exact line-specific MRT/LRT stations, defaults the search date to the next non-holiday Singapore workday (including observed Sunday-to-Monday public holidays), enforces an inclusive 15-minute arrival window (`[officeStart - 15m, officeStart]`), and separates in-vehicle ride time from walking and transfers.
- **Local estimated preview:** A browser worker plans departures backward from the workplace, then pauses without OneMap routing calls. Postal workplaces still require a lookup. Estimates must fit the ride cap and the existing `1.2 km + 25 km/h × ride cap in hours` workplace radius. Blue points have at least ten minutes of estimated ride-cap margin; amber points have less. Neither band is confidence or verified journey evidence.
- **Check a neighbourhood:** Click the map or use the keyboard/mobile stop picker to centre a 500 m straight-line area. **Check within 500 m** tries up to three previously untried planned departures, shortest estimated rides first and each stop's first departure before its second. It stops on the first actual qualifying boarding inside the circle. **Check more departures** continues with another batch only while untried probes remain. Transfers and explicit intermediate pickups can prove the area; overlapping areas reuse same-search evidence without repeating requests. Inspect actual boarding, services, date, ride time and workplace arrival beside the picker. Empty estimates, unconfirmed checks, routing failures and expired sign-in remain distinct; none proves an area unreachable.
- **Offline viewing:** The Service Worker caches the PWA shell and bundled inventory. A successful area check saves its verified map and original constraints locally for reopening without sign-in. A preview, unsuccessful or interrupted check never replaces the previous completed result. Estimates are not saved as verified journeys.

## Getting started

Requires Bun 1.4.4 or newer and Node.js 24/26 for static-analysis tooling.

```sh
bun install
bun run build
bun run start
```

Open `http://127.0.0.1:3000/` in a browser (set `PORT=4173` to override). All PWA assets in `dist/public/` use relative `./` paths and can also be deployed directly to static hosting without the Bun server.

## Project layout

- `public/`: Source static assets (`index.html`, `styles.css`, `data/stops.tsv`, `data/bus-network.tsv`).
- `dist/public/`: Runnable built output produced by `bun run build:pwa` (copies `public/` plus bundled scripts and vendor assets such as `leaflet.css`; run static asset audits such as `impeccable detect` against `dist/public/`).
- `src/**/__tests__/*.test.ts`: Unit tests executed by Bun (`bun run test:ci`).
- `e2e/*.test.ts`: Browser acceptance tests executed by Playwright (`bun run test:e2e`, which builds and serves `dist/public/`).

## Commands

| Command                     | Purpose                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`               | Build PWA assets and run the static server with Bun's watcher                                                                         |
| `bun run build:pwa`         | Bundle browser TypeScript/Service Worker and copy `public/` + `leaflet.css` to `dist/public/`                                         |
| `bun run build`             | Typecheck, build PWA assets, and bundle the Bun static server into `dist/`                                                            |
| `bun run start`             | Serve `dist/public/` via `dist/index.js`                                                                                              |
| `bun run inventory:refresh` | Refresh `public/data/stops.tsv` and `public/data/bus-network.tsv` from BusRouter SG and SGRailData                                    |
| `bun run lint`              | Biome formatting, linting, accessibility, and import checks; warnings fail                                                            |
| `bun run fix`               | Apply Biome fixes, then Knip fixes                                                                                                    |
| `bun run typecheck`         | Strict TypeScript checking without emitting files                                                                                     |
| `bun run test`              | Run Bun's built-in unit test runner                                                                                                   |
| `bun run test:ci`           | Run Bun unit tests with 90% line and function coverage gates                                                                          |
| `bun run test:e2e`          | Build and run Playwright Chromium browser acceptance tests (`e2e/`)                                                                   |
| `bun run depcruise`         | Enforce dependency and architecture boundaries                                                                                        |
| `bun run knip`              | Detect unused files, exports, and dependencies                                                                                        |
| `bun run dupcheck`          | Reject duplication above 1%                                                                                                           |
| `bun run check`             | Run all seven local quality gates (`lint`, `typecheck`, `test:ci`, `depcruise`, `knip`, `dupcheck`, `build`) without short-circuiting |
| `bun run semgrep`           | Run Semgrep with the full CI rulesets (`owasp-top-ten`, `nodejs`, `typescript`, `secrets`, `.semgrep.yml`)                            |
| `bun run danger:ci`         | Enforce PR size and generated-artifact policies in GitHub CI                                                                          |

## Deployment (Cloudflare Pages)

[`.github/workflows/deploy-cloudflare-pages.yml`](.github/workflows/deploy-cloudflare-pages.yml) builds `dist/public/` and deploys automatically whenever a PR is merged into `main` (and supports manual triggers via `workflow_dispatch`). `public/_headers` configures Cloudflare Pages to serve `/sw.js` with `Cache-Control: no-cache`.

Configure these under **Settings → Secrets and variables → Actions** (pre-created with `REPLACE_ME` placeholders):

- **Secret:** `CLOUDFLARE_API_TOKEN` — Cloudflare API token with **Cloudflare Pages — Edit** permission.
- **Variables:**
  - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare Account ID.
  - `CLOUDFLARE_PAGES_PROJECT_NAME` — Target Cloudflare Pages project name.

## Runtime dependencies

- [`leaflet`](https://leafletjs.com/) (`BSD-2-Clause`): Interactive map rendering, uniform-opacity SVG pane for 500 m catchment unions, offline GeoJSON coastline layer, and OneMap tile integration.

## Data attribution

- Bundled bus stops, service routes, and first/last bus timings (`public/data/stops.tsv`, `public/data/bus-network.tsv`) incorporate data from **Land Transport Authority (LTA) DataMall**, accessed via [BusRouter SG](https://data.busrouter.sg/), and are used under the terms of the [Singapore Open Data Licence v1.0](https://www.lta.gov.sg/content/ltagov/en/footer/data-gov-sg-terms-of-use.html).
- Bus timetables use the [DataMall route rows](https://data.busrouter.sg/v1/raw/bus-routes.datamall.json): service, direction and stop sequence identify each visit, even when a route returns to the same stop. The planner uses straight-line distance at a speed ceiling to rule out over-cap rides; estimated travel and dwell times guide departure probes, not the minimum ride time.
- Each timed visit has three first/last clock pairs: weekday, Saturday, and Sunday/public holiday. `-` means no service for that day; a visit without timings has unknown hours and remains eligible for verification.
- MRT and LRT station codes and coordinates incorporate data from [cheeaun/sgraildata](https://github.com/cheeaun/sgraildata).
- Circle Line first loop trains use station- and direction-specific times from [Land Transport Guru](https://landtransportguru.net/train/ccl/). Weekday through-service windows are anchored to [Esplanade's timetable](https://landtransportguru.net/esplanade-station/); other station offsets and reverse-direction peak bounds are estimates, not published departures.

See [AGENTS.md](AGENTS.md) for contributor instructions and [CODING_STANDARDS.md](CODING_STANDARDS.md) for architecture and review standards.
