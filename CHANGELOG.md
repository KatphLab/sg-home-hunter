# Changelog

## 2026-11-27

- Keep the selected workplace while filtering stations, block duplicate OneMap sign-ins, and leave the saved stop list visible when a workplace lookup fails.
- Fetch fresh app files when installing an updated offline cache.

## 2026-11-26

- Start with the workplace and live arrival window, connect OneMap inline, and return to the commute from an empty preview. Remove inventory dates from the interface and show the original search date only on verified journey details, including offline.
- Open mobile previews and saved checks on the map. Select and check a 500 m area from a dock below it, with a stop-name picker and one shared journey card.
- Keep failed/interrupted neighbourhood probes distinct after exhaustion, preserve workplace proof when filtering station names, reset keyboard selection after map clicks, and end failed worker planning. Save only the successful circle's verified evidence with distinct-stop counters; preserve restored scope through form edits and report non-sensitive offline-storage diagnostics.
- Continue neighbourhood checks in batches of at most three new planned departures, without repeating checked departures across overlapping areas. Reopen the last successful checked area and its verified journey evidence offline; estimates and unsuccessful checks stay unsaved.
- Add **Check within 500 m**: verify at most three planned departures, reuse same-search actual boarding evidence and stop normally on the first in-area proof. Show exact journeys outside the map for keyboard/mobile use; distinguish empty estimates, bounded misses, routing/sign-in errors and cancellation. Remove the obsolete global scheduler and its scheduler-only tests; retain qualification-rule tests and the existing offline snapshot loader without writing partial checks.
- Replace automatic global routing scans with a local, radius-limited estimated preview that pauses before routing. Distinguish ride-cap-margin time bands from qualifying journeys, support map or keyboard/mobile 500 m area selection, clear previews on changed inputs or session, and preserve the existing completed offline map.
- Limit direct OneMap requests to a straight-line radius based on the ride cap (13.7 km for 30 minutes). Keep qualifying stops outside the radius when an itinerary already proves them.
- Skip redundant OneMap requests when an itinerary confirms pickup at an intermediate stop and the remaining journey meets the ride cap and arrival window.
- Save a completed search offline when every stop with a failed routing request later has a confirmed journey. Unresolved failures still leave the previous offline result intact.
- Keep late bus departures and after-midnight trains eligible for verification. Bind first/last bus times to each visit in route order instead of guessing from nearby stops' clocks.
- Keep short LRT, MRT and bus journeys eligible when their estimated ride time exceeds the cap. OneMap's actual in-vehicle time decides whether they qualify.
- Count time spent aboard a stopped vehicle toward the ride cap when the passenger stays on for the next service.
- Preserve the previous offline result when Stop is pressed during the final routing request.
- Disable Start while resolving the workplace so a second submission cannot mix results from two searches.
- Keep Stop available while a browser worker plans departures. Stopping during planning leaves the last completed offline search intact.
- Preserve feasible feeder rides after equal-cost replacements, retain better over-cap estimates and probe materially different departure times even when their feasible windows overlap.
- Bound each loop ride at its alighting stop and use station- and direction-specific Circle Line first trains and weekday spur windows.

## 2026-11-25

- Align local quality gates and agent docs with CI: add non-short-circuiting `scripts/check-all.ts` (including `build`), add CI-matching `bun run semgrep`, disable Biome `noUnnecessaryConditions` due to its conflict with TypeScript `noUncheckedIndexedAccess`, ignore `.scratch/` cache artifacts, warn on oversized `src/` modules in `dangerfile.ts`, and deduplicate `AGENTS.md`.
- Switch production PWA commute searches from the 19-pass breadth-first scheduler to the calibrated backward commute search (`runBackwardCommuteSearch`), cutting requests and search time substantially while keeping OneMap as the confirmation oracle; remove the obsolete scheduler and prototype benchmark harness.
- Bundle compact BusRouter SG bus routes and first/last timings in `public/data/bus-network.tsv` (pre-cached by Service Worker `house-hunter-shell-v3`) and update `bun run inventory:refresh` to refresh both `stops.tsv` and `bus-network.tsv` together.
- Reuse confirmed boarding points within each commute search and check promising intermediate departures without assuming that passengers can board there.

## 2026-11-24

- Initialize House Hunter from `KatphLab/ts-bun-template`, preserving the existing commute design and local credentials file.
- Configure engineering skills for local Markdown issues, default triage labels, and single-context domain documentation.
- Replace `Makefile` with `justfile`; use `just install` for dependency and hook setup.
- Move the commute design to `docs/DESIGN.md` and update the README link.
- Replace the CLI design with the client-only [PWA product spec](.scratch/commute-zones/spec.md) and [commute glossary](GLOSSARY.md).
- Implement the client-only House Hunter PWA: Singapore public/observed holiday calendar, exact millisecond commute-rule engine, direct OneMap browser client, breadth-first island-wide search scheduler, bundled 5,426-stop inventory (`public/data/stops.tsv`), Leaflet 500 m union map with offline coastline fallback, synced accessible stops list, Service Worker shell caching, and offline retention of the last completed result.
- Add Bun unit tests for pure commute rules and static asset serving plus Playwright real-browser acceptance tests (`e2e/commute-zones.test.ts`), along with [PRODUCT.md](PRODUCT.md), [DESIGN.md](DESIGN.md), and `.impeccable/` artifacts.
- Extend Singapore public and observed holiday computation dynamically beyond 2028 and split browser search orchestration into `src/app/search-controller.ts`.

## 2026-11-06

- Enable weekly Dependabot pull requests for patch-only updates to all production and development packages using the native Bun ecosystem.
- Wait seven days after a package release before proposing version updates, satisfying the Semgrep cooldown policy without changing the weekly patch-only schedule.
- Leave dependency versions unchanged in this setup; updates require review and merging.

## 2026-11-02

- Create the Bun/TypeScript template from `ts-pnpm-template`, retaining its strict TypeScript, Biome, dependency-cruiser, Knip, jscpd, Semgrep, Danger, and Git-hook checks.
- Use Bun 1.4.4 for installation, development, bundling, and execution; resolve all development dependencies to their latest stable releases.
- Use Bun's built-in test runner with 90% line and function coverage; omit statement/branch thresholds and remove Vitest.
- Migrate Biome configuration to 2.6.4 without relaxing rules and deny dependency lifecycle scripts with an empty trust list.
- Adapt GitHub Actions and the unprivileged production container to Bun; pin actions to the latest release commits.
- Compile the TypeScript Danger policy with Bun before running it, since Danger's TypeScript loader requires a compiler API removed in TypeScript 7.
