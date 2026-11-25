import type {
  Coordinates,
  Stop,
  StopInventory,
  TransitMode,
} from '@lib/commute-types.js'
import { isSingaporePublicHoliday } from '@lib/singapore-calendar.js'

const EARTH_RADIUS_M = 6_371_000
const DEFAULT_MAX_TRANSFER_WALK_M = 450
const SAME_COMPLEX_RAIL_M = 150
const GRID_CELL_DEG = 0.0045
const RAIL_DEFAULT_WINDOW: OperatingWindow = { firstMin: 330, lastMin: 1435 }
const MRT_HEADWAY_MS = 240_000
const LRT_HEADWAY_MS = 300_000
const BUS_HEADWAY_MS = 720_000
const LINEAR_MRT_PREFIXES: readonly string[] = [
  'NS',
  'EW',
  'CG',
  'NE',
  'DT',
  'TE',
]

export type DayType = 'weekday' | 'saturday' | 'sunday_holiday'

interface NetworkProvenance {
  readonly source: string
  readonly version: string
  readonly license: string
  readonly timingKind: 'scheduled' | 'first_last_estimated'
}

interface OperatingWindow {
  readonly firstMin: number
  readonly lastMin: number
}

export interface TransitSegment {
  readonly fromStopId: string
  readonly toStopId: string
  readonly minRideMs: number
  readonly estRideMs: number
  readonly operatingWindows?: Readonly<
    Partial<Record<DayType, OperatingWindow>>
  >
}

interface ScheduledStopTime {
  readonly stopId: string
  readonly arrivalMs: number
  readonly departureMs: number
  readonly pickupAllowed: boolean
  readonly dropOffAllowed: boolean
}

export interface ScheduledTrip {
  readonly tripId: string
  readonly dayTypes: readonly DayType[]
  readonly startDate?: string
  readonly endDate?: string
  readonly addedDates?: readonly string[]
  readonly removedDates?: readonly string[]
  readonly stops: readonly ScheduledStopTime[]
}

export interface TransitPattern {
  readonly patternId: string
  readonly serviceId: string
  readonly serviceName: string
  readonly mode: TransitMode
  readonly timingKind: 'scheduled' | 'estimated'
  readonly headwayMs: number
  readonly segments: readonly TransitSegment[]
  readonly scheduledTrips?: readonly ScheduledTrip[]
}

export interface TransferLink {
  readonly fromStopId: string
  readonly toStopId: string
  readonly walkMs: number
  readonly minTransferWaitMs: number
  readonly estTransferWaitMs: number
}

export interface TransitNetworkIndex {
  readonly version: 1
  readonly networkDate: string
  readonly inventoryDate: string
  readonly provenance: readonly NetworkProvenance[]
  readonly patterns: readonly TransitPattern[]
  readonly transfers: readonly TransferLink[]
  readonly coveredStopIds: readonly string[]
}

export interface BusRouterServiceEntry {
  readonly name: string
  readonly routes: readonly (readonly string[])[]
}

export interface GtfsScheduleFiles {
  readonly routesTxt: string
  readonly calendarTxt: string
  readonly calendarDatesTxt?: string
  readonly tripsTxt: string
  readonly stopTimesTxt: string
}

export interface BuildTransitNetworkInput {
  readonly inventory: StopInventory
  readonly networkDate: string
  readonly busServices: Readonly<Record<string, BusRouterServiceEntry>>
  readonly busFirstLast: Readonly<Record<string, readonly string[]>>
  readonly gtfsTrain?: GtfsScheduleFiles
  readonly maxTransferWalkMeters?: number
}

export interface ParsedFirstLastEntry {
  readonly serviceId: string
  readonly windows: Readonly<Partial<Record<DayType, OperatingWindow>>>
}

export interface ParsedBusNetworkData {
  readonly networkDate: string
  readonly busServices: Readonly<Record<string, BusRouterServiceEntry>>
  readonly busFirstLast: Readonly<Record<string, readonly string[]>>
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const sanitizeTsvToken = (raw: string): string =>
  raw.replace(/[\t\r\n]+/g, ' ').trim()

const appendServiceLines = (
  lines: string[],
  busServices: Readonly<Record<string, BusRouterServiceEntry>>,
): void => {
  const serviceIds = Object.keys(busServices).sort((a, b) => a.localeCompare(b))
  for (const serviceId of serviceIds) {
    const cleanId = sanitizeTsvToken(serviceId)
    const entry = busServices[serviceId]
    if (!entry || cleanId.length === 0) {
      continue
    }
    for (const route of entry.routes) {
      const cleanedRoute = route.map(sanitizeTsvToken).filter(Boolean)
      if (cleanedRoute.length >= 2) {
        lines.push(`R\t${cleanId}\t${cleanedRoute.join(',')}`)
      }
    }
  }
}

const appendFirstLastLines = (
  lines: string[],
  busFirstLast: Readonly<Record<string, readonly string[]>>,
): void => {
  const stopIds = Object.keys(busFirstLast).sort((a, b) => a.localeCompare(b))
  for (const stopId of stopIds) {
    const cleanStopId = sanitizeTsvToken(stopId)
    const entries = (busFirstLast[stopId] ?? [])
      .map((item) => item.replace(/[|\t\r\n]+/g, ' ').trim())
      .filter(Boolean)
    if (cleanStopId.length > 0 && entries.length > 0) {
      lines.push(`F\t${cleanStopId}\t${entries.join('|')}`)
    }
  }
}

/** Serialize dated BusRouter services and first/last timings into a compact TSV. */
export const serializeBusNetworkTsv = (input: ParsedBusNetworkData): string => {
  if (!ISO_DATE_PATTERN.test(input.networkDate)) {
    throw new Error(`Invalid bus network date: ${input.networkDate}`)
  }
  const lines = [`networkDate\t${input.networkDate}`, 'kind\tid\tpayload']
  appendServiceLines(lines, input.busServices)
  appendFirstLastLines(lines, input.busFirstLast)
  return `${lines.join('\n')}\n`
}

const parseNetworkHeader = (lines: readonly string[]): string => {
  if (lines.length < 2) {
    throw new Error('Bus network TSV is missing required headers')
  }
  const metaParts = (lines[0] ?? '').split('\t')
  const networkDate = metaParts[1] ?? ''
  if (metaParts[0] !== 'networkDate' || !ISO_DATE_PATTERN.test(networkDate)) {
    throw new Error('Bus network TSV missing valid networkDate header')
  }
  if (lines[1] !== 'kind\tid\tpayload') {
    throw new Error('Bus network TSV column header mismatch')
  }
  return networkDate
}

const parseRoutePayload = (
  serviceId: string,
  payload: string,
  routesByService: Map<string, string[][]>,
): void => {
  const stops = payload
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  if (stops.length < 2) {
    return
  }
  const existing = routesByService.get(serviceId) ?? []
  existing.push(stops)
  routesByService.set(serviceId, existing)
}

const parseFirstLastPayload = (
  stopId: string,
  payload: string,
  busFirstLast: Record<string, string[]>,
): void => {
  const entries = payload
    .split('|')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0) {
    return
  }
  const existing = busFirstLast[stopId]
  if (existing) {
    existing.push(...entries)
  } else {
    busFirstLast[stopId] = entries
  }
}

const applyNetworkRow = (
  line: string,
  routesByService: Map<string, string[][]>,
  busFirstLast: Record<string, string[]>,
): void => {
  const parts = line.split('\t')
  if (parts.length !== 3) {
    return
  }
  const kind = parts[0] ?? ''
  const id = (parts[1] ?? '').trim()
  const payload = (parts[2] ?? '').trim()
  if (id.length === 0 || payload.length === 0) {
    return
  }
  if (kind === 'R') {
    parseRoutePayload(id, payload, routesByService)
  } else if (kind === 'F') {
    parseFirstLastPayload(id, payload, busFirstLast)
  }
}

/** Parse a compact bus-network TSV produced by `serializeBusNetworkTsv`. */
export const parseBusNetworkTsv = (rawTsv: string): ParsedBusNetworkData => {
  const lines = rawTsv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const networkDate = parseNetworkHeader(lines)

  const routesByService = new Map<string, string[][]>()
  const busFirstLast: Record<string, string[]> = {}
  for (let index = 2; index < lines.length; index += 1) {
    applyNetworkRow(lines[index] ?? '', routesByService, busFirstLast)
  }

  const busServices: Record<string, BusRouterServiceEntry> = {}
  for (const [serviceId, routes] of routesByService.entries()) {
    busServices[serviceId] = { name: serviceId, routes }
  }
  return { networkDate, busServices, busFirstLast }
}

const toRadians = (deg: number): number => (deg * Math.PI) / 180

/** Compute straight-line distance in meters between two WGS84 points. */
export const haversineDistanceMeters = (
  a: Coordinates,
  b: Coordinates,
): number => {
  const dLat = toRadians(b.latitude - a.latitude)
  const dLon = toRadians(b.longitude - a.longitude)
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const h =
    sinLat * sinLat +
    Math.cos(toRadians(a.latitude)) *
      Math.cos(toRadians(b.latitude)) *
      sinLon *
      sinLon
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Map an ISO calendar date to Singapore's service day type (accounting for public holidays). */
export const getServiceDayType = (isoDate: string): DayType => {
  if (isSingaporePublicHoliday(isoDate)) {
    return 'sunday_holiday'
  }
  const parts = isoDate.split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  if (dow === 0) {
    return 'sunday_holiday'
  }
  if (dow === 6) {
    return 'saturday'
  }
  return 'weekday'
}

const parseHHMM = (raw: string): number | null => {
  if (!/^\d{4}$/.test(raw)) {
    return null
  }
  const hours = Number(raw.slice(0, 2))
  const minutes = Number(raw.slice(2, 4))
  if (minutes > 59 || hours > 27) {
    return null
  }
  return hours * 60 + minutes
}

const resolveWindowPair = (
  firstRaw: string,
  lastRaw: string,
  prev?: OperatingWindow,
): OperatingWindow | undefined => {
  if (firstRaw === '-' || lastRaw === '-') {
    return undefined
  }
  const firstMin =
    firstRaw === '=' ? (prev?.firstMin ?? null) : parseHHMM(firstRaw)
  const rawLast = lastRaw === '=' ? (prev?.lastMin ?? null) : parseHHMM(lastRaw)
  if (firstMin === null || rawLast === null) {
    return undefined
  }
  const lastMin = rawLast < firstMin ? rawLast + 1440 : rawLast
  return { firstMin, lastMin }
}

/** Parse one line from busrouter.sg firstlast.min.json into per-day-type operating windows. */
export const parseBusRouterFirstLastLine = (
  line: string,
): ParsedFirstLastEntry | null => {
  const parts = line.trim().split(/\s+/)
  if (parts.length !== 7) {
    return null
  }
  const [
    serviceId = '',
    wdF = '',
    wdL = '',
    satF = '',
    satL = '',
    sunF = '',
    sunL = '',
  ] = parts
  if (serviceId.length === 0) {
    return null
  }
  const weekday = resolveWindowPair(wdF, wdL)
  const saturday = resolveWindowPair(satF, satL, weekday)
  const sunday = resolveWindowPair(sunF, sunL, saturday ?? weekday)
  const windows: Partial<Record<DayType, OperatingWindow>> = {}
  if (weekday) {
    windows.weekday = weekday
  }
  if (saturday) {
    windows.saturday = saturday
  }
  if (sunday) {
    windows.sunday_holiday = sunday
  }
  return { serviceId, windows }
}

const splitCsvRow = (line: string): string[] => {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

const parseCsvRecords = (
  rawCsv: string,
): readonly Readonly<Record<string, string>>[] => {
  const lines = rawCsv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const headerLine = lines[0]
  if (!headerLine) {
    return []
  }
  const headers = splitCsvRow(headerLine)
  const rows: Record<string, string>[] = []
  for (let idx = 1; idx < lines.length; idx += 1) {
    const values = splitCsvRow(lines[idx] ?? '')
    const row: Record<string, string> = {}
    for (let col = 0; col < headers.length; col += 1) {
      const key = headers[col]
      if (key) {
        row[key] = values[col] ?? ''
      }
    }
    rows.push(row)
  }
  return rows
}

const parseGtfsClockMs = (clock: string): number | null => {
  const parts = clock.split(':')
  if (parts.length !== 3) {
    return null
  }
  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  const seconds = Number(parts[2])
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return null
  }
  return (hours * 3600 + minutes * 60 + seconds) * 1000
}

interface CalendarScheduleEntry {
  readonly dayTypes: readonly DayType[]
  readonly startDate?: string
  readonly endDate?: string
  readonly addedDates: string[]
  readonly removedDates: string[]
}

const recordExceptionRow = (
  map: Map<string, CalendarScheduleEntry>,
  row: Readonly<Record<string, string | undefined>>,
): void => {
  const serviceId = row['service_id'] ?? ''
  const date = row['date'] ?? ''
  const exc = row['exception_type'] ?? ''
  if (serviceId.length === 0 || date.length !== 8) {
    return
  }
  const entry = map.get(serviceId) ?? {
    dayTypes: [],
    addedDates: [],
    removedDates: [],
  }
  if (exc === '1') {
    entry.addedDates.push(date)
  } else if (exc === '2') {
    entry.removedDates.push(date)
  }
  map.set(serviceId, entry)
}

const applyCalendarExceptions = (
  map: Map<string, CalendarScheduleEntry>,
  calendarDatesTxt: string | undefined,
): void => {
  if (!calendarDatesTxt) {
    return
  }
  for (const row of parseCsvRecords(calendarDatesTxt)) {
    recordExceptionRow(map, row)
  }
}

const extractCalendarDayTypes = (
  row: Readonly<Record<string, string | undefined>>,
): readonly DayType[] => {
  const dayTypes: DayType[] = []
  const hasWeekday =
    row['monday'] === '1' ||
    row['tuesday'] === '1' ||
    row['wednesday'] === '1' ||
    row['thursday'] === '1' ||
    row['friday'] === '1'
  if (hasWeekday) {
    dayTypes.push('weekday')
  }
  if (row['saturday'] === '1') {
    dayTypes.push('saturday')
  }
  if (row['sunday'] === '1') {
    dayTypes.push('sunday_holiday')
  }
  return dayTypes
}

const parseCalendarEntries = (
  calendarTxt: string,
  calendarDatesTxt?: string,
): ReadonlyMap<string, CalendarScheduleEntry> => {
  const map = new Map<string, CalendarScheduleEntry>()
  for (const row of parseCsvRecords(calendarTxt)) {
    const serviceId = row['service_id'] ?? ''
    if (serviceId.length === 0) {
      continue
    }
    const startDate = row['start_date']
    const endDate = row['end_date']
    map.set(serviceId, {
      dayTypes: extractCalendarDayTypes(row),
      ...(startDate?.length === 8 ? { startDate } : {}),
      ...(endDate?.length === 8 ? { endDate } : {}),
      addedDates: [],
      removedDates: [],
    })
  }
  applyCalendarExceptions(map, calendarDatesTxt)
  return map
}

const mapGtfsRouteMode = (routeType: string): TransitMode => {
  if (routeType === '0') {
    return 'TRAM'
  }
  if (routeType === '3') {
    return 'BUS'
  }
  if (routeType === '2') {
    return 'RAIL'
  }
  return 'SUBWAY'
}

interface RawStopTimeEntry {
  readonly stopId: string
  readonly sequence: number
  readonly arrivalMs: number
  readonly departureMs: number
  readonly pickupAllowed: boolean
  readonly dropOffAllowed: boolean
}

const groupStopTimesByTrip = (
  stopTimesTxt: string,
  validStopIds: ReadonlySet<string>,
): ReadonlyMap<string, RawStopTimeEntry[]> => {
  const grouped = new Map<string, RawStopTimeEntry[]>()
  for (const row of parseCsvRecords(stopTimesTxt)) {
    const tripId = row['trip_id'] ?? ''
    const stopId = row['stop_id'] ?? ''
    const seq = Number(row['stop_sequence'])
    const arrivalMs = parseGtfsClockMs(row['arrival_time'] ?? '')
    const departureMs = parseGtfsClockMs(row['departure_time'] ?? '')
    if (
      tripId.length === 0 ||
      !validStopIds.has(stopId) ||
      !Number.isFinite(seq) ||
      arrivalMs === null ||
      departureMs === null
    ) {
      continue
    }
    const list = grouped.get(tripId) ?? []
    list.push({
      stopId,
      sequence: seq,
      arrivalMs,
      departureMs,
      pickupAllowed: row['pickup_type'] !== '1',
      dropOffAllowed: row['drop_off_type'] !== '1',
    })
    grouped.set(tripId, list)
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.sequence - b.sequence)
  }
  return grouped
}

const buildGtfsRouteMeta = (
  routesTxt: string,
): ReadonlyMap<
  string,
  { readonly name: string; readonly mode: TransitMode }
> => {
  const routeMeta = new Map<
    string,
    { readonly name: string; readonly mode: TransitMode }
  >()
  for (const row of parseCsvRecords(routesTxt)) {
    const id = row['route_id'] ?? ''
    if (id.length === 0) {
      continue
    }
    const name = row['route_short_name'] ?? row['route_long_name'] ?? id
    routeMeta.set(id, {
      name: name.length > 0 ? name : id,
      mode: mapGtfsRouteMode(row['route_type'] ?? '1'),
    })
  }
  return routeMeta
}

interface PatternTripBucket {
  readonly routeId: string
  readonly dirId: string
  readonly trips: ScheduledTrip[]
}

const buildScheduledTrip = (
  tripId: string,
  cal: CalendarScheduleEntry,
  rawStops: readonly RawStopTimeEntry[],
): ScheduledTrip => ({
  tripId,
  dayTypes: cal.dayTypes,
  ...(cal.startDate ? { startDate: cal.startDate } : {}),
  ...(cal.endDate ? { endDate: cal.endDate } : {}),
  ...(cal.addedDates.length > 0 ? { addedDates: cal.addedDates } : {}),
  ...(cal.removedDates.length > 0 ? { removedDates: cal.removedDates } : {}),
  stops: rawStops.map((s) => ({
    stopId: s.stopId,
    arrivalMs: s.arrivalMs,
    departureMs: s.departureMs,
    pickupAllowed: s.pickupAllowed,
    dropOffAllowed: s.dropOffAllowed,
  })),
})

const groupGtfsTrips = (
  tripsTxt: string,
  calendarMap: ReadonlyMap<string, CalendarScheduleEntry>,
  stopTimesByTrip: ReadonlyMap<string, RawStopTimeEntry[]>,
): ReadonlyMap<string, PatternTripBucket> => {
  const tripsByPattern = new Map<string, PatternTripBucket>()
  for (const row of parseCsvRecords(tripsTxt)) {
    const routeId = row['route_id'] ?? ''
    const tripId = row['trip_id'] ?? ''
    const cal = calendarMap.get(row['service_id'] ?? '')
    const rawStops = stopTimesByTrip.get(tripId)
    if (!cal || !rawStops || rawStops.length < 2) {
      continue
    }
    if (cal.dayTypes.length === 0 && cal.addedDates.length === 0) {
      continue
    }
    const dirId = row['direction_id'] ?? '0'
    const key = `${routeId}:${dirId}`
    const bucket = tripsByPattern.get(key) ?? { routeId, dirId, trips: [] }
    bucket.trips.push(buildScheduledTrip(tripId, cal, rawStops))
    tripsByPattern.set(key, bucket)
  }
  return tripsByPattern
}

/** Parse official GTFS train schedule files into scheduled transit patterns. */
export const parseGtfsTrainSchedule = (
  files: GtfsScheduleFiles,
  validStopIds: ReadonlySet<string>,
): readonly TransitPattern[] => {
  const calendarMap = parseCalendarEntries(
    files.calendarTxt,
    files.calendarDatesTxt,
  )
  const routeMeta = buildGtfsRouteMeta(files.routesTxt)
  const stopTimesByTrip = groupStopTimesByTrip(files.stopTimesTxt, validStopIds)
  const tripsByPattern = groupGtfsTrips(
    files.tripsTxt,
    calendarMap,
    stopTimesByTrip,
  )

  const defaultMode: TransitMode = 'SUBWAY'
  const patterns: TransitPattern[] = []
  for (const [key, bucket] of tripsByPattern.entries()) {
    const meta = routeMeta.get(bucket.routeId) ?? {
      name: bucket.routeId,
      mode: defaultMode,
    }
    patterns.push({
      patternId: `gtfs:${key}`,
      serviceId: bucket.routeId,
      serviceName: meta.name,
      mode: meta.mode,
      timingKind: 'scheduled',
      headwayMs: MRT_HEADWAY_MS,
      segments: [],
      scheduledTrips: bucket.trips,
    })
  }
  return patterns
}

const buildFirstLastLookup = (
  raw: Readonly<Record<string, readonly string[]>>,
): ReadonlyMap<
  string,
  ReadonlyMap<string, readonly ParsedFirstLastEntry[]>
> => {
  const byStop = new Map<string, Map<string, ParsedFirstLastEntry[]>>()
  for (const [stopId, lines] of Object.entries(raw)) {
    const byService = new Map<string, ParsedFirstLastEntry[]>()
    for (const line of lines) {
      const parsed = parseBusRouterFirstLastLine(line)
      if (!parsed) {
        continue
      }
      const list = byService.get(parsed.serviceId) ?? []
      list.push(parsed)
      byService.set(parsed.serviceId, list)
    }
    byStop.set(stopId, byService)
  }
  return byStop
}

const getRefFirstMin = (entry: ParsedFirstLastEntry): number | null =>
  entry.windows.weekday?.firstMin ??
  entry.windows.saturday?.firstMin ??
  entry.windows.sunday_holiday?.firstMin ??
  null

const matchPreviousFirstMin = (
  candidates: readonly ParsedFirstLastEntry[],
  prevFirstMin: number,
): ParsedFirstLastEntry | undefined => {
  let best: ParsedFirstLastEntry | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const first = getRefFirstMin(candidate)
    if (first === null) {
      continue
    }
    const delta = first - prevFirstMin
    if (delta >= 0 && delta < bestDelta) {
      bestDelta = delta
      best = candidate
    }
  }
  return best
}

const matchNextFirstMin = (
  candidates: readonly ParsedFirstLastEntry[],
  nextCandidates: readonly ParsedFirstLastEntry[],
): ParsedFirstLastEntry | undefined =>
  candidates.find((candidate) => {
    const first = getRefFirstMin(candidate)
    if (first === null) {
      return false
    }
    return nextCandidates.some((nxt) => {
      const nextFirst = getRefFirstMin(nxt)
      return nextFirst !== null && nextFirst >= first && nextFirst - first <= 20
    })
  })

const pickBestFirstLastEntry = (
  candidates: readonly ParsedFirstLastEntry[],
  prevFirstMin: number | null,
  nextCandidates: readonly ParsedFirstLastEntry[],
): ParsedFirstLastEntry | undefined => {
  if (candidates.length <= 1) {
    return candidates[0]
  }
  if (prevFirstMin !== null) {
    const matchedPrev = matchPreviousFirstMin(candidates, prevFirstMin)
    if (matchedPrev) {
      return matchedPrev
    }
  }
  return matchNextFirstMin(candidates, nextCandidates) ?? candidates[0]
}

const computeBusSegmentTiming = (
  fromStop: Stop,
  toStop: Stop,
  fromEntry: ParsedFirstLastEntry | undefined,
  toEntry: ParsedFirstLastEntry | undefined,
): TransitSegment => {
  const distM = haversineDistanceMeters(fromStop.point, toStop.point)
  const fromFirst = fromEntry ? getRefFirstMin(fromEntry) : null
  const toFirst = toEntry ? getRefFirstMin(toEntry) : null
  const deltaMin =
    fromFirst !== null && toFirst !== null ? toFirst - fromFirst : null
  const deltaMs =
    deltaMin !== null && deltaMin > 0 && deltaMin <= 30
      ? deltaMin * 60_000
      : null
  const impliedSpeedMps =
    deltaMs !== null ? distM / (deltaMs / 1000) : Number.POSITIVE_INFINITY
  const validDeltaMs =
    deltaMs !== null && impliedSpeedMps <= 21 ? deltaMs : null

  const physicalMinMs = Math.max(
    20_000,
    Math.round((distM / 14) * 1000 + 10_000),
  )
  const minRideMs =
    validDeltaMs !== null
      ? Math.max(physicalMinMs, Math.round(validDeltaMs * 0.85))
      : physicalMinMs
  const estRideMs =
    validDeltaMs !== null
      ? Math.max(minRideMs, Math.round(validDeltaMs * 1.15))
      : Math.max(minRideMs, Math.round((distM / 5.5) * 1000 + 25_000))

  return {
    fromStopId: fromStop.id,
    toStopId: toStop.id,
    minRideMs,
    estRideMs,
    ...(fromEntry ? { operatingWindows: fromEntry.windows } : {}),
  }
}

const alignRouteFirstLast = (
  serviceId: string,
  route: readonly string[],
  firstLastLookup: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly ParsedFirstLastEntry[]>
  >,
): readonly (ParsedFirstLastEntry | undefined)[] => {
  const aligned: (ParsedFirstLastEntry | undefined)[] = []
  let prevFirstMin: number | null = null
  for (let i = 0; i < route.length; i += 1) {
    const candidates = firstLastLookup.get(route[i] ?? '')?.get(serviceId) ?? []
    const nextCandidates =
      firstLastLookup.get(route[i + 1] ?? '')?.get(serviceId) ?? []
    const chosen = pickBestFirstLastEntry(
      candidates,
      prevFirstMin,
      nextCandidates,
    )
    aligned.push(chosen)
    const chosenFirst = chosen ? getRefFirstMin(chosen) : null
    if (chosenFirst !== null) {
      prevFirstMin = chosenFirst
    }
  }
  return aligned
}

const buildSingleBusPattern = (
  serviceId: string,
  dirIdx: number,
  route: readonly string[],
  stopsById: ReadonlyMap<string, Stop>,
  firstLastLookup: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly ParsedFirstLastEntry[]>
  >,
): TransitPattern | null => {
  const aligned = alignRouteFirstLast(serviceId, route, firstLastLookup)
  const segments: TransitSegment[] = []
  for (let i = 0; i < route.length - 1; i += 1) {
    const fromStop = stopsById.get(route[i] ?? '')
    const toStop = stopsById.get(route[i + 1] ?? '')
    if (!fromStop || !toStop) {
      continue
    }
    segments.push(
      computeBusSegmentTiming(fromStop, toStop, aligned[i], aligned[i + 1]),
    )
  }
  if (segments.length === 0) {
    return null
  }
  return {
    patternId: `bus:${serviceId}:${String(dirIdx)}`,
    serviceId,
    serviceName: serviceId,
    mode: 'BUS',
    timingKind: 'estimated',
    headwayMs: BUS_HEADWAY_MS,
    segments,
  }
}

const buildBusPatterns = (
  stopsById: ReadonlyMap<string, Stop>,
  busServices: Readonly<Record<string, BusRouterServiceEntry>>,
  firstLastLookup: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly ParsedFirstLastEntry[]>
  >,
): TransitPattern[] => {
  const patterns: TransitPattern[] = []
  for (const [serviceId, entry] of Object.entries(busServices)) {
    for (let dirIdx = 0; dirIdx < entry.routes.length; dirIdx += 1) {
      const pattern = buildSingleBusPattern(
        serviceId,
        dirIdx,
        entry.routes[dirIdx] ?? [],
        stopsById,
        firstLastLookup,
      )
      if (pattern) {
        patterns.push(pattern)
      }
    }
  }
  return patterns
}

const parseStationNumber = (stationId: string): number => {
  const digits = /^\D+(\d+)$/.exec(stationId)?.[1]
  return digits ? Number(digits) : 0
}

const collectByPrefix = (railStops: readonly Stop[], prefix: string): Stop[] =>
  railStops
    .filter((s) => {
      if (prefix === 'CG') {
        return s.id === 'CG' || s.id.startsWith('CG')
      }
      return new RegExp(`^${prefix}\\d+$`).test(s.id)
    })
    .sort((a, b) => parseStationNumber(a.id) - parseStationNumber(b.id))

const makeRailPattern = (
  patternId: string,
  serviceId: string,
  orderedStops: readonly Stop[],
  isLrt: boolean,
): TransitPattern | null => {
  if (orderedStops.length < 2) {
    return null
  }
  const segments: TransitSegment[] = []
  for (let i = 0; i < orderedStops.length - 1; i += 1) {
    const fromStop = orderedStops[i]
    const toStop = orderedStops[i + 1]
    if (!fromStop || !toStop) {
      continue
    }
    const distM = haversineDistanceMeters(fromStop.point, toStop.point)
    const minRideMs = isLrt
      ? Math.max(50_000, Math.round((distM / 10) * 1000 + 25_000))
      : Math.max(75_000, Math.round((distM / 15) * 1000 + 35_000))
    const estRideMs = isLrt
      ? Math.max(minRideMs, Math.round((distM / 7.5) * 1000 + 35_000))
      : Math.max(minRideMs, Math.round((distM / 12.5) * 1000 + 50_000))
    segments.push({
      fromStopId: fromStop.id,
      toStopId: toStop.id,
      minRideMs,
      estRideMs,
      operatingWindows: {
        weekday: RAIL_DEFAULT_WINDOW,
        saturday: RAIL_DEFAULT_WINDOW,
        sunday_holiday: RAIL_DEFAULT_WINDOW,
      },
    })
  }
  if (segments.length === 0) {
    return null
  }
  return {
    patternId,
    serviceId,
    serviceName: serviceId,
    mode: isLrt ? 'TRAM' : 'SUBWAY',
    timingKind: 'estimated',
    headwayMs: isLrt ? LRT_HEADWAY_MS : MRT_HEADWAY_MS,
    segments,
  }
}

const pushBidirectionalRail = (
  patterns: TransitPattern[],
  serviceId: string,
  stops: readonly Stop[],
  isLrt: boolean,
): void => {
  const fwd = makeRailPattern(`rail:${serviceId}:fwd`, serviceId, stops, isLrt)
  if (fwd) {
    patterns.push(fwd)
  }
  const rev = makeRailPattern(
    `rail:${serviceId}:rev`,
    serviceId,
    [...stops].reverse(),
    isLrt,
  )
  if (rev) {
    patterns.push(rev)
  }
}

const pushStemAndLoopRail = (
  patterns: TransitPattern[],
  serviceId: string,
  orderedStops: readonly Stop[],
  hubStationId: string,
  isLrt: boolean,
): void => {
  const hubIndex = orderedStops.findIndex((s) => s.id === hubStationId)
  if (hubIndex >= 0 && orderedStops.length > hubIndex + 1) {
    const hub = orderedStops[hubIndex]
    const stem = orderedStops.slice(0, hubIndex + 1)
    const loop = hub ? [...orderedStops.slice(hubIndex), hub] : []
    pushBidirectionalRail(patterns, serviceId, stem, isLrt)
    pushBidirectionalRail(patterns, `${serviceId}_LOOP`, loop, isLrt)
    return
  }
  pushBidirectionalRail(patterns, serviceId, orderedStops, isLrt)
}

const buildLrtPatterns = (
  patterns: TransitPattern[],
  railStops: readonly Stop[],
  stopsById: ReadonlyMap<string, Stop>,
): void => {
  pushStemAndLoopRail(
    patterns,
    'BP',
    collectByPrefix(railStops, 'BP'),
    'BP6',
    true,
  )

  const loopSpecs: readonly {
    readonly hub: string
    readonly prefix: string
  }[] = [
    { hub: 'PTC', prefix: 'PE' },
    { hub: 'PTC', prefix: 'PW' },
    { hub: 'STC', prefix: 'SE' },
    { hub: 'STC', prefix: 'SW' },
  ]
  for (const spec of loopSpecs) {
    const hub = stopsById.get(spec.hub)
    const loopStops = collectByPrefix(railStops, spec.prefix)
    const full =
      hub && loopStops.length > 0 ? [hub, ...loopStops, hub] : loopStops
    pushBidirectionalRail(patterns, spec.prefix, full, true)
  }
}

const buildRailTopologyPatterns = (
  inventory: StopInventory,
  stopsById: ReadonlyMap<string, Stop>,
): TransitPattern[] => {
  const railStops = inventory.stops.filter((s) => s.kind === 'rail')
  const patterns: TransitPattern[] = []

  for (const prefix of LINEAR_MRT_PREFIXES) {
    pushBidirectionalRail(
      patterns,
      prefix,
      collectByPrefix(railStops, prefix),
      false,
    )
  }

  pushStemAndLoopRail(
    patterns,
    'CC',
    collectByPrefix(railStops, 'CC'),
    'CC4',
    false,
  )

  buildLrtPatterns(patterns, railStops, stopsById)
  return patterns
}

const getGridCell = (
  point: Coordinates,
): { readonly cx: number; readonly cy: number } => ({
  cx: Math.floor(point.latitude / GRID_CELL_DEG),
  cy: Math.floor(point.longitude / GRID_CELL_DEG),
})

const buildSpatialGrid = (
  stops: readonly Stop[],
): ReadonlyMap<string, Stop[]> => {
  const grid = new Map<string, Stop[]>()
  for (const stop of stops) {
    const { cx, cy } = getGridCell(stop.point)
    const key = `${String(cx)}:${String(cy)}`
    const bucket = grid.get(key) ?? []
    bucket.push(stop)
    grid.set(key, bucket)
  }
  return grid
}

const collectTransfersFromCell = (
  from: Stop,
  neighbors: readonly Stop[],
  maxWalkMeters: number,
  links: TransferLink[],
): void => {
  for (const to of neighbors) {
    if (from.id === to.id) {
      continue
    }
    const distM = haversineDistanceMeters(from.point, to.point)
    if (distM > maxWalkMeters) {
      continue
    }
    const sameRailComplex =
      from.kind === 'rail' && to.kind === 'rail' && distM <= SAME_COMPLEX_RAIL_M
    links.push({
      fromStopId: from.id,
      toStopId: to.id,
      walkMs: sameRailComplex
        ? 60_000
        : Math.max(30_000, Math.round((distM / 1.25) * 1000)),
      minTransferWaitMs: 30_000,
      estTransferWaitMs: sameRailComplex ? 180_000 : 240_000,
    })
  }
}

const buildTransferLinks = (
  stops: readonly Stop[],
  maxWalkMeters: number,
): TransferLink[] => {
  const grid = buildSpatialGrid(stops)
  const links: TransferLink[] = []
  for (const from of stops) {
    const { cx, cy } = getGridCell(from.point)
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const neighbors = grid.get(`${String(cx + dx)}:${String(cy + dy)}`)
        if (neighbors) {
          collectTransfersFromCell(from, neighbors, maxWalkMeters, links)
        }
      }
    }
  }
  return links
}

const collectCoveredStops = (
  patterns: readonly TransitPattern[],
): readonly string[] => {
  const covered = new Set<string>()
  for (const pattern of patterns) {
    for (const seg of pattern.segments) {
      covered.add(seg.fromStopId)
      covered.add(seg.toStopId)
    }
    for (const trip of pattern.scheduledTrips ?? []) {
      for (const stopTime of trip.stops) {
        covered.add(stopTime.stopId)
      }
    }
  }
  return [...covered].sort((a, b) => a.localeCompare(b))
}

/** Build a reusable dated transit network index from bus and rail datasets. */
export const buildTransitNetworkIndex = (
  input: BuildTransitNetworkInput,
): TransitNetworkIndex => {
  const stopsById = new Map(input.inventory.stops.map((s) => [s.id, s]))
  const validStopIds = new Set(stopsById.keys())
  const firstLastLookup = buildFirstLastLookup(input.busFirstLast)
  const busPatterns = buildBusPatterns(
    stopsById,
    input.busServices,
    firstLastLookup,
  )

  const provenance: NetworkProvenance[] = [
    {
      source: 'data.busrouter.sg/v1 (services + firstlast)',
      version: input.networkDate,
      license: 'LTA DataMall / Singapore Open Data Licence v1.0',
      timingKind: 'first_last_estimated',
    },
  ]

  const railPatterns = input.gtfsTrain
    ? parseGtfsTrainSchedule(input.gtfsTrain, validStopIds)
    : buildRailTopologyPatterns(input.inventory, stopsById)

  provenance.push(
    input.gtfsTrain
      ? {
          source: 'LTA DataMall GTFSScheduleTrain',
          version: input.networkDate,
          license: 'Singapore Open Data Licence v1.0',
          timingKind: 'scheduled',
        }
      : {
          source: 'stops.tsv rail topology (cheeaun/sgraildata codes)',
          version: input.inventory.inventoryDate,
          license: 'SODL v1.0 / ODbL / CC BY-SA 4.0',
          timingKind: 'first_last_estimated',
        },
  )

  const patterns = [...busPatterns, ...railPatterns]
  const transfers = buildTransferLinks(
    input.inventory.stops,
    input.maxTransferWalkMeters ?? DEFAULT_MAX_TRANSFER_WALK_M,
  )

  return {
    version: 1,
    networkDate: input.networkDate,
    inventoryDate: input.inventory.inventoryDate,
    provenance,
    patterns,
    transfers,
    coveredStopIds: collectCoveredStops(patterns),
  }
}
