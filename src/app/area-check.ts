import type { BackwardLead } from '@lib/backward-planner.js'
import { evaluateBoardings } from '@lib/commute-rules.js'
import type {
  Coordinates,
  OneMapAccount,
  QualifiedStop,
  SearchConstraints,
  Stop,
} from '@lib/commute-types.js'
import { fetchTransitPlan, OneMapAuthError } from '@lib/onemap-client.js'
import { normalizeError } from '@utils/guards.js'
import { checkedStopCount, showProof } from './area-result.js'
import { renderCounters } from './dom-render.js'
import {
  candidatesWithinArea,
  isWithinArea,
  type NeighbourhoodPreview,
} from './neighbourhood-preview.js'
import {
  type AppContext,
  type AreaCheckState,
  refreshStopList,
  showOutcome,
  syncAccountUi,
  syncConnectivity,
} from './search-controller.js'

const proofWithinArea = (
  ctx: AppContext,
  centre: Coordinates,
): QualifiedStop | undefined =>
  ctx.state.matches.find((entry) => isWithinArea(entry.stop.point, centre))

const planAreaBatch = (
  leads: readonly BackwardLead[],
  { checkedDepartures, completedDepartures }: AreaCheckState,
) => {
  const rounds = leads.reduce(
    (max, lead) => Math.max(max, lead.candidateDepartures.length),
    0,
  )
  const probes = []
  let incompleteCount = 0
  for (let round = 0; round < rounds; round += 1) {
    for (const lead of leads) {
      const departure = lead.candidateDepartures[round]
      if (!departure) continue
      const key = `${lead.stop.id}@${departure}`
      if (!checkedDepartures.has(key)) {
        probes.push({ stop: lead.stop, departure, key })
      } else if (!completedDepartures.has(key)) {
        incompleteCount += 1
      }
    }
  }
  return { probes, incompleteCount }
}

const retainBoardings = (
  ctx: AppContext,
  itineraries: readonly unknown[],
  constraints: SearchConstraints,
  stopsById: ReadonlyMap<string, Stop>,
): void => {
  // Parse everything before publishing: malformed routes are failures, not negative evidence.
  const journeys = itineraries.flatMap(
    (raw) => evaluateBoardings(constraints, raw).journeys,
  )
  const matches = new Map(
    ctx.state.matches.map((entry) => [entry.stop.id, entry]),
  )
  for (const journey of journeys) {
    const stop = stopsById.get(journey.stopId)
    if (stop && !matches.has(stop.id)) {
      const match = { stop, journey }
      matches.set(stop.id, match)
      ctx.mapView.addQualifyingStop(match)
    }
  }
  ctx.state.matches = [...matches.values()]
  refreshStopList(ctx)
}

const runAreaBatch = async (
  ctx: AppContext,
  preview: NeighbourhoodPreview,
  centre: Coordinates,
  account: OneMapAccount,
  areaCheck: AreaCheckState,
  controller: AbortController,
  leads: readonly BackwardLead[],
): Promise<void> => {
  const stopsById = new Map(
    ctx.state.inventory?.stops.map((stop) => [stop.id, stop]),
  )
  const candidateIds = new Set(preview.leads.map((lead) => lead.stop.id))
  const { probes, incompleteCount } = planAreaBatch(leads, areaCheck)
  areaCheck.hasMore = probes.length > 0
  for (const [index, { stop, departure, key }] of probes.entries()) {
    areaCheck.checkedDepartures.add(key)
    areaCheck.hasMore = index + 1 < probes.length
    areaCheck.checksPerformed += 1
    showOutcome(ctx, 'Checking planned departures within 500 m.')
    const result = await fetchTransitPlan({
      start: stop.point,
      end: preview.workplace.point,
      searchDate: preview.constraints.searchDate,
      departureTimeHHMMSS: departure,
      accessToken: account.accessToken,
      signal: controller.signal,
    })
    if (controller !== ctx.state.abortController) return
    retainBoardings(ctx, result.itineraries, preview.constraints, stopsById)
    areaCheck.completedDepartures.add(key)
    renderCounters(
      ctx.els,
      checkedStopCount(areaCheck.completedDepartures, candidateIds),
      preview.leads.length,
      ctx.state.matches.length,
    )
    const proof = proofWithinArea(ctx, centre)
    if (proof) {
      areaCheck.hasMore = false
      showProof(ctx, proof)
      return
    }
    if (areaCheck.checksPerformed === 3) break
  }
  const exhaustion =
    incompleteCount > 0
      ? `No untried planned departures remain. ${String(incompleteCount)} attempted checks failed or were interrupted; these are not negative journey evidence.`
      : 'All planned departures for this area have been checked.'
  showOutcome(
    ctx,
    areaCheck.hasMore
      ? 'No commute confirmed. Other qualifying journeys may exist.'
      : `No commute confirmed. ${exhaustion} Other qualifying journeys may exist.`,
  )
}

const showRoutingError = (ctx: AppContext, error: unknown): void => {
  if (error instanceof OneMapAuthError) {
    ctx.state.account = null
    showOutcome(
      ctx,
      'Sign-in expired. Connect OneMap again; failed routing is not evidence of no journey.',
    )
    syncAccountUi(ctx)
  } else {
    showOutcome(
      ctx,
      `Routing failed: ${normalizeError(error, 'Unable to check this area.').message} This is not evidence of no journey.`,
    )
  }
}

const finishAreaCheck = ({ state, els }: AppContext): void => {
  const focusResult = document.activeElement === els.stopAreaButton
  state.abortController = null
  els.stopAreaButton.hidden = true
  if (focusResult) els.areaResult.focus({ preventScroll: true })
}

export const checkSelectedArea = async (ctx: AppContext): Promise<void> => {
  const { state, els } = ctx
  const { preview, selectedArea, inventory, account, areaCheck } = state
  if (
    !preview ||
    !selectedArea ||
    !inventory ||
    !account ||
    !areaCheck ||
    (areaCheck.hasRun && !areaCheck.hasMore) ||
    state.abortController ||
    !navigator.onLine
  )
    return
  const controller = new AbortController()
  state.abortController = controller
  areaCheck.checksPerformed = 0
  areaCheck.hasRun = true
  els.checkAreaButton.disabled = true
  els.stopAreaButton.hidden = false
  els.areaPicker.open = false
  els.stopAreaButton.focus({ preventScroll: true })
  syncConnectivity(ctx)
  try {
    const existing = proofWithinArea(ctx, selectedArea)
    if (existing) {
      showProof(ctx, existing)
      return
    }
    const leads = candidatesWithinArea(preview, selectedArea).sort(
      (a, b) => a.estRideMs - b.estRideMs || a.stop.id.localeCompare(b.stop.id),
    )
    if (leads.length === 0) {
      showOutcome(
        ctx,
        'No estimated candidates here. This does not establish that no journey exists.',
      )
      return
    }
    await runAreaBatch(
      ctx,
      preview,
      selectedArea,
      account,
      areaCheck,
      controller,
      leads,
    )
  } catch (error) {
    if (controller !== state.abortController) return
    showRoutingError(ctx, error)
  } finally {
    if (controller === state.abortController) {
      finishAreaCheck(ctx)
      syncConnectivity(ctx)
    }
  }
}
