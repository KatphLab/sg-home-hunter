# 03: Confirm one qualifying boarding in three checks

**What to build:** The selected circle has a **Check within 500 m** action. It checks up to three planned departures and returns as soon as one qualifying boarding in the area is proven, with an inspectable journey instead of a full neighbourhood scan.

**Blocked by:** 02: Preview estimated stops and select a neighbourhood.

**Status:** ready-for-agent

- [ ] Build a deterministic queue from the selected area's preview candidates: shortest estimated ride first, stop ID tie-break; each stop's first planned departure before any second departure. Preserve the planner's departure ordering within a stop. A batch spends at most three previously untried stop/departure probes, not three total HTTP attempts inside transport retries.
- [ ] Before routing, look for same-search evidence of any qualifying stop within an inclusive 500 m of the centre. Existing proof can answer even a circle with no estimated candidates. Otherwise an empty circle makes zero requests.
- [ ] After each response, apply existing exact-boarding, pickup, interlining, ride-cap, search-date and arrival-window rules. Include the final walk in workplace arrival, but exclude walking and waiting from the ride cap. A proven in-area transfer or intermediate pickup can succeed even when it was absent from the preview.
- [ ] Retain all proven boardings, but stop issuing requests only when at least one lies in the selected circle. Outside-only proof does not answer this selection. Stop by normal success, not by simulating cancellation. Do not start global passes, an uncovered-stop sweep, or unbudgeted intermediate-hint requests.
- [ ] Show the exact confirmed stop, search date, boarding time, remaining services, ride time and workplace arrival. Keep estimated and verified points distinct; render verified housing-search-zone shading as evidence, not as a walking route from the selected point.
- [ ] Distinguish no candidates, no qualifying journey in the completed checks, routing failure and expired sign-in. State the number of checks performed; never label an unconfirmed area unreachable. Do not silently use a failed request as negative journey evidence.
- [ ] Stop is available during work. Changes to centre, workplace or constraints must not permit in-flight results to be displayed as the answer to another selection. Leave the previous completed offline evidence intact; this ticket does not persist a partial check.
- [ ] Through browser acceptance tests, observe request order and three-check ceiling, a response with proof only outside the circle, then an in-area transfer/pickup that stops subsequent requests. Also cover no journey, empty circle, auth/network error, cancellation, changed selection and the exact destination station exception. Assert user outcomes and requests, not private queues.
