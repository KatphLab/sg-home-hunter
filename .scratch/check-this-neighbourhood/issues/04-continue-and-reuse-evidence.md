# 04: Continue checks and reuse overlapping evidence

**What to build:** A house hunter can spend another small batch of checks on an unconfirmed area without repeating earlier departures. Moving to an overlapping circle can reuse a proven boarding immediately.

**Blocked by:** 03: Confirm one qualifying boarding in three checks.

**Status:** ready-for-agent

- [ ] Offer **Check more departures** after a batch only while untried planned probes remain for that area. Continue the same deterministic ordering with at most three new logical probes per action, stopping on the first in-area proof.
- [ ] Preserve checked stop/departure identities and all proven boardings in memory across selections for the same workplace and constraints. An overlapping area's check must not repeat a previously checked departure and must succeed with zero requests when existing in-area proof is sufficient.
- [ ] Keep original evidence and date visible when reusing it. Do not treat a confirmation outside the new circle as an answer, infer pickup at an unproven stop, or expand verification into an automatic scan.
- [ ] Distinguish exhausted planned probes from a three-check miss. Errors remain distinct from valid responses without matches. Do not add retries beyond the existing transport behavior or report exhaustive unreachability.
- [ ] A changed workplace, search date, start time or ride cap starts a new verification session rather than reusing old qualifications. Do not persist credentials, tokens, previews or routing responses in IndexedDB.
- [ ] Prove continuation and reuse at the browser seam: first three checks miss, the next batch checks only new departures, later proof stops work, an overlapping circle adds no request, and changed constraints cannot reuse the old match as current evidence.
