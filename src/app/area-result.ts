import type {
  CompletedSearchSnapshot,
  QualifiedStop,
} from '@lib/commute-types.js'
import {
  formatJourneyTimes,
  formatRideMinutes,
  formatServiceChain,
} from '@lib/journey-format.js'
import { saveCompletedResult } from '@lib/saved-result-store.js'
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
  const { preview, selectedArea, inventory, areaCheck, matches } = ctx.state
  if (!preview || !selectedArea || !inventory) return
  try {
    saveCompletedResult(window.localStorage, {
      version: 1,
      completedAtIso: new Date().toISOString(),
      inventoryDate: inventory.inventoryDate,
      workplace: preview.workplace,
      constraints: preview.constraints,
      triedCount: areaCheck?.checkedDepartures.size ?? 0,
      totalCount: areaCheck?.checkedDepartures.size ?? 0,
      matches,
      checkedArea: { centre: selectedArea, proofStopId: proof.stop.id },
    })
  } catch {
    ctx.els.areaResult.textContent +=
      ' Could not save this area for offline viewing. Your previous saved result is unchanged.'
    ctx.els.liveStatusRegion.textContent = ctx.els.areaResult.textContent
  }
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
  if (snapshot.checkedArea) {
    const { centre, proofStopId } = snapshot.checkedArea
    mapView.setAreaSelection(centre, false)
    els.resultStatusTag.textContent = 'Saved offline area check'
    const scope = `Checked area: within 500 m of ${centre.latitude.toFixed(5)}, ${centre.longitude.toFixed(5)} (straight-line distance, not a walking route). Only verified boardings are shown; this is not an island-wide scan.`
    els.activeConstraintsSummary.textContent += ` ${scope}`
    els.liveStatusRegion.textContent = `Saved offline area check. ${scope}`
    selectStop(ctx, proofStopId)
  } else {
    selectStop(ctx, null)
  }
}
