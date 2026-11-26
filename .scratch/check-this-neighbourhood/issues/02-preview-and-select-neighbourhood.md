# 02: Preview estimated stops and select a neighbourhood

**What to build:** A house hunter submits a workplace and immediately sees a local estimated map instead of starting a routing scan. They can select an area by pointer or keyboard and inspect its candidate count before spending requests.

**Blocked by:** 01: Benchmark three checks at 12 residential points.

**Status:** resolved

- [x] Reuse the existing worker and selected workplace, search date, office start and ride cap. Search submission must stop after preview: zero OneMap routing requests. Postal lookup may still make a request; resolving a station remains local.
- [x] Show only planned leads whose estimated ride fits the cap and whose stop is inside the existing workplace-centred request radius. Do not turn uncovered stops or theoretical minimum ride times into estimated qualifying journeys. Preserve the exact destination station's zero-ride exception.
- [x] Show lightweight estimated points with distinct time bands: at least ten minutes of ride-cap margin versus less. These are estimates, not confidence scores or verified arrival times. Do not combine independently summarized ride time, transfers and departure times into a purported journey.
- [x] Reserve existing verified stop details, counts and housing-search-zone shading for actual proof. Do not label estimates as qualifying stops or create thousands of focusable estimate markers.
- [x] Map selection and a labelled searchable stop-name/ID picker can set a centre. Both present the number of eligible stops within an inclusive 500 m straight-line circle and make the selected area clear through outline and accessible text. Selecting or moving it makes no routing request.
- [x] The picker and selection summary work on mobile without the map and by keyboard. Explain straight-line proximity, not a walking route. Do not require users to interact with a feature that has not landed yet; the routing action is added by the next ticket.
- [x] Replacing the preview after workplace/constraint changes must not mix old estimates with new ones or overwrite the last completed offline evidence.
- [x] Prove the user flow through the agreed browser acceptance seam with browser-context request interception: preview without routing, distinct estimated/verified displays, map and keyboard selection, and an empty circle. No fixed planner duration or private collection assertions.

## Answer

Search now stops after the existing planner worker and filtered local preview. Canvas points distinguish the two ride-margin bands without per-estimate buttons or verified shading. The map and searchable native stop picker share the same inclusive 500 m candidate calculation and accessible summary. The picker is available in both mobile Search and Stops views. No verification button or routing scheduler is wired into production.

Input edits, Stop and Disconnect invalidate the in-memory preview and abort/ignore pending work, including postal lookups that resolve after cancellation. Only the exact destination station receives existing zero-ride proof. Completed offline snapshots retain their v1 shape and loader; previews never write storage. The service-worker shell cache advances to v7 so the new browser assets replace the old scan UI.

Evidence:
- `skill://tdd` is unavailable; used the agreed browser/PWA seam.
- `bun run build`: typecheck and PWA/server build passed. Its initial browser run exposed an incorrectly modelled fixture (a 35-minute bus delta falls back to a distance estimate); the fixture now uses a 28-minute delta, whose estimated ride genuinely exceeds 30 minutes.
- `bun run typecheck && bunx --no-install playwright test e2e/commute-zones.test.ts`: passed, **7 browser tests**. Covers zero routing with postal lookup, both estimate bands, outer-radius/over-cap/uncovered exclusions, equivalent keyboard/map area counts, empty areas, mobile picker, exact station identity, form/session cancellation, real sign-in/lookup errors, unchanged offline snapshot and offline map/journey use without sign-in.
- `git merge feat/check-this-neighbourhood`: already up to date.

Ticket 03 contracts: `NeighbourhoodPreview` contains the resolved `workplace`, fixed `constraints` and eligible original `BackwardLead[]` (including planner departure order). `createNeighbourhoodPreview(plan, workplace, constraints)` applies the radius/cap filter; `candidatesWithinArea(preview, centre)` applies inclusive 500 m distance. `AppState.preview` and `AppState.selectedArea` hold active in-memory selection; `selectArea` handles pointer/picker selection and `invalidatePreview` clears it. Existing `state.matches` remains actual proof only. The global scanner module remains untouched for replacement in 03, but its production controller wiring is removed.

## Comments

Integrated review regressions resolved: map clicks rebuild the picker so keyboard users can return to the same stop; station-name filtering retains an unchanged exact workplace and its proof/departures; worker errors end planning and update the live region. The ten-minute margin predicate is shared by text and colors. Browser acceptance now observes actual blue and amber canvas pixels (not private planner data), without fixed waits.

Proof: `bun run typecheck`, `bun run fix` (Biome and Knip), and `bunx --no-install playwright test e2e/commute-zones.test.ts e2e/offline-area.test.ts` passed, 41 browser cases. `skill://tdd` remains unavailable; tests use the agreed browser seam. Initial proof exposed the native listbox active-option behavior; rebuilding its options, rather than merely clearing selectedIndex, fixes returning by keyboard.
