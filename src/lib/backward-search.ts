import { type BackwardLead, planBackwardLeads } from '@lib/backward-planner.js'
import {
  createDestinationStationJourney,
  evaluateBoardings,
} from '@lib/commute-rules.js'
import type {
  QualifiedStop,
  SearchConstraints,
  Stop,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import { findRailStationById } from '@lib/inventory.js'
import {
  type DelayLike,
  defaultDelay,
  OneMapAuthError,
} from '@lib/onemap-client.js'
import {
  buildDepartureSchedule,
  type SearchProgress,
  type SearchRunResult,
} from '@lib/search-scheduler.js'
import { formatSingaporeTime } from '@lib/singapore-calendar.js'
import type { TransitNetworkIndex } from '@lib/transit-network.js'

const DEFAULT_MIN_INTERVAL_MS = 120

type RouteStopFn = (
  stop: Stop,
  departureTimeHHMMSS: string,
  signal: AbortSignal,
) => Promise<readonly unknown[]>

export interface RunBackwardSearchOptions {
  readonly inventory: StopInventory
  readonly networkIndex: TransitNetworkIndex
  readonly workplace: Workplace
  readonly constraints: SearchConstraints
  readonly routeStop: RouteStopFn
  readonly signal: AbortSignal
  readonly onProgress: (progress: SearchProgress) => void
  readonly minRequestIntervalMs?: number
  readonly delayFn?: DelayLike
  readonly maxFinalWalkMeters?: number
  readonly maxTransfers?: number
  readonly maxProbesPerStop?: number
  readonly probeUncoveredStops?: boolean
}

export interface BackwardSearchRunResult extends SearchRunResult {
  readonly requestCount: number
  readonly wastedRequestCount: number
  readonly candidateStopCount: number
  readonly prunedStopCount: number
  readonly uncoveredStopCount: number
  readonly planElapsedMs: number
  readonly verifyElapsedMs: number
}

interface VerificationTracker {
  readonly triedStopIds: Set<string>
  readonly qualifiedByStopId: Map<string, QualifiedStop>
  readonly inventoryById: ReadonlyMap<string, Stop>
  readonly queriedKeys: Set<string>
  readonly requestCounts: Map<string, number>
  readonly queuedHints: Map<string, string>
  readonly hintedStopIds: Set<string>
  readonly totalStops: number
  readonly totalPasses: number
  readonly notify: (progress: SearchProgress) => void
  requestsSent: number
  errorsCount: number
  nextAllowedAtMs: number
  sessionExpired: boolean
}

const publishSnapshot = (
  tracker: VerificationTracker,
  passNumber: number,
): void => {
  tracker.notify({
    status: 'running',
    triedCount: tracker.triedStopIds.size,
    totalCount: tracker.totalStops,
    matchedCount: tracker.qualifiedByStopId.size,
    passNumber,
    totalPasses: tracker.totalPasses,
    failedQueries: tracker.errorsCount,
    matches: [...tracker.qualifiedByStopId.values()],
  })
}

const seedExactStationMatch = (
  inventory: StopInventory,
  workplace: Workplace,
  constraints: SearchConstraints,
  tracker: VerificationTracker,
): void => {
  if (workplace.kind !== 'station') {
    return
  }
  const station = findRailStationById(inventory, workplace.stationId)
  if (!station) {
    return
  }
  tracker.triedStopIds.add(station.id)
  tracker.qualifiedByStopId.set(station.id, {
    stop: station,
    journey: createDestinationStationJourney(
      station,
      constraints.searchDate,
      constraints.officeStart,
    ),
  })
}

const waitForRateSlot = async (
  tracker: VerificationTracker,
  intervalMs: number,
  signal: AbortSignal,
  delayFn: DelayLike,
): Promise<void> => {
  if (intervalMs <= 0) {
    return
  }
  const waitMs = tracker.nextAllowedAtMs - Date.now()
  if (waitMs > 0) {
    await delayFn(waitMs, signal)
  }
  tracker.nextAllowedAtMs = Date.now() + intervalMs
}

const recordSingleItinerary = (
  raw: unknown,
  constraints: SearchConstraints,
  tracker: VerificationTracker,
): void => {
  const evaluated = evaluateBoardings(constraints, raw)
  for (const journey of evaluated.journeys) {
    const stop = tracker.inventoryById.get(journey.stopId)
    if (stop && !tracker.qualifiedByStopId.has(stop.id)) {
      tracker.qualifiedByStopId.set(stop.id, { stop, journey })
      tracker.triedStopIds.add(stop.id)
    }
  }
  for (const hint of evaluated.hints) {
    if (
      !tracker.inventoryById.has(hint.stopId) ||
      tracker.qualifiedByStopId.has(hint.stopId) ||
      tracker.hintedStopIds.has(hint.stopId)
    ) {
      continue
    }
    const depClock = formatSingaporeTime(hint.departureMs, true)
    if (!tracker.queriedKeys.has(`${hint.stopId}@${depClock}`)) {
      tracker.hintedStopIds.add(hint.stopId)
      tracker.queuedHints.set(hint.stopId, depClock)
    }
  }
}

const applyEvaluatedBoardings = (
  itineraries: readonly unknown[],
  constraints: SearchConstraints,
  tracker: VerificationTracker,
): void => {
  for (const raw of itineraries) {
    recordSingleItinerary(raw, constraints, tracker)
  }
}

const verifyStopDeparture = async (
  stop: Stop,
  departureTime: string,
  passNumber: number,
  options: RunBackwardSearchOptions,
  tracker: VerificationTracker,
): Promise<'ok' | 'stop'> => {
  const queryKey = `${stop.id}@${departureTime}`
  if (
    tracker.qualifiedByStopId.has(stop.id) ||
    tracker.queriedKeys.has(queryKey)
  ) {
    return 'ok'
  }
  const intervalMs = options.minRequestIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const delayFn = options.delayFn ?? defaultDelay
  try {
    await waitForRateSlot(tracker, intervalMs, options.signal, delayFn)
    if (options.signal.aborted) {
      return 'stop'
    }
    tracker.queriedKeys.add(queryKey)
    tracker.requestsSent += 1
    tracker.requestCounts.set(
      stop.id,
      (tracker.requestCounts.get(stop.id) ?? 0) + 1,
    )
    const itineraries = await options.routeStop(
      stop,
      departureTime,
      options.signal,
    )
    tracker.triedStopIds.add(stop.id)
    applyEvaluatedBoardings(itineraries, options.constraints, tracker)
    publishSnapshot(tracker, passNumber)
    return 'ok'
  } catch (error) {
    if (error instanceof OneMapAuthError) {
      tracker.sessionExpired = true
      return 'stop'
    }
    if (options.signal.aborted) {
      return 'stop'
    }
    tracker.triedStopIds.add(stop.id)
    tracker.errorsCount += 1
    publishSnapshot(tracker, passNumber)
    return 'ok'
  }
}

const flushQueuedHints = async (
  passNumber: number,
  options: RunBackwardSearchOptions,
  tracker: VerificationTracker,
): Promise<'ok' | 'stop'> => {
  const entries = [...tracker.queuedHints.entries()]
  tracker.queuedHints.clear()
  for (const [stopId, departureTime] of entries) {
    if (options.signal.aborted) {
      return 'stop'
    }
    const stop = tracker.inventoryById.get(stopId)
    if (!stop || tracker.qualifiedByStopId.has(stopId)) {
      continue
    }
    if (
      (await verifyStopDeparture(
        stop,
        departureTime,
        passNumber,
        options,
        tracker,
      )) === 'stop'
    ) {
      return 'stop'
    }
  }
  return 'ok'
}

const buildAllLeads = (
  options: RunBackwardSearchOptions,
): {
  readonly leads: readonly BackwardLead[]
  readonly candidateStopCount: number
  readonly prunedStopCount: number
  readonly uncoveredStopCount: number
  readonly planElapsedMs: number
} => {
  const plan = planBackwardLeads({
    inventory: options.inventory,
    networkIndex: options.networkIndex,
    workplace: options.workplace,
    constraints: options.constraints,
    ...(options.maxFinalWalkMeters !== undefined
      ? { maxFinalWalkMeters: options.maxFinalWalkMeters }
      : {}),
    ...(options.maxTransfers !== undefined
      ? { maxTransfers: options.maxTransfers }
      : {}),
    ...(options.maxProbesPerStop !== undefined
      ? { maxProbesPerStop: options.maxProbesPerStop }
      : {}),
  })

  if (!options.probeUncoveredStops || plan.uncoveredStopIds.length === 0) {
    return {
      leads: plan.leads,
      candidateStopCount: plan.leads.length,
      prunedStopCount: plan.prunedStopCount,
      uncoveredStopCount: plan.uncoveredStopIds.length,
      planElapsedMs: plan.planElapsedMs,
    }
  }

  const stopsById = new Map(options.inventory.stops.map((s) => [s.id, s]))
  const fallbackSchedule = buildDepartureSchedule(
    options.constraints.officeStart,
    options.constraints.rideCapMinutes,
  )
  const fallbackLeads: BackwardLead[] = []
  for (const id of plan.uncoveredStopIds) {
    const stop = stopsById.get(id)
    if (stop) {
      fallbackLeads.push({
        stop,
        candidateDepartures: fallbackSchedule,
        minRideMs: 0,
        estRideMs: 0,
        transfers: 0,
        isScheduled: false,
      })
    }
  }
  return {
    leads: [...plan.leads, ...fallbackLeads],
    candidateStopCount: plan.leads.length,
    prunedStopCount: plan.prunedStopCount,
    uncoveredStopCount: plan.uncoveredStopIds.length,
    planElapsedMs: plan.planElapsedMs,
  }
}

const runVerificationPass = async (
  passIdx: number,
  leads: readonly BackwardLead[],
  options: RunBackwardSearchOptions,
  tracker: VerificationTracker,
): Promise<'ok' | 'stop'> => {
  const passNumber = passIdx + 1
  publishSnapshot(tracker, passNumber)
  for (const lead of leads) {
    if (options.signal.aborted) {
      return 'stop'
    }
    const departureTime = lead.candidateDepartures[passIdx]
    if (!departureTime || tracker.qualifiedByStopId.has(lead.stop.id)) {
      continue
    }
    if (
      (await verifyStopDeparture(
        lead.stop,
        departureTime,
        passNumber,
        options,
        tracker,
      )) === 'stop'
    ) {
      return 'stop'
    }
  }
  return flushQueuedHints(passNumber, options, tracker)
}

const computeWastedRequests = (tracker: VerificationTracker): number => {
  let wasted = 0
  for (const [stopId, count] of tracker.requestCounts.entries()) {
    if (!tracker.qualifiedByStopId.has(stopId)) {
      wasted += count
    }
  }
  return wasted
}

/** Run backward commute planning followed by targeted OneMap verification at the whole-search seam. */
export const runBackwardCommuteSearch = async (
  options: RunBackwardSearchOptions,
): Promise<BackwardSearchRunResult> => {
  const planSummary = buildAllLeads(options)
  const maxPasses = planSummary.leads.reduce(
    (max, lead) => Math.max(max, lead.candidateDepartures.length),
    0,
  )
  const tracker: VerificationTracker = {
    triedStopIds: new Set<string>(),
    qualifiedByStopId: new Map<string, QualifiedStop>(),
    inventoryById: new Map(options.inventory.stops.map((s) => [s.id, s])),
    queriedKeys: new Set<string>(),
    requestCounts: new Map<string, number>(),
    queuedHints: new Map<string, string>(),
    hintedStopIds: new Set<string>(),
    totalStops: options.inventory.stops.length,
    totalPasses: Math.max(1, maxPasses),
    notify: options.onProgress,
    requestsSent: 0,
    errorsCount: 0,
    nextAllowedAtMs: 0,
    sessionExpired: false,
  }

  seedExactStationMatch(
    options.inventory,
    options.workplace,
    options.constraints,
    tracker,
  )
  publishSnapshot(tracker, 1)

  const verifyStartedAt = performance.now()
  let status: 'completed' | 'partial' = 'completed'
  for (let passIdx = 0; passIdx < maxPasses; passIdx += 1) {
    const outcome = await runVerificationPass(
      passIdx,
      planSummary.leads,
      options,
      tracker,
    )
    if (outcome === 'stop') {
      status = 'partial'
      break
    }
  }

  return {
    status,
    authExpired: tracker.sessionExpired,
    triedCount: tracker.triedStopIds.size,
    totalCount: tracker.totalStops,
    failedQueries: tracker.errorsCount,
    matches: [...tracker.qualifiedByStopId.values()],
    requestCount: tracker.requestsSent,
    wastedRequestCount: computeWastedRequests(tracker),
    candidateStopCount: planSummary.candidateStopCount,
    prunedStopCount: planSummary.prunedStopCount,
    uncoveredStopCount: planSummary.uncoveredStopCount,
    planElapsedMs: planSummary.planElapsedMs,
    verifyElapsedMs:
      Math.round((performance.now() - verifyStartedAt) * 100) / 100,
  }
}
