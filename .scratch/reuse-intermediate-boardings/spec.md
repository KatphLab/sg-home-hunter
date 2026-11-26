# Confirm downstream boarding stops from one OneMap itinerary

Status: ready-for-agent

## Problem Statement

A housing seeker waits for the scanner to query a stop even when an earlier response already shows that they could board there and reach the workplace on time. Today, a returned journey can confirm its boarding and transfer stops, but intermediate stops with usable departure times are treated only as leads for another request.

## Solution

If a traveller boards at A, rides through B and transfers at C, use that same itinerary to answer the question “Could I board at B instead?” Count B as a qualifying stop without another OneMap call when the response establishes that this trip accepts passengers at B and that the journey from B qualifies. This is evidence about a specific departure, not an estimate about every stop on the route.

## User Stories

1. As a housing seeker, I want one itinerary to confirm every eligible intermediate boarding it proves, so that I spend less time waiting for the search.
2. As a commuter, I want B assessed from its own departure, so that a long ride from A does not hide a short enough ride from B.
3. As a commuter, I want the ride cap applied across all remaining transit legs, so that a short first leg does not mask a long onward ride.
4. As a commuter, I want boarding time, services and ride time shown from B, so that the details describe the journey I would actually take.
5. As a commuter, I want the same workplace arrival, including the final walk, so that a reused journey still meets my arrival window on the search date.
6. As a housing seeker, I want the exact directed bus stop or line-specific rail station identified, so that the map does not qualify the wrong boarding point.
7. As a commuter, I want express pass-throughs and drop-off-only visits excluded as boarding evidence, so that I am not sent to catch a vehicle I cannot board.
8. As a housing seeker, I want uncertain pickup information checked rather than assumed, so that qualifying stops remain trustworthy.
9. As a housing seeker, I want a confirmed stop counted once and its pending probes skipped, so that repeated sightings neither inflate the results nor waste requests.

## Implementation Decisions

- Extend itinerary evaluation to produce ordinary qualifying journeys for intermediate boardings on a returned transit leg. Require an exact inventory stop ID, affirmative evidence of ordinary pickup for that visit, and a usable departure on the search date within the leg. A missing pickup field, an unknown value, or the mere absence of a no-pickup flag is not affirmative evidence. Do not infer a visit from route topology.
- Compute time aboard from B’s departure through the end of its leg, plus time aboard on all subsequent transit legs. Keep existing interlining rules. Exclude transfer waiting and walking from the ride cap; retain them in the original workplace arrival. Apply the existing inclusive ride cap and arrival window, date and walk-limit checks.
- Evaluate each intermediate departure before rejecting its upstream boarding as over cap. Use the remaining services in travel order, including the service boarded at B; do not report services taken before B.
- Reuse the existing match and request handling. Once B qualifies, include it in the normal results and skip any outstanding targeted check or planned departure probe for it. Do not claim savings for requests already made.
- Preserve the targeted check when the exact stop and departure make a usable hint but pickup is uncertain. A prohibited pickup is neither proof nor a hint for that departure; another service or departure may still qualify that stop. Missing timing is not a reason to invent a probe time or suppress an independently planned probe.
- No new result category, OneMap endpoint, persistence format or user control.

## Testing Decisions

- Use the existing commute-search verification boundary only, as agreed. Supply representative OneMap responses through the existing route callback. Observe requested stops and departures and returned qualifying journeys, not internal queues or helper invocations. Existing transfer-reuse and transitive-hint scenarios are the prior art.
- Give the search an upstream itinerary on which A exceeds the cap, B allows pickup and meets the cap exactly, and C is a transfer before a final walk. Assert B’s exact identity, boarding time, remaining services, ride time and workplace arrival. Schedule a later probe for B; assert the upstream request alone confirms B and C.
- Cover multiple eligible intermediate visits in a single response. If an earlier response already queued a hint for B, subsequent proof must yield one match and no B request.
- Distinguish explicit pickup, unknown pickup with a usable departure, and prohibited pickup. Only the first qualifies directly; the second needs independent confirmation; the third must not trigger a request from that visit. Do not grant matches to unlisted stops on the same route, unresolved IDs or visits without usable times.
- Reject a suffix that exceeds the ride cap and an itinerary outside the arrival window or on the wrong search date. Assert outcomes, not elapsed wall time. No browser test or live OneMap call is required for acceptance.

## Out of Scope

Distance-based pruning, assuming nearby stops qualify, deriving downstream times from the bundled timetable, changing search order or rate limits, and changing the housing-search zone. This shortcut makes no claim about trips that do not expose enough boarding evidence.

## Further Notes

The acceptance measure is one fewer request when a proven intermediate boarding would otherwise be queried, with the same qualification rules as a separately verified journey. Overall savings depend on response detail and scan order; no percentage speedup is assumed.
