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
import { haversineDistanceMeters } from '@lib/transit-network.js'
import { normalizeError } from '@utils/guards.js'
import { checkedStopCount, showOutcome, showProof } from './area-result.js'
import { renderCounters } from './dom-render.js'
import {
  candidatesWithinArea,
  type NeighbourhoodPreview,
} from './neighbourhood-preview.js'
import {
  type AppContext,
  type AreaCheckState,
  refreshStopList,
  syncAccountUi,
  syncConnectivity,
} from './search-controller.js'

const proofWithinArea = (
  ctx: AppContext,
  centre: Coordinates,
): QualifiedStop | undefined =>
  ctx.state.matches.find(
    (entry) => haversineDistanceMeters(entry.stop.point, centre) <= 500,
  )

function* plannedProbes(
  leads: readonly BackwardLead[],
): Generator<{ stop: Stop; departure: string }> {
  const rounds = leads.reduce(
    (max, lead) => Math.max(max, lead.candidateDepartures.length),
    0,
  )
  for (let round = 0; round < rounds; round += 1) {
    for (const lead of leads) {
      const departure = lead.candidateDepartures[round]
      if (departure) yield { stop: lead.stop, departure }
    }
  }
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
  ctx.els.stopsMatchedValue.textContent = String(ctx.state.matches.length)
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
  const probes = [...plannedProbes(leads)].filter(
    ({ stop, departure }) =>
      !areaCheck.checkedDepartures.has(`${stop.id}@${departure}`),
  )
  areaCheck.hasMore = probes.length > 0
  for (const [index, { stop, departure }] of probes.entries()) {
    const key = `${stop.id}@${departure}`
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
      checkedStopCount(
        areaCheck.completedDepartures,
        new Set(preview.leads.map((lead) => lead.stop.id)),
      ),
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
  const incompleteCount = [...plannedProbes(leads)].filter(
    ({ stop, departure }) => {
      const key = `${stop.id}@${departure}`
      return (
        areaCheck.checkedDepartures.has(key) &&
        !areaCheck.completedDepartures.has(key)
      )
    },
  ).length
  const exhaustion =
    incompleteCount > 0
      ? `No untried planned departures remain. ${String(incompleteCount)} attempted checks failed or were interrupted; these are not negative journey evidence.`
      : 'All planned departures for this area have been checked.'
  showOutcome(
    ctx,
    areaCheck.hasMore
      ? 'Not confirmed in these checks. Other qualifying journeys may exist.'
      : `Not confirmed in the completed checks. ${exhaustion} Other qualifying journeys may exist.`,
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
    state.isSearching ||
    !navigator.onLine
  )
    return
  const controller = new AbortController()
  state.abortController = controller
  state.isSearching = true
  areaCheck.checksPerformed = 0
  areaCheck.hasRun = true
  els.checkAreaButton.disabled = true
  els.stopAreaButton.hidden = false
  els.areaJourney.hidden = true
  syncConnectivity(ctx)
  try {
    const existing = proofWithinArea(ctx, selectedArea)
    if (existing) {
      showProof(ctx, existing)
      return
    }
    const leads = [...candidatesWithinArea(preview, selectedArea)].sort(
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
      state.abortController = null
      state.isSearching = false
      els.stopAreaButton.hidden = true
      syncConnectivity(ctx)
    }
  }
}
