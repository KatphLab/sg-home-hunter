# 04: Continue checks and reuse overlapping evidence

**What to build:** A house hunter can spend another small batch of checks on an unconfirmed area without repeating earlier departures. Moving to an overlapping circle can reuse a proven boarding immediately.

**Blocked by:** 03: Confirm one qualifying boarding in three checks.

**Status:** resolved

- [x] Offer **Check more departures** after a batch only while untried planned probes remain for that area. Continue the same deterministic ordering with at most three new logical probes per action, stopping on the first in-area proof.
- [x] Preserve checked stop/departure identities and all proven boardings in memory across selections for the same workplace and constraints. An overlapping area's check must not repeat a previously checked departure and must succeed with zero requests when existing in-area proof is sufficient.
- [x] Keep original evidence and date visible when reusing it. Do not treat a confirmation outside the new circle as an answer, infer pickup at an unproven stop, or expand verification into an automatic scan.
- [x] Distinguish exhausted planned probes from a three-check miss. Errors remain distinct from valid responses without matches. Do not add retries beyond the existing transport behavior or report exhaustive unreachability.
- [x] A changed workplace, search date, start time or ride cap starts a new verification session rather than reusing old qualifications. Do not persist credentials, tokens, previews or routing responses in IndexedDB.
- [x] Prove continuation and reuse at the browser seam: first three checks miss, the next batch checks only new departures, later proof stops work, an overlapping circle adds no request, and changed constraints cannot reuse the old match as current evidence.

## Answer

Added the explicit **Check more departures** action, preserving the existing deterministic round-robin queue and same-search checked identities. Each action spends at most three new logical probes. Success hides continuation immediately; exhausted queues report that all planned departures were checked without claiming unreachability. Errors keep their distinct routing/auth messages and unchanged transport retry behavior. Selection changes hide the old continuation action; overlapping checks retain and display the original actual journey/date with zero requests.

Shared contract: `AreaCheckState` adds `hasMore: boolean`; it is selection-local availability, reset on selection/session changes. Existing `checkedDepartures` and `matches` remain session-wide in-memory evidence. `AppElements` adds `checkMoreButton`. No snapshot, persistence, data-model, cache-version or documentation changes.

Proof:
- `skill://tdd` unavailable; used the agreed real browser/PWA seam.
- `bun run typecheck`: passed.
- Initial asset preparation found missing worktree `node_modules`; linked the existing root dependencies, without installing packages.
- `bun run build:pwa && bun build --target=bun --outdir=dist src/index.ts && bunx --no-install playwright test e2e/commute-zones.test.ts --grep 'continues only|a later batch|starts fresh verification|reports (auth|network)'`: **8 passed**.
- Browser evidence observes 3/3/2 fresh-probe batches and exhaustion, exact round-robin request origins, no duplicates after reselecting an exhausted overlap, later proof stopping the second batch at two calls, unchanged actual evidence/date reused with zero calls, all four changed constraints starting fresh, and auth/network errors remaining distinct from misses.
- Worktree started at integration `3ef9c50`; integration tip is merged before handoff.

## Comments

Integrated review: continuation preserves attempted identities separately from successful evaluations, so no-repeat behavior cannot turn failed/aborted probes into negative evidence. Browser regressions exhaust the remaining queue after failure and Stop, then reselect an overlapping circle and assert the incomplete warning with zero new requests. Station-name filtering also preserves both checked departures and exact-station proof. Existing workplace/constraint changes still invalidate.

Proof: both affected suites passed, 41 browser cases; typecheck and `bun run fix` passed. Complexity-heavy test branches were separated by scenario action/assertion helpers without dropping coverage.
