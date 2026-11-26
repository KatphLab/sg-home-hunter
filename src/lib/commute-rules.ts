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
    prevEnd = leg.endTime
    const service = isTransitMode(leg.mode)
      ? extractService(leg.record, leg.mode)
      : null
    const interlined = readOptionalBoolean(
      leg.record,
      'interlineWithPreviousLeg',
    )
    const stopId =
      service && !interlined ? extractBoardingStopId(leg.record) : null
    return { ...leg, service, stopId }
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

const collectHints = (
  hints: BoardingHint[],
  leg: ParsedLeg,
  earliestDeparture: number,
  searchDate: string,
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
    if (
      !isFiniteNonNegativeNumber(departureMs) ||
      departureMs < earliestDeparture ||
      departureMs > leg.endTime ||
      getSingaporeDateFromInstant(departureMs) !== searchDate
    ) {
      continue
    }
    const stopId = readStopId(stop)
    if (stopId) {
      hints.push({ stopId, departureMs })
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
  const services: JourneyService[] = []
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
    collectHints(result.hints, leg, earliestDeparture, constraints.searchDate)
    rideMs += leg.endTime - leg.startTime
    services.unshift(leg.service)
    if (rideMs > rideCapMs) {
      break
    }
    if (
      leg.stopId !== null &&
      getSingaporeDateFromInstant(leg.startTime) === constraints.searchDate
    ) {
      result.journeys.unshift({
        stopId: leg.stopId,
        searchDate: constraints.searchDate,
        boardingAtMs: leg.startTime,
        arrivalAtMs,
        rideMs,
        services: [...services],
        isAtDestination: false,
      })
    }
  }
}
