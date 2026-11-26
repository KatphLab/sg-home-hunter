import type {
  CompletedSearchSnapshot,
  QualifiedStop,
} from '@lib/commute-types.js'
import { saveCompletedResult } from '@lib/saved-result-store.js'
import { haversineDistanceMeters } from '@lib/transit-network.js'
import { normalizeError } from '@utils/guards.js'
import {
  renderConstraintsSummary,
  renderCounters,
  renderStatusBadge,
} from './dom-render.js'
import { candidatesWithinArea } from './neighbourhood-preview.js'
import { type AppContext, selectStop } from './search-controller.js'

export const showOutcome = (ctx: AppContext, message: string): void => {
  ctx.els.areaResult.hidden = false
  const count = ctx.state.areaCheck?.checksPerformed ?? 0
  const checks = count === 1 ? 'check' : 'checks'
  ctx.els.areaResult.textContent = `${message} ${String(count)} ${checks} performed.`
  ctx.els.liveStatusRegion.textContent = ctx.els.areaResult.textContent
}

export const checkedStopCount = (
  departures: ReadonlySet<string>,
  stopIds: ReadonlySet<string>,
): number =>
  new Set(
    [...departures]
      .map((key) => key.split('@')[0])
      .filter((id) => id !== undefined && stopIds.has(id)),
  ).size

export const showProof = (ctx: AppContext, proof: QualifiedStop): void => {
  showOutcome(ctx, 'Confirmed a qualifying boarding within 500 m.')
  ctx.els.resultStatusTag.textContent = 'Area confirmed'
  selectStop(ctx, proof.stop.id)
  ctx.els.selectedStopCard.scrollIntoView({ block: 'nearest' })
  const { preview, selectedArea, inventory, areaCheck, matches } = ctx.state
  if (!preview || !selectedArea || !inventory) return
  const candidates = candidatesWithinArea(preview, selectedArea)
  const triedCount = checkedStopCount(
    areaCheck?.completedDepartures ?? new Set(),
    new Set(candidates.map((lead) => lead.stop.id)),
  )
  try {
    saveCompletedResult(window.localStorage, {
      version: 1,
      completedAtIso: new Date().toISOString(),
      inventoryDate: inventory.inventoryDate,
      workplace: preview.workplace,
      constraints: preview.constraints,
      triedCount,
      totalCount: candidates.length,
      matches: matches.filter(
        (entry) =>
          haversineDistanceMeters(entry.stop.point, selectedArea) <= 500,
      ),
      checkedArea: { centre: selectedArea, proofStopId: proof.stop.id },
    })
  } catch (error) {
    const diagnostic = normalizeError(error, 'Offline storage failed')
    console.error('Could not save offline area result', diagnostic.name)
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
  mapView.invalidateSize()
  mapView.fitToMatches(snapshot.workplace, snapshot.matches)
}
