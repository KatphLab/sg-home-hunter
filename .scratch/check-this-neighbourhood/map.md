# Check this neighbourhood

## Notes

- [Approved spec](spec.md).
- Integration branch: `feat/check-this-neighbourhood`.
- Frontier: work only on tickets whose blockers are resolved. Graph: 01 → 02 → 03 → {04, 05}.

## Decisions-so-far

- [01 — Live benchmark](issues/01-benchmark-three-checks.md): resolved. [Report](benchmark.md) found eight first-probe confirmations, two empty previews and two inconclusive areas after six probes. Keep three as the initial ceiling, not a claimed optimum or accuracy guarantee.
- Preview is estimated evidence only. Verification must find a qualifying boarding within the selected 500 m circle; outside-only proof does not answer that selection.
- Browser/PWA flow is the agreed acceptance seam. Preserve the existing completed offline result when previews or area checks do not succeed.

## Fog

- None gating implementation after the recorded benchmark. Unconfirmed benchmark areas are not proven unreachable.
