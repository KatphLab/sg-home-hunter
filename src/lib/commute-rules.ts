import type {
  JourneyService,
  QualifyingJourney,
  SearchConstraints,
  Stop,
  TransitMode,
  Workplace,
} from '@lib/commute-types.js'
import {
  getSingaporeDateFromInstant,
  parseSingaporeDateTimeMs,
} from '@lib/singapore-calendar.js'
import {
  isFiniteNonNegativeNumber,
  isNonEmptyString,
  isRecord,
  isTransitMode,
} from '@utils/guards.js'

const ARRIVAL_WINDOW_EARLY_MS = 900_000

const readOptionalBoolean = (
  record: Record<string, unknown>,
  field: string,
): boolean => {
  const value = record[field]
  if (value === undefined) {
    return false
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Malformed itinerary field ${field}: expected boolean`)
  }
  return value
}

const readOptionalString = (
  record: Record<string, unknown>,
  field: string,
): string | null => {
  const value = record[field]
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error(`Malformed leg field ${field}: expected string`)
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const readStopId = (from: Record<string, unknown>): string | undefined => {
  const code = from['stopCode']
  if (code !== undefined && code !== null && code !== '') {
    return typeof code === 'string' ? code : undefined
  }
  const id = from['stopId']
  return typeof id === 'string' ? id.split(':').at(-1) : undefined
}

const extractBoardingStopId = (leg: Record<string, unknown>): string => {
  const from = leg['from']
  if (!isRecord(from)) {
    throw new Error('Malformed transit leg: missing from object')
  }
  const id = readStopId(from)
  if (id) {
    return id
  }
  throw new Error('Malformed transit leg: missing boarding stop identifier')
}

const extractService = (
  leg: Record<string, unknown>,
  mode: TransitMode,
): JourneyService => {
  const shortName = readOptionalString(leg, 'routeShortName')
  const longName = readOptionalString(leg, 'routeLongName')
  const route = readOptionalString(leg, 'route')
  const routeId = readOptionalString(leg, 'routeId')
  const name = shortName ?? longName ?? route ?? routeId
  const id = routeId ?? route ?? name
  if (!name || !id) {
    throw new Error('Malformed transit leg: missing service identifier')
  }
  return { id, name, mode }
}

interface ParsedLeg {
  readonly record: Record<string, unknown>
  readonly startTime: number
  readonly endTime: number
  readonly mode: string
  readonly rideMs: number
  readonly service: JourneyService | null
  readonly stopId: string | null
}

const parseLegTiming = (
  leg: unknown,
  prevEnd: number,
  itinEnd: number,
): {
  readonly record: Record<string, unknown>
  readonly startTime: number
  readonly endTime: number
  readonly mode: string
} => {
  if (!isRecord(leg)) {
    throw new Error('Malformed leg: expected object')
  }
  const legStart = leg['startTime']
  const legEnd = leg['endTime']
  const mode = leg['mode']
  if (
    !isFiniteNonNegativeNumber(legStart) ||
    !isFiniteNonNegativeNumber(legEnd) ||
    legEnd < legStart ||
    legStart < prevEnd ||
    legEnd > itinEnd ||
    !isNonEmptyString(mode)
  ) {
    throw new Error('Malformed leg timing or mode')
  }
  readOptionalBoolean(leg, 'transitLeg')
  return { record: leg, startTime: legStart, endTime: legEnd, mode }
}

const inspectLegs = (
  rawLegs: unknown,
  itinStart: number,
  itinEnd: number,
): ParsedLeg[] => {
  if (!Array.isArray(rawLegs) || rawLegs.length === 0) {
    throw new Error('Malformed itinerary: legs must be a non-empty array')
  }

  let prevEnd = itinStart
  return rawLegs.map((rawLeg) => {
    const leg = parseLegTiming(rawLeg, prevEnd, itinEnd)
    const service = isTransitMode(leg.mode)
      ? extractService(leg.record, leg.mode)
      : null
    const interlined = readOptionalBoolean(
      leg.record,
      'interlineWithPreviousLeg',
    )
    const stopId =
      service && !interlined ? extractBoardingStopId(leg.record) : null
    // An interlined passenger remains on board between the two service legs.
    const rideMs = leg.endTime - (interlined ? prevEnd : leg.startTime)
    prevEnd = leg.endTime
    return { ...leg, service, stopId, rideMs }
  })
}

export const isDestinationStationMatch = (
  candidateStop: Stop,
  workplace: Workplace,
): boolean =>
  workplace.kind === 'station' &&
  candidateStop.kind === 'rail' &&
  candidateStop.id === workplace.stationId

export const createDestinationStationJourney = (
  candidateStop: Stop,
  searchDate: string,
  officeStart: string,
): QualifyingJourney => {
  const deadlineMs = parseSingaporeDateTimeMs(searchDate, officeStart)
  return {
    stopId: candidateStop.id,
    searchDate,
    boardingAtMs: deadlineMs,
    arrivalAtMs: deadlineMs,
    rideMs: 0,
    services: [],
    isAtDestination: true,
  }
}

interface BoardingHint {
  stopId: string
  departureMs: number
}

type JourneySuffix = Pick<
  QualifyingJourney,
  'searchDate' | 'arrivalAtMs' | 'services'
>

const collectIntermediateBoardings = (
  result: Boardings,
  leg: ParsedLeg,
  earliestDeparture: number,
  downstreamRideMs: number,
  suffix: JourneySuffix,
): void => {
  const stops = leg.record['intermediateStops']
  if (!Array.isArray(stops)) {
    return
  }
  for (const stop of stops) {
    if (
      !isRecord(stop) ||
      stop['pickupType'] === 1 ||
      stop['pickupType'] === 'NONE'
    ) {
      continue
    }
    const departureMs = stop['departure']
    const stopId = readStopId(stop)
    if (
      !stopId ||
      !isFiniteNonNegativeNumber(departureMs) ||
      departureMs < earliestDeparture ||
      departureMs > leg.endTime ||
      getSingaporeDateFromInstant(departureMs) !== suffix.searchDate
    ) {
      continue
    }
    if (stop['pickupType'] === 0 || stop['pickupType'] === 'SCHEDULED') {
      result.journeys.push({
        ...suffix,
        stopId,
        boardingAtMs: departureMs,
        rideMs: leg.endTime - departureMs + downstreamRideMs,
        isAtDestination: false,
      })
    } else {
      result.hints.push({ stopId, departureMs })
    }
  }
}

interface Boardings {
  journeys: QualifyingJourney[]
  hints: BoardingHint[]
}

export const evaluateBoardings = (
  constraints: SearchConstraints,
  rawItinerary: unknown,
): Boardings => {
  if (!isRecord(rawItinerary)) {
    throw new Error('Malformed itinerary: expected object')
  }
  const itinStart = rawItinerary['startTime']
  const itinEnd = rawItinerary['endTime']
  if (
    !isFiniteNonNegativeNumber(itinStart) ||
    !isFiniteNonNegativeNumber(itinEnd) ||
    itinEnd < itinStart
  ) {
    throw new Error('Malformed itinerary timestamps')
  }

  const walkLimitExceeded = readOptionalBoolean(
    rawItinerary,
    'walkLimitExceeded',
  )
  const legs = inspectLegs(rawItinerary['legs'], itinStart, itinEnd)
  const result: Boardings = { journeys: [], hints: [] }

  const deadlineMs = parseSingaporeDateTimeMs(
    constraints.searchDate,
    constraints.officeStart,
  )
  const windowStartMs = deadlineMs - ARRIVAL_WINDOW_EARLY_MS

  if (
    walkLimitExceeded ||
    itinEnd < windowStartMs ||
    itinEnd > deadlineMs ||
    getSingaporeDateFromInstant(itinEnd) !== constraints.searchDate
  ) {
    return result
  }

  collectBoardings(legs, constraints, itinEnd, result)
  return result
}

const collectBoardings = (
  legs: ParsedLeg[],
  constraints: SearchConstraints,
  arrivalAtMs: number,
  result: Boardings,
): void => {
  const rideCapMs = constraints.rideCapMinutes * 60_000
  let rideMs = 0
  let services: readonly JourneyService[] = []
  for (const leg of legs.reverse()) {
    if (leg.mode === 'WALK') {
      continue
    }
    if (leg.service === null) {
      break
    }
    const earliestDeparture = Math.max(
      leg.startTime,
      leg.endTime - (rideCapMs - rideMs),
    )
    services = [leg.service, ...services]
    const suffix = { searchDate: constraints.searchDate, arrivalAtMs, services }
    collectIntermediateBoardings(result, leg, earliestDeparture, rideMs, suffix)
    rideMs += leg.rideMs
    if (rideMs > rideCapMs) {
      break
    }
    if (
      leg.stopId !== null &&
      getSingaporeDateFromInstant(leg.startTime) === constraints.searchDate
    ) {
      result.journeys.unshift({
        ...suffix,
        stopId: leg.stopId,
        boardingAtMs: leg.startTime,
        rideMs,
        isAtDestination: false,
      })
    }
  }
}
