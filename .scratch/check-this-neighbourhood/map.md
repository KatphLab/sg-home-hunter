# Check this neighbourhood

## Notes

- [Approved spec](spec.md).
- Integration branch: `feat/check-this-neighbourhood`.
- Frontier: work only on tickets whose blockers are resolved. Graph: 01 → 02 → 03 → {04, 05}.

## Decisions-so-far

- [01 — Live benchmark](issues/01-benchmark-three-checks.md): resolved. [Report](benchmark.md) found eight first-probe confirmations, two empty previews and two inconclusive areas after six probes. Keep three as the initial ceiling, not a claimed optimum or accuracy guarantee.
- [02 — Estimated preview](issues/02-preview-and-select-neighbourhood.md): resolved. Search now pauses after local planning; estimate bands and pointer/keyboard area selection make no routing calls. Browser proof covers the preview, cancellation and preservation of the existing offline result.
- [03 — Bounded verification](issues/03-confirm-first-boarding.md): resolved. The first in-area qualifying boarding ends a batch; outside-only proof, empty estimates, misses, routing errors and cancellation remain distinct. Twenty-one browser checks cover the flow and mobile journey details.
- [04 — Continuation and reuse](issues/04-continue-and-reuse-evidence.md): resolved. Explicit continuation spends at most three new probes, reports exhausted queues and reuses overlapping proof without a request. Typecheck and eight focused browser checks passed.
- Preview is estimated evidence only. Verification must find a qualifying boarding within the selected 500 m circle; outside-only proof does not answer that selection.
- Browser/PWA flow is the agreed acceptance seam. Preserve the existing completed offline result when previews or area checks do not succeed.

## Fog

- None gating implementation after the recorded benchmark. Unconfirmed benchmark areas are not proven unreachable.
