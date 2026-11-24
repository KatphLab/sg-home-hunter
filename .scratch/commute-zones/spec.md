# House Hunter: find places to live near a qualifying commute

Status: ready-for-agent

## Problem Statement

“I know where I work and when I need to arrive. Which neighbourhoods should I look in?” A house hunter may not know Singapore stop IDs or have a shortlist of residential areas. Distance from work alone is misleading: a distant stop on a direct service can offer a better commute than a much closer one.

## Solution

An installable, client-only PWA takes a workplace, office start time and ride cap. It uses the house hunter’s OneMap account to find qualifying stops for one displayed workday. The primary result is a map of areas within 500 m of those stops. A selectable stop explains the recommendation with a specific journey. The last completed map remains usable offline.

## User Stories

1. As a house hunter, I want to connect my own OneMap account with my email and password, so that I can search without obtaining API tokens myself.
2. As a house hunter, I want to enter a six-digit workplace postal code, so that I can search for a commute to a building.
3. As a house hunter, I want to select an exact MRT/LRT station as my workplace, so that the destination can be a station rather than a postal address.
4. As a commuter, I want to set my office start time and ride cap independently, so that time spent transferring does not consume my allowance for time aboard vehicles.
5. As a commuter, I want to see the exact search date before starting, so that I know which day the journey demonstrates.
6. As a house hunter, I want an island-wide search without uploading an inventory or choosing a neighbourhood, so that I can discover places I would not have thought to check.
7. As a house hunter, I want to see the inventory date, so that I know how current the candidate stops are.
8. As a phone user, I want to know before starting that closing the app stops the search, so that I can choose when to run it.
9. As a house hunter, I want to see each qualifying area as it is found, so that I need not wait for the whole search to get useful leads.
10. As a house hunter, I want distant stops to get a first departure check before nearby stops get another, so that early results are not confined to the area around work.
11. As a house hunter, I want to distinguish the number of stops tried from the number with a match, so that I can judge how far the search has progressed.
12. As a house hunter, I want to stop when I have enough leads and see that the result is partial, so that I can leave without mistaking it for a finished search.
13. As a house hunter, I want to see my workplace and the patches within 500 m of qualifying stops, so that I can compare neighbourhoods geographically.
14. As a house hunter, I want the map to label that distance as straight-line proximity, so that I do not mistake a nearby flat across a canal for a verified short walk.
15. As a commuter, I want to select a named stop and see its ID, boarding time, services and arrival time, so that I can understand why it qualified.
16. As a user who cannot use the map, I want an accessible list of the same stops and journeys, so that I can evaluate the same recommendations.
17. As a commuter, I want a station workplace to count as a place I can reach by bus and on foot, so that I am not restricted to journeys on its rail line.
18. As a house hunter at a viewing, I want to reopen my last completed geographic result, date and constraints offline without signing in again, so that I can use it on site.
19. As a returning user, I want an interrupted search to leave my previous completed result intact, so that starting another search does not destroy my offline map.

## Implementation Decisions

- **Account boundary.** Run the search in the browser and send sign-in credentials directly to OneMap. Require a connected account for a new search, not for reading a saved result. Use tokens after sign-in; do not save the password when a token suffices or log credentials or tokens. If the browser cannot read the sign-in response, say “Couldn’t sign in to OneMap,” not “Wrong password.”
- **Workplace and date.** Resolve the exact postal code, preserving leading zeros, or use the selected line-specific station’s point. Bundle a dated island-wide stop inventory. Default the search date to the first Monday–Friday strictly after today in Singapore that is not a public holiday, including observed holidays. Evaluate one displayed date, not a typical week.
- **Qualifying journey.** The first transit boarding must be at the exact candidate stop. Boarding and arrival at the workplace must occur on the search date. Sum all in-vehicle intervals, excluding walking and waiting; the sum must not exceed the ride cap. Include the final walk in arrival. The arrival window is inclusive from 15 minutes before office start through office start. A traveller cannot qualify an earlier arrival by waiting at work.
- **Station identity.** The exact destination station qualifies with zero ride time, at office start, without a routing request. Another line ID at the same point is not the same qualifying stop. A postal workplace does not qualify a coincident stop automatically.
- **Search order and lifecycle.** Try one departure per candidate before revisiting unmatched candidates. Keep the first qualifying journey per stop and move on. Aim to check the full inventory; respect provider limits without imposing a fixed request-count cutoff. Before starting, show “Keep the app open while searching. Closing it stops the search.” Show tried/total and matches separately. Stopping early produces a partial result; one attempt per stop does not itself finish the search.
- **Housing-search zone.** Mark the workplace separately. Shade the union of 500 m straight-line circles around qualifying stops. Merge overlaps visually, preserve disconnected patches, and keep individual stops selectable. Label the shading “Within 500 m of a qualifying stop.” An unshaded place is not proven unreachable. Present each journey as one match for the displayed date, not the fastest, latest or most frequent service.
- **Offline result.** Retain the last completed search on-device. Its workplace, housing-search zone, stops and journey details must remain usable without online map tiles. Show its original date, office start time and ride cap. Replace it only when another search completes, not when one starts, stops or is closed.

## Testing Decisions

Use two agreed seams. Test what a commuter can observe, not component structure, storage keys, internal function calls or pixel-perfect map snapshots.

1. **Browser acceptance seam — the PWA as a whole.** Exercise sign-in, destination entry, search, map/list selection, user stop, closure and offline reopening through the UI. Control the browser clock, connectivity, a small dated inventory and OneMap responses; never require real credentials in automated tests. A useful scenario has a distant stop qualify on the first pass and a nearby one only on a later departure. The distant patch must appear while the search is running; tried and matched counts must differ. Select a stop in an overlap and in a disconnected patch, and verify the corresponding journey in the map and accessible list. Complete search A, interrupt search B, then reopen offline: A’s geography, evidence and constraints must still be usable. Also cover unreadable sign-in responses without attributing them to a wrong password.
2. **Pure commute-rule seam — date selection and qualification.** Give the rules fixed dates, stops and itinerary times; assert the resulting search date or qualification. Cover Friday before an observed Monday holiday; an exact station versus a different line ID at its point; an initial walk to a different boarding stop; and a final walk that changes arrival. At a 09:00 start and 30-minute cap, arrivals at 08:45 and 09:00 and exactly 30 minutes of riding are inclusive. A millisecond outside either bound does not qualify. A journey with 28 minutes riding and 10 minutes transferring can qualify at 08:58; a 12-minute ride arriving at 08:44 cannot.

The existing Bun tests demonstrate assertions on observable output from the scaffold. There is no existing PWA browser suite or commute-rule module to extend. Use Bun’s test runner for the pure rules; exercise browser behaviour in a real browser.

## Out of Scope

Property listings, evaluating a particular home, routing the walk from a flat, guaranteeing exhaustive coverage or daily reliability, ranking every departure, five-weekday confirmation, searches that continue after closing the PWA, new searches offline, and a backend proxy or shared OneMap account.

## Further Notes

A local WebKit browser signed in directly to OneMap and read an authenticated transit plan containing one itinerary. This established feasibility from localhost, not from the eventual production origin. The [commute glossary](../../GLOSSARY.md) defines the domain terms used here.
