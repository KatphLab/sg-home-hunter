import type { BackwardLead, BackwardPlanResult } from '@lib/backward-planner.js'
import {
  createDestinationStationJourney,
  evaluateBoardings,
} from '@lib/commute-rules.js'
import type {
  QualifiedStop,
  SearchConstraints,
  SearchProgress,
  SearchRunResult,
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
  formatSingaporeTime,
  parseClockMinutes,
} from '@lib/singapore-calendar.js'

const DEFAULT_MIN_INTERVAL_MS = 120
const FALLBACK_STEP_MINUTES = 10

const formatClockSeconds = (totalMinutes: number): string => {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`
}

const buildFallbackSchedule = (
  officeStart: string,
  rideCapMinutes: number,
): readonly string[] => {
  const deadlineMin = parseClockMinutes(officeStart)
  const earliestMin =
    deadlineMin < 7 * 60 ? Math.max(0, deadlineMin - 120) : 6 * 60
  const anchorMin = deadlineMin - (rideCapMinutes + 15)
  const candidates: number[] = []
  for (
    let current = earliestMin;
    current <= deadlineMin;
    current += FALLBACK_STEP_MINUTES
  ) {
    candidates.push(current)
  }
  candidates.sort((a, b) => {
    const distDiff = Math.abs(a - anchorMin) - Math.abs(b - anchorMin)
    return distDiff !== 0 ? distDiff : a - b
  })
  return candidates.map(formatClockSeconds)
}

type RouteStopFn = (
  stop: Stop,
  departureTimeHHMMSS: string,
  signal: AbortSignal,
) => Promise<readonly unknown[]>

export interface RunBackwardSearchOptions {
  readonly inventory: StopInventory
  readonly plan: BackwardPlanResult | null
  readonly workplace: Workplace
  readonly constraints: SearchConstraints
  readonly routeStop: RouteStopFn
  readonly signal: AbortSignal
  readonly onProgress: (progress: SearchProgress) => void
  readonly minRequestIntervalMs?: number
  readonly delayFn?: DelayLike
}

interface VerificationTracker {
  readonly triedStopIds: Set<string>
  readonly qualifiedByStopId: Map<string, QualifiedStop>
  readonly inventoryById: ReadonlyMap<string, Stop>
  readonly queriedKeys: Set<string>
  readonly queuedHints: Map<string, string>
  readonly hintedStopIds: Set<string>
  readonly totalStops: number
  readonly totalPasses: number
  readonly notify: (progress: SearchProgress) => void
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
    const itineraries = await options.routeStop(
      stop,
      departureTime,
      options.signal,
    )
    tracker.triedStopIds.add(stop.id)
    for (const raw of itineraries) {
      recordSingleItinerary(raw, options.constraints, tracker)
    }
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
  while (tracker.queuedHints.size > 0) {
    const entries = [...tracker.queuedHints]
    tracker.queuedHints.clear()
    for (const [stopId, departureTime] of entries) {
      if (options.signal.aborted) {
        return 'stop'
      }
      const stop = tracker.inventoryById.get(stopId)
      if (
        stop &&
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
  }
  return 'ok'
}

const buildAllLeads = (
  options: RunBackwardSearchOptions,
  stopsById: ReadonlyMap<string, Stop>,
): readonly BackwardLead[] => {
  const plan = options.plan
  if (!plan) return []

  if (plan.uncoveredStopIds.length === 0) {
    return plan.leads
  }

  const fallbackSchedule = buildFallbackSchedule(
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
      })
    }
  }
  return [...plan.leads, ...fallbackLeads]
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

/** Verify the planned departures and any uncovered stops against OneMap. */
export const runBackwardCommuteSearch = async (
  options: RunBackwardSearchOptions,
): Promise<SearchRunResult> => {
  const inventoryById = new Map(options.inventory.stops.map((s) => [s.id, s]))
  const leads = buildAllLeads(options, inventoryById)
  const maxPasses = leads.reduce(
    (max, lead) => Math.max(max, lead.candidateDepartures.length),
    0,
  )
  const tracker: VerificationTracker = {
    triedStopIds: new Set<string>(),
    qualifiedByStopId: new Map<string, QualifiedStop>(),
    inventoryById,
    queriedKeys: new Set<string>(),
    queuedHints: new Map<string, string>(),
    hintedStopIds: new Set<string>(),
    totalStops: options.inventory.stops.length,
    totalPasses: Math.max(1, maxPasses),
    notify: options.onProgress,
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

  let status: 'completed' | 'partial' = options.plan ? 'completed' : 'partial'
  for (let passIdx = 0; passIdx < maxPasses; passIdx += 1) {
    const outcome = await runVerificationPass(passIdx, leads, options, tracker)
    if (outcome === 'stop') {
      status = 'partial'
      break
    }
  }
  if (options.signal.aborted || tracker.errorsCount > 0) {
    status = 'partial'
  }

  return {
    status,
    authExpired: tracker.sessionExpired,
    triedCount: tracker.triedStopIds.size,
    totalCount: tracker.totalStops,
    failedQueries: tracker.errorsCount,
    matches: [...tracker.qualifiedByStopId.values()],
  }
}
