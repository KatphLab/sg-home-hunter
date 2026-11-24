---

version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

# House Hunter Surface Brief (`public/index.html`)

- **Scope & Mode:** Single-screen installable client-only PWA (`Operate` mode).
- **Audience & Job:** Singapore house hunters configuring and watching a live island-wide commute-zone search online (desktop/phone), and reopening the last completed housing-search zone offline at property viewings without signing in.
- **Constraints:** Relative `./` asset and manifest paths for static hosting; direct browser-to-OneMap auth (no proxy, no saved password, never log credentials/tokens, unreadable sign-in reports `"Couldn’t sign in to OneMap."`); exact `GLOSSARY.md` terms; OneMap attribution (`OneMap © contributors | Singapore Land Authority`); accessible stop/journey list synced with the map; safe DOM APIs only.

## Direction contract

THESIS: HDB Town Precinct Directory — a daylight-clear Singapore civic wayfinding workspace using rounded-square stop-ID plaques and uniform botanical-green 500 m patches, refusing property-portal card clutter and dark neon telemetry dashboards.

OWN-WORLD: Matte porcelain panels (`#F6F7F5`), warm concrete rail (`#E6E9E5`), botanical green (`#1B5E4B`) shell header and uniform-opacity 500 m catchment union, civic vermilion (`#C83E2B`) workplace marker, deep charcoal ink (`#1A2220`), 1 px architectural dividers (`#CFD5D0`), aligned tabular numerals, and unsoftened amber/red status tags (`Partial`, `Offline`, straight-line caveats).

STORY: The house hunter connects their OneMap account, checks the displayed Singapore search date, inventory date, and keep-open notice, launches a breadth-first search across the island, watches distant and nearby 500 m patches land live with separate tried and matching counts, inspects stop-level journey evidence on map or accessible list, and reopens the saved map offline at viewings without signing in.

FIRST VIEWPORT: Desktop: a 400 px left civic workspace rail (brand header, OneMap connection, workplace postal/station entry, office start and ride cap, visible search/inventory dates and keep-open notice, live tried-vs-matched ledger, searchable/filterable stop list) beside a full-height Leaflet map with flat-landmass offline coastline, uniform-opacity 500 m union shading, pinned straight-line legend (`Within 500 m of a qualifying stop.`), and selected-stop journey card. Mobile: map fills the first viewport (opening straight to the saved offline map) with a switchable bottom sheet/drawer for Search, Stops, and Journey details.

FORM: HDB Town Precinct Directory (candidate 3 of 7, seed:b55a98dd4ee7cdf5), raised by crisp flat offline landmass, strict tabular numerals, single-stop selection lift, and unsoftened status/caveat badges.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
