# 05: Reopen the last successful area check offline

**What to build:** Completing a successful area check leaves a verified map and journey details that can be reopened offline. A preview, unsuccessful area check or interrupted later search cannot erase it.

**Blocked by:** 03: Confirm one qualifying boarding in three checks.

**Status:** resolved

- [x] Reuse the existing last-completed-result flow to save only evidence from a successful area check with its workplace, constraints, date and selected-area scope. Label the saved result as an area check rather than a completed island-wide scan.
- [x] Keep estimates and pending checks in memory. Previewing, moving the circle, no candidates, no confirmed journey, routing failure, stopping or closing an unfinished check must leave the previous completed offline result intact.
- [x] Reload offline without signing in and retain selectable verified stops, actual journey details, original constraints and the area-check label. Do not present an old journey as proof for a different search date or inflate verified results with estimates.
- [x] Do not silently discard or migrate existing saved results as a shortcut. Reuse the present stored contract where possible. If a changed representation would invalidate user data, stop for approval before that cutover rather than inventing a legacy reader or migration.
- [x] Cover success, reload/offline viewing and subsequent interrupted/unsuccessful checks through browser-context network interception with the service worker active. Preserve prior offline-result behavior. Verify actual visible content rather than storage internals.
- [x] No new cross-session itinerary cache, IndexedDB, bulk download, background verification or offline new-search capability.

## Answer

`showProof` saves actual same-search evidence only at the successful-area boundary. The existing v1 snapshot/key stays intact, with optional `checkedArea` centre and confirmed boarding ID; existing snapshots remain directly readable without migration, invalidation or reset. Storage exceptions retain the visible successful journey and explicitly explain offline saving failed, outside the routing error boundary.

Restoration shows a saved-area label, original workplace/date/start/cap, accessible 500 m selected-centre scope and straight-line/non-island-wide explanation, selected-area map outline, verified map/list stops and the actual confirmed journey selected by default. No preview estimates or routing state are persisted; offline viewing needs no account.

Evidence:
- `skill://tdd` is unavailable; used the agreed browser/PWA acceptance seam.
- Worktree began at integration `3ef9c50`; reused root installed dependencies through a local `node_modules` symlink after the first asset build reported missing local Leaflet files.
- `bun run typecheck`: passed.
- `bun run build:pwa && bun build --target=bun --outdir=dist src/index.ts && bunx --no-install playwright test e2e/offline-area.test.ts`: initial 8 browser cases passed.
- `bunx --no-install playwright test e2e/offline-area.test.ts`: final **9 passed**, including additional routing-failure coverage and restored selected-area outline.
- Isolated fixture uses browser-context network interception with an active controlling service worker. Visible map/list/journey/date/constraints/scope assertions prove successful offline restoration and preservation through a subsequent preview, empty area, valid miss, expired sign-in, routing failure, Stop, closing pending work and quota failure. Quota failure remains a confirmed commute, not a routing error; the prior successful snapshot remains viewable offline.

No shared browser-suite, scheduler/controller/entrypoint/markup, docs/changelog or service-worker cache-version changes. Broad gates remain with the parent integration owner.
