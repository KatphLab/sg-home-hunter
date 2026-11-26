# 03: Confirm one qualifying boarding in three checks

**What to build:** The selected circle has a **Check within 500 m** action. It checks up to three planned departures and returns as soon as one qualifying boarding in the area is proven, with an inspectable journey instead of a full neighbourhood scan.

**Blocked by:** 02: Preview estimated stops and select a neighbourhood.

**Status:** resolved

- [x] Build a deterministic queue from the selected area's preview candidates: shortest estimated ride first, stop ID tie-break; each stop's first planned departure before any second departure. Preserve the planner's departure ordering within a stop. A batch spends at most three previously untried stop/departure probes, not three total HTTP attempts inside transport retries.
- [x] Before routing, look for same-search evidence of any qualifying stop within an inclusive 500 m of the centre. Existing proof can answer even a circle with no estimated candidates. Otherwise an empty circle makes zero requests.
- [x] After each response, apply existing exact-boarding, pickup, interlining, ride-cap, search-date and arrival-window rules. Include the final walk in workplace arrival, but exclude walking and waiting from the ride cap. A proven in-area transfer or intermediate pickup can succeed even when it was absent from the preview.
- [x] Retain all proven boardings, but stop issuing requests only when at least one lies in the selected circle. Outside-only proof does not answer this selection. Stop by normal success, not by simulating cancellation. Do not start global passes, an uncovered-stop sweep, or unbudgeted intermediate-hint requests.
- [x] Show the exact confirmed stop, search date, boarding time, remaining services, ride time and workplace arrival. Keep estimated and verified points distinct; render verified housing-search-zone shading as evidence, not as a walking route from the selected point.
- [x] Distinguish no candidates, no qualifying journey in the completed checks, routing failure and expired sign-in. State the number of checks performed; never label an unconfirmed area unreachable. Do not silently use a failed request as negative journey evidence.
- [x] Stop is available during work. Changes to centre, workplace or constraints must not permit in-flight results to be displayed as the answer to another selection. Leave the previous completed offline evidence intact; this ticket does not persist a partial check.
- [x] Through browser acceptance tests, observe request order and three-check ceiling, a response with proof only outside the circle, then an in-area transfer/pickup that stops subsequent requests. Also cover no journey, empty circle, auth/network error, cancellation, changed selection and the exact destination station exception. Assert user outcomes and requests, not private queues.

## Answer

Added the first bounded area-check interaction. `src/app/area-check.ts` owns deterministic round-robin probing, response qualification through existing `evaluateBoardings`, first-in-area early success, whole-response proof retention, cached proof lookup before the empty-candidate outcome, and distinct error/result rendering. Existing OneMap transport retries remain unchanged: the browser network-failure case observes four HTTP attempts for one logical check. Hints never trigger requests.

The picker-adjacent actual journey includes the stop ID/name, date, boarding time, remaining services, aboard time and workplace arrival including the final walk. It is available in mobile Stops without the map. Selection changes cancel and clear the current answer; workplace/constraint/session changes invalidate the preview. Stale responses cannot publish proof. Verified shading continues to use actual boardings only. No snapshots are written by this ticket.

Removed `src/lib/backward-search.ts`, its obsolete scheduler-specific suite and unused progress/run types. Retained the shared `commute-rules.test.ts` evidence tests for exact station identity, actual boarding suffixes, search date, pickup rules and interlined dwell. Updated README, changelog and service-worker shell cache v8.

Evidence:
- `skill://tdd` is unavailable; used the agreed browser/PWA acceptance seam.
- `bun run typecheck && bun run build:pwa && bun build --target=bun --outdir=dist src/index.ts && bunx --no-install playwright test e2e/commute-zones.test.ts`: passed typecheck, asset/server build and **21 browser tests**. An initial run passed 20/21 and exposed an overbroad “unreachable” substring assertion against negative copy; user copy now says “Other qualifying journeys may exist,” and the unchanged assertion passes.
- Browser proof covers request order and three-check ceiling, retained checked departures, outside-only proof followed by an unestimated in-area transfer, both inclusive arrival boundaries and final walking time, overlapping/empty candidate proof reuse, empty circles, misses, auth/network errors and retry accounting, Stop, changed centre/workplace/start/cap/session, exact station exception, mobile actual journey access and unchanged saved offline evidence.
- Worktree began at `b79cf5b`; merged integration before editing (already up to date), then merged its current tip `7b453e7` (only ticket map update).

Ticket 04 owns `src/app/area-check.ts` (`checkSelectedArea`; internal `plannedProbes`, `runAreaBatch`, `retainBoardings`, `showProof`, `showOutcome`). Same-search state is `AppState.areaCheck: AreaCheckState` in `src/app/search-controller.ts`: `checkedDepartures`, `checksPerformed`, `hasRun`; all actual proof is `AppState.matches`. Controller-private selection/stop lifecycle resets the current answer but preserves checked keys and proof across area choices. Wire continuation in `public/index.html`, `src/app/dom-render.ts` and `src/app/main.ts`; no Check More action exists yet.

Ticket 05 retains ownership of existing snapshot load/render in `src/app/main.ts` (`loadCompletedResult` bootstrap), `src/app/search-controller.ts` (`applySnapshot`), `src/lib/saved-result-store.ts` and `CompletedSearchSnapshot` in `src/lib/commute-types.ts`. The successful area boundary is `showProof` in `area-check.ts`; no speculative persistence hook or callback was added. Existing saved v1 user data is untouched.

## Comments

Integrated review: attempted departure identities remain deduplicated, while completed evaluations are tracked separately. Failed or interrupted attempts remain explicitly incomplete when remaining departures are exhausted and when an overlapping selection reuses that exhausted queue. No retries added. Live counters count distinct evaluated estimated stops, not logical probes; qualifying boardings remain a separate unit.

Proof: affected browser suites passed 41 cases; typecheck and `bun run fix` passed. Failure/Stop then queue exhaustion/reselection regressions assert eight unique requests and honest incomplete outcomes. Recorded complexity gates were resolved by extracting routing-error presentation and checked-area parsing, without configuration changes or assertion removal.
