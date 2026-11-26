# 02: Preview estimated stops and select a neighbourhood

**What to build:** A house hunter submits a workplace and immediately sees a local estimated map instead of starting a routing scan. They can select an area by pointer or keyboard and inspect its candidate count before spending requests.

**Blocked by:** 01: Benchmark three checks at 12 residential points.

**Status:** ready-for-agent

- [ ] Reuse the existing worker and selected workplace, search date, office start and ride cap. Search submission must stop after preview: zero OneMap routing requests. Postal lookup may still make a request; resolving a station remains local.
- [ ] Show only planned leads whose estimated ride fits the cap and whose stop is inside the existing workplace-centred request radius. Do not turn uncovered stops or theoretical minimum ride times into estimated qualifying journeys. Preserve the exact destination station's zero-ride exception.
- [ ] Show lightweight estimated points with distinct time bands: at least ten minutes of ride-cap margin versus less. These are estimates, not confidence scores or verified arrival times. Do not combine independently summarized ride time, transfers and departure times into a purported journey.
- [ ] Reserve existing verified stop details, counts and housing-search-zone shading for actual proof. Do not label estimates as qualifying stops or create thousands of focusable estimate markers.
- [ ] Map selection and a labelled searchable stop-name/ID picker can set a centre. Both present the number of eligible stops within an inclusive 500 m straight-line circle and make the selected area clear through outline and accessible text. Selecting or moving it makes no routing request.
- [ ] The picker and selection summary work on mobile without the map and by keyboard. Explain straight-line proximity, not a walking route. Do not require users to interact with a feature that has not landed yet; the routing action is added by the next ticket.
- [ ] Replacing the preview after workplace/constraint changes must not mix old estimates with new ones or overwrite the last completed offline evidence.
- [ ] Prove the user flow through the agreed browser acceptance seam with browser-context request interception: preview without routing, distinct estimated/verified displays, map and keyboard selection, and an empty circle. No fixed planner duration or private collection assertions.
