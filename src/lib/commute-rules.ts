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
} from '@utils/guards.js'

const ARRIVAL_WINDOW_EARLY_MS = 900_000
const TRANSIT_MODES: ReadonlySet<string> = new Set([
  'BUS',
  'SUBWAY',
  'TRAM',
  'RAIL',
])

const isTransitMode = (mode: string): mode is TransitMode =>
  TRANSIT_MODES.has(mode)

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

const extractBoardingStopId = (leg: Record<string, unknown>): string => {
  const from = leg['from']
  if (!isRecord(from)) {
    throw new Error('Malformed transit leg: missing from object')
  }
  const rawCode = from['stopCode']
  if (rawCode !== undefined && rawCode !== null) {
    if (typeof rawCode !== 'string') {
      throw new Error('Malformed transit leg stopCode: expected string')
    }
    return rawCode
  }
  const rawStopId = from['stopId']
  if (typeof rawStopId === 'string' && rawStopId.length > 0) {
    const suffix = rawStopId.split(':').at(-1)
    if (suffix !== undefined && suffix.length > 0) {
      return suffix
    }
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

interface ParsedLegSummary {
  readonly transitCount: number
  readonly firstBoardingAtMs: number
  readonly firstBoardingStopId: string
  readonly rideMs: number
  readonly services: readonly JourneyService[]
  readonly hasUnsupportedMode: boolean
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
): ParsedLegSummary => {
  if (!Array.isArray(rawLegs) || rawLegs.length === 0) {
    throw new Error('Malformed itinerary: legs must be a non-empty array')
  }

  let prevEnd = itinStart
  let transitCount = 0
  let firstBoardingAtMs = 0
  let firstBoardingStopId = ''
  let rideMs = 0
  let hasUnsupportedMode = false
  const services: JourneyService[] = []

  for (const rawLeg of rawLegs) {
    const leg = parseLegTiming(rawLeg, prevEnd, itinEnd)
    prevEnd = leg.endTime

    if (leg.mode === 'WALK') {
      continue
    }
    if (!isTransitMode(leg.mode)) {
      hasUnsupportedMode = true
      continue
    }
    if (transitCount === 0) {
      firstBoardingAtMs = leg.startTime
      firstBoardingStopId = extractBoardingStopId(leg.record)
    }
    transitCount += 1
    rideMs += leg.endTime - leg.startTime
    services.push(extractService(leg.record, leg.mode))
  }

  return {
    transitCount,
    firstBoardingAtMs,
    firstBoardingStopId,
    rideMs,
    services,
    hasUnsupportedMode,
  }
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

export const evaluateItinerary = (
  candidateStop: Stop,
  constraints: SearchConstraints,
  rawItinerary: unknown,
): QualifyingJourney | null => {
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
  const summary = inspectLegs(rawItinerary['legs'], itinStart, itinEnd)

  if (
    walkLimitExceeded ||
    summary.hasUnsupportedMode ||
    summary.transitCount === 0 ||
    summary.firstBoardingStopId !== candidateStop.id
  ) {
    return null
  }

  const deadlineMs = parseSingaporeDateTimeMs(
    constraints.searchDate,
    constraints.officeStart,
  )
  const windowStartMs = deadlineMs - ARRIVAL_WINDOW_EARLY_MS
  const rideCapMs = constraints.rideCapMinutes * 60_000

  if (
    itinEnd < windowStartMs ||
    itinEnd > deadlineMs ||
    summary.rideMs > rideCapMs ||
    getSingaporeDateFromInstant(summary.firstBoardingAtMs) !==
      constraints.searchDate ||
    getSingaporeDateFromInstant(itinEnd) !== constraints.searchDate
  ) {
    return null
  }

  return {
    stopId: candidateStop.id,
    searchDate: constraints.searchDate,
    boardingAtMs: summary.firstBoardingAtMs,
    arrivalAtMs: itinEnd,
    rideMs: summary.rideMs,
    services: summary.services,
    isAtDestination: false,
  }
}

export const findFirstQualifyingJourney = (
  candidateStop: Stop,
  constraints: SearchConstraints,
  rawItineraries: readonly unknown[],
): QualifyingJourney | null => {
  for (const itinerary of rawItineraries) {
    const match = evaluateItinerary(candidateStop, constraints, itinerary)
    if (match !== null) {
      return match
    }
  }
  return null
}
