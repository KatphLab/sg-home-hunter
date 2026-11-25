import {
  createDestinationStationJourney,
  evaluateBoardings,
  isDestinationStationMatch,
} from '@lib/commute-rules.js'
import type {
  QualifiedStop,
  SearchConstraints,
  SearchResultStatus,
  Stop,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import {
  type DelayLike,
  defaultDelay,
  OneMapAuthError,
} from '@lib/onemap-client.js'
import {
  formatSingaporeTime,
  parseClockMinutes,
} from '@lib/singapore-calendar.js'

const DEFAULT_STEP_MINUTES = 10
const DEFAULT_MIN_INTERVAL_MS = 120

const formatClockSeconds = (totalMinutes: number): string => {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`
}

export const buildDepartureSchedule = (
  officeStart: string,
  rideCapMinutes: number,
  stepMinutes = DEFAULT_STEP_MINUTES,
): readonly string[] => {
  if (!Number.isInteger(stepMinutes) || stepMinutes <= 0) {
    throw new Error('Departure step minutes must be a positive integer')
  }
  const deadlineMin = parseClockMinutes(officeStart)
  const earliestMin =
    deadlineMin < 7 * 60 ? Math.max(0, deadlineMin - 120) : 6 * 60
  const anchorMin = deadlineMin - (rideCapMinutes + 15)

  const candidates: number[] = []
  for (
    let current = earliestMin;
    current <= deadlineMin;
    current += stepMinutes
  ) {
    candidates.push(current)
  }
  if (candidates.length === 0) {
    candidates.push(deadlineMin)
  }

  candidates.sort((a, b) => {
    const distDiff = Math.abs(a - anchorMin) - Math.abs(b - anchorMin)
    return distDiff !== 0 ? distDiff : a - b
  })

  return candidates.map(formatClockSeconds)
}

export interface SearchProgress {
  readonly status: SearchResultStatus
  readonly triedCount: number
  readonly totalCount: number
  readonly matchedCount: number
  readonly passNumber: number
  readonly totalPasses: number
  readonly failedQueries: number
  readonly matches: readonly QualifiedStop[]
}

export interface SearchRunResult {
  readonly status: 'completed' | 'partial'
  readonly authExpired: boolean
  readonly triedCount: number
  readonly totalCount: number
  readonly failedQueries: number
  readonly matches: readonly QualifiedStop[]
}

type RouteStopFn = (
  stop: Stop,
  departureTimeHHMMSS: string,
  signal: AbortSignal,
) => Promise<readonly unknown[]>

export interface RunCommuteSearchOptions {
  readonly inventory: StopInventory
  readonly workplace: Workplace
  readonly constraints: SearchConstraints
  readonly routeStop: RouteStopFn
  readonly signal: AbortSignal
  readonly onProgress: (progress: SearchProgress) => void
  readonly minRequestIntervalMs?: number
  readonly delayFn?: DelayLike
}

interface SearchState {
  readonly triedSet: Set<string>
  readonly matchedMap: Map<string, QualifiedStop>
  readonly stopsById: ReadonlyMap<string, Stop>
  readonly hints: Map<Stop, string>
  readonly hintedStops: Set<Stop>
  readonly scheduledTimes: ReadonlySet<string>
  readonly totalCount: number
  readonly totalPasses: number
  readonly onProgress: (progress: SearchProgress) => void
  failedQueries: number
  lastRequestAt: number
  authExpired: boolean
}

const emitProgress = (state: SearchState, passNumber: number): void => {
  state.onProgress({
    status: 'running',
    triedCount: state.triedSet.size,
    totalCount: state.totalCount,
    matchedCount: state.matchedMap.size,
    passNumber,
    totalPasses: state.totalPasses,
    failedQueries: state.failedQueries,
    matches: [...state.matchedMap.values()],
  })
}

const seedDestinationStation = (
  inventory: StopInventory,
  workplace: Workplace,
  constraints: SearchConstraints,
  state: SearchState,
): void => {
  if (workplace.kind !== 'station') {
    return
  }
  for (const stop of inventory.stops) {
    if (isDestinationStationMatch(stop, workplace)) {
      const journey = createDestinationStationJourney(
        stop,
        constraints.searchDate,
        constraints.officeStart,
      )
      const qualified: QualifiedStop = { stop, journey }
      state.triedSet.add(stop.id)
      state.matchedMap.set(stop.id, qualified)
      return
    }
  }
}

const paceRequest = async (
  lastRequestAt: number,
  minIntervalMs: number,
  signal: AbortSignal,
  delayFn: DelayLike,
): Promise<number> => {
  if (minIntervalMs > 0 && lastRequestAt > 0) {
    const elapsed = Date.now() - lastRequestAt
    if (elapsed < minIntervalMs) {
      await delayFn(minIntervalMs - elapsed, signal)
    }
  }
  return Date.now()
}

const buildResult = (
  status: 'completed' | 'partial',
  state: SearchState,
): SearchRunResult => ({
  status,
  authExpired: state.authExpired,
  triedCount: state.triedSet.size,
  totalCount: state.totalCount,
  failedQueries: state.failedQueries,
  matches: [...state.matchedMap.values()],
})

const recordItinerary = (
  raw: unknown,
  constraints: SearchConstraints,
  state: SearchState,
): void => {
  const { journeys, hints } = evaluateBoardings(constraints, raw)
  for (const journey of journeys) {
    const stop = state.stopsById.get(journey.stopId)
    if (stop && !state.matchedMap.has(stop.id)) {
      state.matchedMap.set(stop.id, { stop, journey })
      state.triedSet.add(stop.id)
    }
  }
  for (const { stopId, departureMs } of hints) {
    const stop = state.stopsById.get(stopId)
    if (!stop || state.matchedMap.has(stopId) || state.hintedStops.has(stop)) {
      continue
    }
    const departure = formatSingaporeTime(departureMs, true)
    if (!state.scheduledTimes.has(departure)) {
      state.hintedStops.add(stop)
      state.hints.set(stop, departure)
    }
  }
}

const probeStop = async (
  stop: Stop,
  departureTime: string,
  passNumber: number,
  options: RunCommuteSearchOptions,
  state: SearchState,
): Promise<'ok' | 'stop'> => {
  const minInterval = options.minRequestIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const delayFn = options.delayFn ?? defaultDelay
  try {
    state.lastRequestAt = await paceRequest(
      state.lastRequestAt,
      minInterval,
      options.signal,
      delayFn,
    )
    if (options.signal.aborted) {
      return 'stop'
    }
    const itineraries = await options.routeStop(
      stop,
      departureTime,
      options.signal,
    )
    state.triedSet.add(stop.id)
    for (const itinerary of itineraries) {
      recordItinerary(itinerary, options.constraints, state)
    }
    emitProgress(state, passNumber)
    return 'ok'
  } catch (error) {
    if (error instanceof OneMapAuthError) {
      state.authExpired = true
      return 'stop'
    }
    if (options.signal.aborted) {
      return 'stop'
    }
    state.triedSet.add(stop.id)
    state.failedQueries += 1
    emitProgress(state, passNumber)
    return 'ok'
  }
}

const runSearchPass = async (
  departureTime: string,
  passNumber: number,
  options: RunCommuteSearchOptions,
  state: SearchState,
): Promise<'ok' | 'stop'> => {
  emitProgress(state, passNumber)
  for (const stop of options.inventory.stops) {
    if (options.signal.aborted) {
      return 'stop'
    }
    if (state.matchedMap.has(stop.id)) {
      continue
    }
    const outcome = await probeStop(
      stop,
      departureTime,
      passNumber,
      options,
      state,
    )
    if (outcome === 'stop') {
      return 'stop'
    }
  }
  // Finish the island-wide pass before spending requests on timing hints.
  for (const [stop, time] of state.hints) {
    if (state.matchedMap.has(stop.id)) {
      continue
    }
    if ((await probeStop(stop, time, passNumber, options, state)) === 'stop') {
      return 'stop'
    }
  }
  state.hints.clear()
  return 'ok'
}

export const runCommuteSearch = async (
  options: RunCommuteSearchOptions,
): Promise<SearchRunResult> => {
  const schedule = buildDepartureSchedule(
    options.constraints.officeStart,
    options.constraints.rideCapMinutes,
  )
  const state: SearchState = {
    triedSet: new Set<string>(),
    matchedMap: new Map<string, QualifiedStop>(),
    stopsById: new Map(options.inventory.stops.map((stop) => [stop.id, stop])),
    hints: new Map(),
    hintedStops: new Set(),
    scheduledTimes: new Set(schedule),
    totalCount: options.inventory.stops.length,
    totalPasses: schedule.length,
    onProgress: options.onProgress,
    failedQueries: 0,
    lastRequestAt: 0,
    authExpired: false,
  }

  seedDestinationStation(
    options.inventory,
    options.workplace,
    options.constraints,
    state,
  )
  emitProgress(state, 1)

  for (let passIdx = 0; passIdx < schedule.length; passIdx += 1) {
    const departureTime = schedule[passIdx] ?? '08:00:00'
    const outcome = await runSearchPass(
      departureTime,
      passIdx + 1,
      options,
      state,
    )
    if (outcome === 'stop') {
      return buildResult('partial', state)
    }
    if (state.matchedMap.size === state.totalCount) {
      break
    }
  }

  return buildResult('completed', state)
}
