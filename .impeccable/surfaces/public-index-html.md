---

version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

# House Hunter Surface Brief (`public/index.html`)

- **Scope & Mode:** Single-screen installable client-only PWA (`Operate` mode).
- **Audience & Job:** Singapore house hunters comparing estimated commutes, checking one neighbourhood near a potential home, and reopening the last verified check at a viewing.
- **Constraints:** Relative `./` asset and manifest paths for static hosting; direct browser-to-OneMap auth (no proxy, no saved password, never log credentials/tokens, unreadable sign-in reports `"Couldn’t sign in to OneMap."`); exact `GLOSSARY.md` terms; OneMap attribution (`OneMap © contributors | Singapore Land Authority`); accessible stop/journey list synced with the map; safe DOM APIs only.

## Direction contract

THESIS: HDB Town Precinct Directory — a daylight-clear Singapore civic wayfinding workspace using rounded-square stop-ID plaques and uniform botanical-green 500 m patches, refusing property-portal card clutter and dark neon telemetry dashboards.

OWN-WORLD: Matte porcelain panels (`#F6F7F5`), warm concrete rail (`#E6E9E5`), botanical green (`#1B5E4B`) shell header and uniform-opacity 500 m catchment union, civic vermilion (`#C83E2B`) workplace marker, deep charcoal ink (`#1A2220`), 1 px architectural dividers (`#CFD5D0`), aligned tabular numerals, and unsoftened amber/red status tags (`Partial`, `Offline`, straight-line caveats).

STORY: Set a workplace, office start and ride cap. Connect OneMap inline without losing the commute, then preview estimated stops. Pick an area by map or stop name, or edit the commute if no estimates appear. Read the original checked date with the verified journey, including offline.

FIRST VIEWPORT: “Where do you work?” leads the rail beside the desktop map and the first mobile screen. Show the arrival window and one next action, not account fields or technical dates. On mobile, preview and restored evidence open on the map. A dock holds the area picker, check action and journey card. Estimate points, the dashed selection and green verified zones remain distinct.

FORM: HDB Town Precinct Directory (candidate 3 of 7, seed:b55a98dd4ee7cdf5), raised by crisp flat offline landmass, strict tabular numerals, single-stop selection lift, and unsoftened status/caveat badges.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
