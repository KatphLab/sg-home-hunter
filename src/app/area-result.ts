import type {
  CompletedSearchSnapshot,
  QualifiedStop,
} from '@lib/commute-types.js'
import {
  formatJourneyTimes,
  formatRideMinutes,
  formatServiceChain,
} from '@lib/journey-format.js'
import {
  renderConstraintsSummary,
  renderCounters,
  renderStatusBadge,
} from './dom-render.js'
import { type AppContext, selectStop } from './search-controller.js'

export const showOutcome = (ctx: AppContext, message: string): void => {
  ctx.els.areaResult.hidden = false
  ctx.els.areaResult.textContent = `${message} ${String(ctx.state.areaCheck?.checksPerformed ?? 0)} checks performed.`
  ctx.els.liveStatusRegion.textContent = ctx.els.areaResult.textContent
}

export const showProof = (ctx: AppContext, proof: QualifiedStop): void => {
  const times = formatJourneyTimes(proof.journey)
  ctx.els.areaJourney.textContent = `${proof.stop.id} ${proof.stop.name} — ${proof.journey.searchDate}. Board ${times.boarding}; ${formatServiceChain(proof.journey)}; ride ${formatRideMinutes(proof.journey.rideMs)}; workplace arrival ${times.arrival}, including final walk. Verified 500 m shading is straight-line proximity to this boarding, not a walking route from your selection.`
  ctx.els.areaJourney.hidden = false
  showOutcome(ctx, 'Confirmed a qualifying boarding within 500 m.')
  ctx.els.resultStatusTag.textContent = 'Area confirmed'
  selectStop(ctx, proof.stop.id)
}

export const applySnapshot = (
  ctx: AppContext,
  snapshot: CompletedSearchSnapshot,
): void => {
  const { els, mapView, state } = ctx
  state.workplace = snapshot.workplace
  state.matches = snapshot.matches
  mapView.clearStops()
  mapView.setWorkplace(snapshot.workplace)
  for (const entry of snapshot.matches) mapView.addQualifyingStop(entry)
  mapView.fitToMatches(snapshot.workplace, snapshot.matches)
  renderStatusBadge(els.resultStatusTag, 'saved')
  renderCounters(
    els,
    snapshot.triedCount,
    snapshot.totalCount,
    snapshot.matches.length,
  )
  renderConstraintsSummary(
    els,
    snapshot.workplace,
    snapshot.constraints.searchDate,
    snapshot.constraints.officeStart,
    snapshot.constraints.rideCapMinutes,
  )
  selectStop(ctx, null)
}
