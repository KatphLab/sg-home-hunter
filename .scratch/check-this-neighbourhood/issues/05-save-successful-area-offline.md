# 05: Reopen the last successful area check offline

**What to build:** Completing a successful area check leaves a verified map and journey details that can be reopened offline. A preview, unsuccessful area check or interrupted later search cannot erase it.

**Blocked by:** 03: Confirm one qualifying boarding in three checks.

**Status:** ready-for-agent

- [ ] Reuse the existing last-completed-result flow to save only evidence from a successful area check with its workplace, constraints, date and selected-area scope. Label the saved result as an area check rather than a completed island-wide scan.
- [ ] Keep estimates and pending checks in memory. Previewing, moving the circle, no candidates, no confirmed journey, routing failure, stopping or closing an unfinished check must leave the previous completed offline result intact.
- [ ] Reload offline without signing in and retain selectable verified stops, actual journey details, original constraints and the area-check label. Do not present an old journey as proof for a different search date or inflate verified results with estimates.
- [ ] Do not silently discard or migrate existing saved results as a shortcut. Reuse the present stored contract where possible. If a changed representation would invalidate user data, stop for approval before that cutover rather than inventing a legacy reader or migration.
- [ ] Cover success, reload/offline viewing and subsequent interrupted/unsuccessful checks through browser-context network interception with the service worker active. Preserve prior offline-result behavior. Verify actual visible content rather than storage internals.
- [ ] No new cross-session itinerary cache, IndexedDB, bulk download, background verification or offline new-search capability.
