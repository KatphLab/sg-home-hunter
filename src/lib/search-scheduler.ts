import {
  createDestinationStationJourney,
  findFirstQualifyingJourney,
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

const CLOCK_PATTERN = /^(\d{2}):(\d{2})$/
const DEFAULT_STEP_MINUTES = 10
const DEFAULT_MIN_INTERVAL_MS = 120

const parseMinutes = (clockHHMM: string): number => {
  const match = CLOCK_PATTERN.exec(clockHHMM)
  if (!match) {
    throw new Error(`Invalid clock time: ${clockHHMM}`)
  }
  return Number(match[1]) * 60 + Number(match[2])
}

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
  const deadlineMin = parseMinutes(officeStart)
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
  readonly latestMatch: QualifiedStop | null
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
  readonly totalCount: number
  readonly totalPasses: number
  readonly onProgress: (progress: SearchProgress) => void
  failedQueries: number
  lastRequestAt: number
  authExpired: boolean
}

const emitSnapshot = (
  state: SearchState,
  passNumber: number,
  latestMatch: QualifiedStop | null,
): void => {
  state.onProgress({
    status: 'running',
    triedCount: state.triedSet.size,
    totalCount: state.totalCount,
    matchedCount: state.matchedMap.size,
    passNumber,
    totalPasses: state.totalPasses,
    failedQueries: state.failedQueries,
    matches: [...state.matchedMap.values()],
    latestMatch,
  })
}

const seedDestinationStation = (
  inventory: StopInventory,
  workplace: Workplace,
  constraints: SearchConstraints,
  state: SearchState,
): QualifiedStop | null => {
  if (workplace.kind !== 'station') {
    return null
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
      return qualified
    }
  }
  return null
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
    state.triedSet.add(stop.id)
    const itineraries = await options.routeStop(
      stop,
      departureTime,
      options.signal,
    )
    const journey = findFirstQualifyingJourney(
      stop,
      options.constraints,
      itineraries,
    )
    const latestMatch = journey ? { stop, journey } : null
    if (latestMatch) {
      state.matchedMap.set(stop.id, latestMatch)
    }
    emitSnapshot(state, passNumber, latestMatch)
    return 'ok'
  } catch (error) {
    if (error instanceof OneMapAuthError) {
      state.authExpired = true
      return 'stop'
    }
    if (options.signal.aborted) {
      return 'stop'
    }
    state.failedQueries += 1
    emitSnapshot(state, passNumber, null)
    return 'ok'
  }
}

const runSearchPass = async (
  departureTime: string,
  passNumber: number,
  options: RunCommuteSearchOptions,
  state: SearchState,
): Promise<'ok' | 'stop'> => {
  emitSnapshot(state, passNumber, null)
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
    totalCount: options.inventory.stops.length,
    totalPasses: schedule.length,
    onProgress: options.onProgress,
    failedQueries: 0,
    lastRequestAt: 0,
    authExpired: false,
  }

  const seeded = seedDestinationStation(
    options.inventory,
    options.workplace,
    options.constraints,
    state,
  )
  emitSnapshot(state, 1, seeded)

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
