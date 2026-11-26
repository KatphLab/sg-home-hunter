# Twelve-point neighbourhood benchmark

## Preregistered method and points

These points were recorded before any live routing response. Only sign-in, workplace postal lookup and local planner calculation had run. Residential street/block centres, not station coordinates, were selected from a fixed candidate list using estimated ride margin and candidate count, not verification outcomes. This is a purposive, small sample, not a representative accuracy study.

Fixed constraints: workplace **828608**, search date **2026-11-27**, office start **08:30 Singapore**, inclusive arrival window **08:15–08:30**, ride cap **30 minutes aboard**. Authorised current Singapore date: 2026-11-26. Resolved workplace: **1 PUNGGOL COAST ROAD DIGIPEN INSTITUTE OF TECHNOLOGY SINGAPORE SINGAPORE 828608**, **1.413307372328189, 103.9129643979305**. Bundled stop inventory: **2026-11-26**; bundled bus network: **2026-11-06**. Local preview has **1,421** estimated-under-cap leads within the **13,700 m** workplace request radius.

Each circle uses 500 m straight-line distance, not walking distance. Substantial margin means its best estimated lead is at most 20 minutes; near-cap means its best is over 20 and at most 30 minutes. Few-candidate areas have at most six leads, including zero. These are area strata based on summaries, not assertions that every departure achieves that time.

| ID  | Stratum            | Residential centre            | Latitude | Longitude | Estimated candidates | Planned probes | Best estimated ride (min) |
| --- | ------------------ | ----------------------------- | -------: | --------: | -------------------: | -------------: | ------------------------: |
| M1  | Substantial margin | Punggol Northshore residences |   1.4185 |  103.9020 |                    9 |             36 |                      1.15 |
| M2  | Substantial margin | Punggol Edgedale Plains homes |   1.4005 |  103.9120 |                   13 |             52 |                      1.84 |
| M3  | Substantial margin | Sengkang Rivervale homes      |   1.3910 |  103.9050 |                   20 |             80 |                      3.45 |
| M4  | Substantial margin | Hougang Avenue 8 homes        |   1.3760 |  103.8910 |                   21 |             84 |                      8.89 |
| N1  | Near cap           | Ang Mo Kio Avenue 10 homes    |   1.3680 |  103.8560 |                    7 |             28 |                     23.23 |
| N2  | Near cap           | Bishan Street 22 homes        |   1.3580 |  103.8460 |                    8 |             32 |                     24.23 |
| N3  | Near cap           | Tampines Street 43 homes      |   1.3590 |  103.9510 |                    8 |             32 |                     23.60 |
| N4  | Near cap           | Pasir Ris Drive 4 homes       |   1.3690 |  103.9590 |                    5 |             20 |                     25.42 |
| F1  | Few candidates     | Kovan Highland Road homes     |   1.3630 |  103.8810 |                    0 |              0 |                         — |
| F2  | Few candidates     | Sembawang Hills homes         |   1.3760 |  103.8310 |                    0 |              0 |                         — |
| F3  | Few candidates     | Lorong Ah Soo homes           |   1.3510 |  103.8850 |                    6 |             24 |                     16.43 |
| F4  | Few candidates     | Tampines Street 21 homes      |   1.3520 |  103.9500 |                    5 |             20 |                     23.60 |

Queue: filter `planBackwardLeads` to `estRideMs <= 30 minutes`, workplace distance <=13,700 m and centre distance <=500 m. Sort by estimated ride ascending, stable stop ID ascending; interleave each stop's first departure, then second, preserving planner departure order. No uncovered-stop fallback or hint sweep. Use `fetchTransitPlan` unchanged, including existing transport retry policy; count every fetch invocation as an HTTP attempt. Use `evaluateBoardings` unchanged and inventory stop identity to retain all proven boardings, including transfers/intermediates. Only proof within the selected circle succeeds. Hints alone are not proof.

Run all initial batches in table order, up to three previously untried logical probes each, stopping on first in-area proof. Retain same-search proof and tried departures for reuse. Then allow at most one further batch of three per first-batch miss; explicitly report untested remainder. A valid response with no qualifying boarding, a request/parsing failure and zero candidates remain separate outcomes. A 60-second abort bounds an individual logical request; no extra retry layer. This bounded experiment cannot establish unreachability, island-wide recall, a fixed latency or a 90% accuracy claim.

Source APIs: [`backward-planner.ts`](../../src/lib/backward-planner.ts), [`backward-search.ts`](../../src/lib/backward-search.ts) (existing radius), [`onemap-client.ts`](../../src/lib/onemap-client.ts) (authentication, lookup, routing and retries), [`commute-rules.ts`](../../src/lib/commute-rules.ts) (qualification), [`transit-network.ts`](../../src/lib/transit-network.ts) (distance and bundled network).

## Live results — 2026-11-26

Preparation completed at **18:45:29 Singapore**. Routing ran **18:46:39–18:47:03 Singapore** (10:46:39–10:47:03 UTC), using authorised account access loaded by `bun --env-file=/home/katph/personal/house-hunter/.env`. No credentials or tokens were printed or persisted. The requested **2026-11-27** date was routable: every routing response was HTTP 200 and the eight reported journeys passed the existing search-date and arrival-window qualification.

**8/12 areas (66.7%) confirmed within the initial three-probe budget**, or **8/10 (80%) among areas with estimated candidates**. All eight confirmed on their **first logical probe / first routing HTTP attempt**; none needed probes two or three. By stratum: substantial margin **4/4**, near-cap **3/4**, few candidates **1/4** (two had no candidates). No area succeeded through reused proof, so these confirmations are not inflated by a warmed proof store.

| Area | Initial probes / HTTP attempts | Additional probes / HTTP attempts | Result                               | Untried planned probes at stop |
| ---- | -----------------------------: | --------------------------------: | ------------------------------------ | -----------------------------: |
| M1   |                          1 / 1 |                             0 / 0 | Confirmed                            |                             35 |
| M2   |                          1 / 1 |                             0 / 0 | Confirmed at another actual boarding |                             51 |
| M3   |                          1 / 1 |                             0 / 0 | Confirmed                            |                             79 |
| M4   |                          1 / 1 |                             0 / 0 | Confirmed                            |                             83 |
| N1   |                          1 / 1 |                             0 / 0 | Confirmed                            |                             27 |
| N2   |                          1 / 1 |                             0 / 0 | Confirmed                            |                             31 |
| N3   |                          3 / 3 |                             3 / 3 | Not confirmed in six; inconclusive   |                             26 |
| N4   |                          1 / 1 |                             0 / 0 | Confirmed                            |                             19 |
| F1   |                          0 / 0 |                             0 / 0 | No estimated candidates; no routing  |                              0 |
| F2   |                          0 / 0 |                             0 / 0 | No estimated candidates; no routing  |                              0 |
| F3   |                          1 / 1 |                             0 / 0 | Confirmed                            |                             23 |
| F4   |                          3 / 3 |                             3 / 3 | Not confirmed in six; inconclusive   |                             14 |

Totals: **14 initial logical probes / 14 routing HTTP attempts**, followed by **6 additional probes / 6 attempts**. **20 routing HTTP attempts**, all HTTP 200, **zero transport retries, request failures, parsing/qualification exceptions, auth expiry or timeouts**. Preparation used one sign-in and one postal lookup; measurement used another sign-in, so **23 total OneMap HTTP calls including three non-routing calls**. Valid responses on both candidate-bearing misses contained proof outside their circles, not in-area proof; these were not errors or empty “no route” responses.

**Later confirmations: 0 observed** in the extra batch. Measurement stopped deliberately after six logical probes for N3 and F4, leaving respectively **26 and 14** planned probes untested. They are **not exhaustive misses**. F1/F2 have no planned probes, but this only means no local estimates, not no possible journey. None of the four unconfirmed points can be labelled unreachable.

### Actual qualifying journeys

All times below are Singapore time on **2026-11-27**. Arrival is at the resolved workplace, **including the final walk**. Ride is total time aboard, not elapsed journey duration; transfer wait and walking explain differences between boarding-to-arrival and ride duration. These actual journeys must not be reconstructed from unrelated planner summary fields.

| Area | Requested stop @ departure | Proven boarding (ID; name)       | Actual boarding | Workplace arrival | Ride (min) | Services       |
| ---- | -------------------------- | -------------------------------- | --------------- | ----------------- | ---------: | -------------- |
| M1   | 65629 @ 08:01:50           | 65629; Samudera Stn Exit A       | 08:04:56        | 08:17:22          |       7.78 | 84G            |
| M2   | PE6 @ 08:00:20             | 65311; Oasis Stn Exit B/Blk 617D | 08:08:53        | 08:21:06          |       5.32 | 381            |
| M3   | 65191 @ 07:43:26           | 65191; Bef Punggol Rd            | 07:53:23        | 08:17:53          |      10.28 | 118 → NE       |
| M4   | NE14 @ 08:03:46            | NE14; Hougang                    | 08:06:14        | 08:23:53          |       8.88 | NE             |
| N1   | 54291 @ 07:33:13           | 54291; Blk 564                   | 07:38:20        | 08:17:53          |      25.43 | 165 → NE       |
| N2   | 53241 @ 07:41:03           | 53241; Opp Blk 217               | 07:41:04        | 08:23:53          |      22.93 | 55 → CC → NE   |
| N4   | 77051 @ 07:19:34           | 77051; Blk 115                   | 07:43:24        | 08:29:53          |      24.82 | 109 → 39A → NE |
| F3   | 63299 @ 07:47:29           | 63299; Blk 115                   | 07:50:01        | 08:23:53          |      18.97 | 113 → NE       |

M2 demonstrates why response boarding identity matters: requesting Oasis rail station returned qualifying **bus stop 65311**, inside the circle. Proof from the whole response was retained in memory (23 distinct inventory boardings across the run), but outside-circle proof never stopped a missed area's queue. No intermediate hint was routed.

### Exact stopping points on candidate-bearing misses

These are logical probe orders, each with exactly one HTTP 200 attempt:

- **N3 initial:** `76361@07:21:01`, `76351@07:18:43`, `76209@07:16:38`. **Additional:** `76219@07:15:29`, `76341@07:16:25`, `76391@07:15:29`. Stop after this sixth probe, still in the first-departure round; 26 remain.
- **F4 initial:** `76141@07:23:04`, `76149@07:16:57`, `76159@07:16:55`. **Additional:** `76169@07:14:20`, `76409@07:13:11`, `76141@07:17:04`. The sixth probe starts the second-departure round only after all five stops' first departures; 14 remain.

Observed successful-area batches took approximately **0.18–1.51 seconds**; N3's initial/additional batches **5.12 / 4.72 seconds**, F4's **4.45 / 4.12 seconds**. These are one field run's timings, including local processing/rate spacing, not a latency promise.

## Conclusion

**Keep three as a useful initial ceiling, with early stop and explicit continuation.** It delivered a useful commute for eight areas with only eight calls; the two candidate-bearing misses spent three calls each rather than scanning their 32- and 20-probe queues. One additional batch changed neither missed answer, costing six more calls without new in-area proof. This run supports bounded work and honest “not confirmed in these checks” messaging, **not the optimality of exactly three**: all observed successes needed only one, and no late success was observed within the deliberately limited extension.

Estimated ride margin remains an estimate: for example M1's best summary was 1.15 minutes while its actual proven ride was 7.78 minutes. The selected points, shared workplace, single date and non-exhaustive misses prevent any general accuracy, recall or unreachability claim.

## Evidence and scope

The proof is this authorised live measurement, not a mocked test or production change. Temporary Bun preparation/measurement scripts were kept under `node_modules/.cache/check-this-neighbourhood-01/` and removed after use. Sanitised local measurement records remain there as `prepared.json` and `measurement.json` (ignored cache; no authentication data), recording timestamps, exact probe keys, HTTP status/attempt counts and qualified boardings. The report retains the human-readable evidence if that cache is cleared. No production code, dependencies, GTFS, persistence layer, routing engine or CI tests were changed.
