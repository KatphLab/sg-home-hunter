# 01: Benchmark three checks at 12 residential points

**What to build:** Evidence that a bounded neighbourhood check is useful before building its UI. Measure how often three planned departure probes find at least one qualifying boarding within 500 m, and how often later probes change that answer. Use the approved neighbourhood-search spec; do not replace or extend the production scanner in this research ticket.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Use workplace 828608, search date 2026-11-27, office start 08:30 and ride cap 30 minutes for every point. Record the resolved workplace coordinates and inventory/network dates. If the date is no longer routable, document that limitation rather than silently substituting a date or presenting estimates as live results.
- [ ] Record 12 residential points before observing verification outcomes: four with substantial estimated ride margin, four near the cap, and four with few candidates. Do not use only station centres or select favourable points after seeing results.
- [ ] Build each area's queue from estimated-under-cap leads within both the workplace request radius and 500 m of the point. Sort stops by shortest estimated ride, then stop ID. Try each first planned departure before each second departure. Limit the first batch to three untried logical probes; do not trigger a global scan or an intermediate-hint sweep.
- [ ] Evaluate real responses using existing qualification rules and stop when any qualifying boarding lies within the circle. Retain other proven boardings for same-search reuse without treating outside proof as success for this point.
- [ ] For first-batch misses, continue through remaining planned departures or explicitly record where measurement stopped. Report first-batch confirmations, calls/probes to first confirmation, later confirmations, inconclusive areas and failures separately. Count actual HTTP attempts as well as logical probes; no unreachability or island-wide recall claim.
- [ ] Use authorised live access without logging credentials or tokens. This is not a CI test. Put the human-readable measurements and method in one feature research report; keep ephemeral responses out of the ticket directory. If tooling cannot complete live measurement, report what failed and do not invent benchmark results.
- [ ] Conclude whether three probes is a useful initial budget, with observed tradeoffs rather than an assumed 90% accuracy or fixed latency. Do not add a feed download, persistence layer or routing engine.
