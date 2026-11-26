# Check this neighbourhood: preview estimates, verify one commute

Status: ready-for-agent

## Problem Statement

A house hunter comparing a few neighbourhoods wants to know which ones are worth visiting and whether there is at least one workable boarding nearby. Today, submitting the workplace starts checking departures across the search radius. For postal code 828608, a 30-minute ride cap and an 08:30 start, that meant 2,844 candidate stops before the user had picked a neighbourhood. Finishing that scan answers a much larger question than the house hunter asked.

## Solution

Show an estimated map as soon as the local planner finishes. Let the user pick a point and choose **Check within 500 m**. Try up to three planned departures, stopping as soon as one itinerary proves a qualifying stop in that circle. Show the actual boarding, services, ride time and workplace arrival. If nothing is confirmed, let the user decide whether another three checks are worthwhile. A preview needs no OneMap *routing* calls; resolving a postal workplace is still a lookup.

## User Stories

1. As a house hunter, I want to see estimated stops before any routing requests, so that I can decide where to look without waiting for an area-wide scan.
2. As a commuter, I want to distinguish stops comfortably inside my ride cap from borderline estimates, so that I know where to start looking.
3. As a house hunter, I want estimates to look different from verified housing-search zones, so that I do not mistake a prediction for a journey I can take.
4. As a map user, I want to select a point and see how many candidates are within 500 m, so that I can check the area around a potential home rather than a whole district.
5. As a keyboard or mobile list user, I want to centre an area on a stop by name or ID and perform the same check, so that map gestures are optional.
6. As a commuter, I want the search to try promising nearby stops before repeatedly checking the same one, so that a quick check explores more than one boarding option.
7. As a house hunter, I want requests to stop after the first qualifying boarding in my circle, so that finding one useful commute does not start a larger scan.
8. As a commuter, I want the exact stop, search date, boarding time, services, time aboard and arrival shown, so that I can judge the commute for myself.
9. As a house hunter, I want overlapping areas to reuse boardings already proven in this search, so that moving the selection does not repeat work.
10. As a commuter, I want to distinguish “no estimate here,” “not confirmed in these checks” and “routing failed,” so that none is mistaken for “unreachable.”
11. As a house hunter, I want to request more checks without repeating the first ones, so that I control how much time to spend on each neighbourhood.
12. As a returning user, I want previews and interrupted checks to leave my last completed verified map intact, so that it remains useful offline.

## Implementation Decisions

- **Preview, then pause.** Reuse the planner worker, bundled inventory, selected workplace, search date, office start and ride cap. Apply the existing workplace-centred request radius and include planned leads with estimated ride time at or below the ride cap. Do not treat an uncovered stop, a minimum theoretical ride time, or an unverified transfer as an estimated qualifying journey. Keep the exact destination station’s existing zero-ride exception.
- **Display what the planner actually knows.** Show lightweight estimated points and distinguish estimates with at least ten minutes of ride-cap margin from those with less; these are time bands, not confidence scores. Do not combine the summary’s best ride time, fewest transfers and departure probes into a purported itinerary: they may come from different paths. Keep verified 500 m shading, journey details and counts separate from estimates.
- **Select before spending requests.** A map click or labelled, searchable stop picker sets the centre. Show the candidate count and a 500 m straight-line outline or equivalent text. This circle measures proximity to the selected point, not a walking route and not distance from the workplace. Selecting, moving or viewing it does not trigger routing. Provide the action and result outside the map, without making every estimate a tab stop.
- **Use one bounded queue per area.** Order eligible stops by shortest estimated ride first, with a stable stop-ID tie-break. Try each stop’s first planner-provided departure before its second, using the existing order of departures within each stop. A quick check spends at most three previously untried stop/departure probes. This is a budget of logical checks, not HTTP attempts inside a transport retry. Do not start the ordinary global scan, uncovered-stop sweep, or an unbudgeted chain of intermediate-stop hints.
- **Stop on evidence, not on the request origin.** First look for an already proven boarding at most 500 m from the centre. Otherwise evaluate each response with the existing qualification rules: exact boarding identity, search date, total ride cap and workplace arrival inside the inclusive arrival window, including the final walk. Retain proven boardings from the entire response. A proven transfer or intermediate pickup *inside* the circle is sufficient even if it was not in the preview. Proof only *outside* the circle is reusable elsewhere but cannot make this area succeed.
- **Make outcomes actionable.** Show existing proof even when there are no estimated candidates. Otherwise, zero candidates means zero requests. After successful probes without proof, report how many checks ran, not that no journey exists. Offer **Check more departures** only while untried probes remain; continue in batches of up to three. Distinguish request failures and expired sign-in from a valid response with no qualifying journey. Stop or changing the active search must not display stale evidence as the result of a new selection.
- **Reuse within the search, not across dates.** Reuse checked departures and proven boardings across overlapping circles under the same workplace and constraints. Keep the preview and pending work in memory. A preview, unsuccessful check or interruption must not replace the existing offline result. A completed successful area check can save its verified evidence through the existing offline-result flow; identify it as a checked area, not a completed island-wide scan. Do not require old saved results to be discarded.

## Testing Decisions

- **One agreed acceptance seam: the existing browser/PWA flow.** Intercept OneMap at browser-context level as existing acceptance tests do, including when the service worker is active. Assert what the user can see and do, the departure requests actually sent, and the verified evidence displayed. Do not assert private planner collections, marker implementation or a fixed rendering time.
- Preview a postal workplace: allow its lookup, assert zero routing calls, and distinguish estimated from verified stops. Choose an area by map and by keyboard; both must offer the same candidate count, action and accessible result. Cover an empty circle.
- With multiple stops and departures, assert round-robin probe order, the three-check ceiling and continuation with new departures. Give one response a qualifying boarding only outside the selection: the search must continue. Then return an in-area transfer or intermediate pickup: verification must stop and display its actual journey. Select an overlapping area and confirm no further call is necessary.
- Exercise no qualifying itinerary, failed routing, cancellation and changed selection. Verify that an unsuccessful or interrupted check does not overwrite the prior offline result and estimates do not appear offline as verified journeys. Preserve the exact destination station exception.
- **Run a separate 12-point field benchmark before building the full UI.** Use the same resolved workplace, date, ride cap and start time for every point. Select and record four residential points with substantial estimated ride margin, four near the cap, and four with few candidates, before seeing verification outcomes. For each, run the proposed quick check; for misses, continue through remaining planned departures for that area or record where measurement stopped. Report areas confirmed within three checks, calls to first confirmation, later confirmations missed by the quick check, and request failures separately. Record actual HTTP calls as well as logical probes. Use authorised live access, not CI. A later miss is not proof of unreachability; this benchmark neither establishes island-wide recall nor promises a fixed success rate.

## Out of Scope

A downloadable GTFS database, a new routing engine, IndexedDB or a new cross-session OneMap response cache, automatically verifying every estimate, background scans, property listings, turn-by-turn walking routes, or claiming estimates meet a 90% accuracy target. Do not expand the existing offline feature into an itinerary archive.

## Further Notes

For 828608 on 27 November 2026 (08:15–08:30 arrival window, 30-minute ride cap), the local preview calculation produced 1,421 estimates within 13.7 km. A 500 m circle around Hougang station contained 21 estimates and 84 planned departures. These are observations, not acceptance fixtures or live confirmations. They explain why selecting an area alone is insufficient: stopping after one useful journey and capping work on misses are the changes that save requests.
