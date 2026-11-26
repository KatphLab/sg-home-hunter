# 01: Benchmark three checks at 12 residential points

**What to build:** Evidence that a bounded neighbourhood check is useful before building its UI. Measure how often three planned departure probes find at least one qualifying boarding within 500 m, and how often later probes change that answer. Use the approved neighbourhood-search spec; do not replace or extend the production scanner in this research ticket.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] Use workplace 828608, search date 2026-11-27, office start 08:30 and ride cap 30 minutes for every point. Record the resolved workplace coordinates and inventory/network dates. If the date is no longer routable, document that limitation rather than silently substituting a date or presenting estimates as live results.
- [x] Record 12 residential points before observing verification outcomes: four with substantial estimated ride margin, four near the cap, and four with few candidates. Do not use only station centres or select favourable points after seeing results.
- [x] Build each area's queue from estimated-under-cap leads within both the workplace request radius and 500 m of the point. Sort stops by shortest estimated ride, then stop ID. Try each first planned departure before each second departure. Limit the first batch to three untried logical probes; do not trigger a global scan or an intermediate-hint sweep.
- [x] Evaluate real responses using existing qualification rules and stop when any qualifying boarding lies within the circle. Retain other proven boardings for same-search reuse without treating outside proof as success for this point.
- [x] For first-batch misses, continue through remaining planned departures or explicitly record where measurement stopped. Report first-batch confirmations, calls/probes to first confirmation, later confirmations, inconclusive areas and failures separately. Count actual HTTP attempts as well as logical probes; no unreachability or island-wide recall claim.
- [x] Use authorised live access without logging credentials or tokens. This is not a CI test. Put the human-readable measurements and method in one feature research report; keep ephemeral responses out of the ticket directory. If tooling cannot complete live measurement, report what failed and do not invent benchmark results.
- [x] Conclude whether three probes is a useful initial budget, with observed tradeoffs rather than an assumed 90% accuracy or fixed latency. Do not add a feed download, persistence layer or routing engine.

## Answer

Evidence: [twelve-point live benchmark](../benchmark.md), measured 2026-11-26 against authorised 2026-11-27 journeys. The twelve residential points and strata were recorded before routing. Workplace coordinates, inventory/network dates, queue order, actual qualifying boardings, all miss probe keys and stopping points are in the report.

**8/12 areas confirmed within three checks (8/10 with candidates), all on the first probe.** Four substantial-margin, three near-cap and one few-candidate area confirmed. Two zero-candidate areas made no requests. Two candidate-bearing misses remained inconclusive after one additional batch each, with 26 and 14 probes untested. No later confirmations were observed. **20 logical probes / 20 routing HTTP attempts**, all HTTP 200, no retries or failures; 23 OneMap calls including sign-ins and postal lookup.

Three is a useful initial ceiling with early stopping and user-controlled continuation; this small bounded sample neither establishes that three is optimal nor measures island-wide recall. No production code changed. Live research output is the proof; no builds, lint, tests or formatters were run. Throwaway scripts were removed; sanitised measurements remain only in ignored `node_modules/.cache/check-this-neighbourhood-01/`.
