import type {
  CompletedSearchSnapshot,
  Coordinates,
  JourneyService,
  QualifiedStop,
  QualifyingJourney,
  SearchConstraints,
  Stop,
  TransitMode,
  Workplace,
} from '@lib/commute-types.js'
import {
  isFiniteNonNegativeNumber,
  isNonEmptyString,
  isRecord,
  parseJsonUnknown,
} from '@utils/guards.js'

const STORAGE_KEY = 'house-hunter:last-completed-result:v1'
const TRANSIT_MODES: ReadonlySet<string> = new Set([
  'BUS',
  'SUBWAY',
  'TRAM',
  'RAIL',
])

const isTransitMode = (value: unknown): value is TransitMode =>
  typeof value === 'string' && TRANSIT_MODES.has(value)

const parseCoordinates = (raw: unknown): Coordinates | null => {
  if (!isRecord(raw)) {
    return null
  }
  const lat = raw['latitude']
  const lon = raw['longitude']
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return null
  }
  return { latitude: lat, longitude: lon }
}

const parseStop = (raw: unknown): Stop | null => {
  if (!isRecord(raw)) {
    return null
  }
  const id = raw['id']
  const kind = raw['kind']
  const name = raw['name']
  const point = parseCoordinates(raw['point'])
  if (
    !isNonEmptyString(id) ||
    (kind !== 'bus' && kind !== 'rail') ||
    !isNonEmptyString(name) ||
    point === null
  ) {
    return null
  }
  return { id, kind, name, point }
}

const parseWorkplace = (raw: unknown): Workplace | null => {
  if (!isRecord(raw)) {
    return null
  }
  const kind = raw['kind']
  const label = raw['label']
  const point = parseCoordinates(raw['point'])
  if (!isNonEmptyString(label) || point === null) {
    return null
  }
  if (kind === 'postal' && isNonEmptyString(raw['postalCode'])) {
    return { kind: 'postal', postalCode: raw['postalCode'], label, point }
  }
  if (kind === 'station' && isNonEmptyString(raw['stationId'])) {
    return { kind: 'station', stationId: raw['stationId'], label, point }
  }
  return null
}

const parseService = (raw: unknown): JourneyService | null => {
  if (!isRecord(raw)) {
    return null
  }
  const id = raw['id']
  const name = raw['name']
  const mode = raw['mode']
  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(name) ||
    !isTransitMode(mode)
  ) {
    return null
  }
  return { id, name, mode }
}

const parseJourney = (raw: unknown): QualifyingJourney | null => {
  if (!isRecord(raw) || !Array.isArray(raw['services'])) {
    return null
  }
  const stopId = raw['stopId']
  const searchDate = raw['searchDate']
  const boardingAtMs = raw['boardingAtMs']
  const arrivalAtMs = raw['arrivalAtMs']
  const rideMs = raw['rideMs']
  const isAtDestination = raw['isAtDestination']
  if (
    !isNonEmptyString(stopId) ||
    !isNonEmptyString(searchDate) ||
    !isFiniteNonNegativeNumber(boardingAtMs) ||
    !isFiniteNonNegativeNumber(arrivalAtMs) ||
    !isFiniteNonNegativeNumber(rideMs) ||
    typeof isAtDestination !== 'boolean'
  ) {
    return null
  }
  const services: JourneyService[] = []
  for (const item of raw['services']) {
    const parsed = parseService(item)
    if (parsed === null) {
      return null
    }
    services.push(parsed)
  }
  return {
    stopId,
    searchDate,
    boardingAtMs,
    arrivalAtMs,
    rideMs,
    services,
    isAtDestination,
  }
}

const parseConstraints = (raw: unknown): SearchConstraints | null => {
  if (!isRecord(raw)) {
    return null
  }
  const searchDate = raw['searchDate']
  const officeStart = raw['officeStart']
  const rideCapMinutes = raw['rideCapMinutes']
  if (
    !isNonEmptyString(searchDate) ||
    !isNonEmptyString(officeStart) ||
    !isFiniteNonNegativeNumber(rideCapMinutes)
  ) {
    return null
  }
  return { searchDate, officeStart, rideCapMinutes }
}

const parseQualifiedStop = (raw: unknown): QualifiedStop | null => {
  if (!isRecord(raw)) {
    return null
  }
  const stop = parseStop(raw['stop'])
  const journey = parseJourney(raw['journey'])
  return stop !== null && journey !== null ? { stop, journey } : null
}

const parseSnapshot = (raw: unknown): CompletedSearchSnapshot | null => {
  if (!isRecord(raw) || raw['version'] !== 1) {
    return null
  }
  const completedAtIso = raw['completedAtIso']
  const inventoryDate = raw['inventoryDate']
  const triedCount = raw['triedCount']
  const totalCount = raw['totalCount']
  const workplace = parseWorkplace(raw['workplace'])
  const constraints = parseConstraints(raw['constraints'])
  if (
    !isNonEmptyString(completedAtIso) ||
    !isNonEmptyString(inventoryDate) ||
    !isFiniteNonNegativeNumber(triedCount) ||
    !isFiniteNonNegativeNumber(totalCount) ||
    workplace === null ||
    constraints === null ||
    !Array.isArray(raw['matches'])
  ) {
    return null
  }
  const matches: QualifiedStop[] = []
  for (const item of raw['matches']) {
    const parsed = parseQualifiedStop(item)
    if (parsed === null) {
      return null
    }
    matches.push(parsed)
  }
  return {
    version: 1,
    completedAtIso,
    inventoryDate,
    workplace,
    constraints,
    triedCount,
    totalCount,
    matches,
  }
}

export const saveCompletedResult = (
  storage: Storage,
  snapshot: CompletedSearchSnapshot,
): void => {
  storage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
}

export const loadCompletedResult = (
  storage: Storage,
): CompletedSearchSnapshot | null => {
  try {
    const rawText = storage.getItem(STORAGE_KEY)
    if (rawText === null) {
      return null
    }
    return parseSnapshot(parseJsonUnknown(rawText))
  } catch {
    return null
  }
}
