import type {
  Coordinates,
  Stop,
  StopInventory,
  TransitMode,
} from '@lib/commute-types.js'
import { isSingaporePublicHoliday } from '@lib/singapore-calendar.js'
import type {
  DayOperatingWindows,
  DayType,
  OperatingWindow,
  TransitSegment,
} from '@lib/transit-segment.js'
import {
  getCircleLoopWindows,
  RAIL_DEFAULT_WINDOW,
} from './circle-loop-windows.js'
import { withCircleSpurWindows } from './circle-spur-windows.js'

const EARTH_RADIUS_M = 6_371_000
const DEFAULT_MAX_TRANSFER_WALK_M = 450
const SAME_COMPLEX_RAIL_M = 150
const GRID_CELL_DEG = 0.0045
const CC_SHUTTLE_MAX_STATION = 6
const CC_PEAK_SPUR_MAX_STATION = 32
const MRT_HEADWAY_MS = 240_000
const LRT_HEADWAY_MS = 300_000
const BUS_HEADWAY_MS = 720_000
const BUS_MAX_SPEED_MPS = 18
const SERVICE_DAY_CUTOFF_MIN = 240
const LINEAR_MRT_PREFIXES: readonly string[] = [
  'NS',
  'EW',
  'CG',
  'NE',
  'DT',
  'TE',
]

interface NetworkProvenance {
  readonly source: string
  readonly version: string
  readonly license: string
  readonly timingKind: 'first_last_estimated'
}

const RAIL_ALL_DAY_WINDOWS: Readonly<
  Partial<Record<DayType, DayOperatingWindows>>
> = {
  weekday: RAIL_DEFAULT_WINDOW,
  saturday: RAIL_DEFAULT_WINDOW,
  sunday_holiday: RAIL_DEFAULT_WINDOW,
}

export interface TransitPattern {
  readonly patternId: string
  readonly serviceId: string
  readonly serviceName: string
  readonly mode: TransitMode
  readonly headwayMs: number
  readonly isLoop?: boolean
  readonly segments: readonly TransitSegment[]
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

interface BuildTransitNetworkInput {
  readonly inventory: StopInventory
  readonly networkDate: string
  readonly busServices: Readonly<Record<string, BusRouterServiceEntry>>
  readonly busFirstLast: Readonly<Record<string, readonly string[]>>
  readonly maxTransferWalkMeters?: number
}

interface ParsedFirstLastEntry {
  readonly serviceId: string
  readonly windows: Readonly<Partial<Record<DayType, OperatingWindow>>>
}

export interface ParsedBusNetworkData {
  readonly networkDate: string
  readonly busServices: Readonly<Record<string, BusRouterServiceEntry>>
  readonly busFirstLast: Readonly<Record<string, readonly string[]>>
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Extract an ISO calendar date from text such as an ISO timestamp, falling back when absent. */
export const parseBusNetworkDate = (
  rawText: string,
  fallbackDate: string,
): string => {
  const match = /(?:^|\D)(\d{4}-\d{2}-\d{2})(?:$|\D)/.exec(rawText)
  return match?.[1] ?? fallbackDate
}

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

interface RawClockPair {
  readonly firstMin: number
  readonly lastMin: number
}

const parseRawClockPair = (
  firstRaw: string,
  lastRaw: string,
  weekdayRaw?: RawClockPair,
): RawClockPair | undefined => {
  if (firstRaw === '-' || lastRaw === '-') {
    return undefined
  }
  const firstMin =
    firstRaw === '=' ? (weekdayRaw?.firstMin ?? null) : parseHHMM(firstRaw)
  const lastMin =
    lastRaw === '=' ? (weekdayRaw?.lastMin ?? null) : parseHHMM(lastRaw)
  if (firstMin === null || lastMin === null) {
    return undefined
  }
  return { firstMin, lastMin }
}

const toOperatingWindow = (
  raw: RawClockPair | undefined,
): OperatingWindow | undefined => {
  if (!raw) {
    return undefined
  }
  if (
    raw.firstMin < SERVICE_DAY_CUTOFF_MIN &&
    raw.lastMin < SERVICE_DAY_CUTOFF_MIN &&
    raw.firstMin <= raw.lastMin
  ) {
    return { firstMin: raw.firstMin + 1440, lastMin: raw.lastMin + 1440 }
  }
  const lastMin = raw.lastMin < raw.firstMin ? raw.lastMin + 1440 : raw.lastMin
  return { firstMin: raw.firstMin, lastMin }
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
  const weekdayRaw = parseRawClockPair(wdF, wdL)
  const saturdayRaw = parseRawClockPair(satF, satL, weekdayRaw)
  const sundayRaw = parseRawClockPair(sunF, sunL, weekdayRaw)
  const weekday = toOperatingWindow(weekdayRaw)
  const saturday = toOperatingWindow(saturdayRaw)
  const sunday = toOperatingWindow(sundayRaw)
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
    Math.round((distM / BUS_MAX_SPEED_MPS) * 1000 + 10_000),
  )
  const minRideMs = physicalMinMs
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

const buildBusPatternsForRoute = (
  serviceId: string,
  dirIdx: number,
  route: readonly string[],
  stopsById: ReadonlyMap<string, Stop>,
  firstLastLookup: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly ParsedFirstLastEntry[]>
  >,
): TransitPattern[] => {
  const aligned = alignRouteFirstLast(serviceId, route, firstLastLookup)
  const chunks: TransitSegment[][] = []
  let current: TransitSegment[] = []
  for (let i = 0; i < route.length - 1; i += 1) {
    const fromStop = stopsById.get(route[i] ?? '')
    const toStop = stopsById.get(route[i + 1] ?? '')
    if (!fromStop || !toStop) {
      if (current.length > 0) {
        chunks.push(current)
        current = []
      }
      continue
    }
    current.push(
      computeBusSegmentTiming(fromStop, toStop, aligned[i], aligned[i + 1]),
    )
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks.map((segments, chunkIdx) => ({
    patternId:
      chunks.length === 1
        ? `bus:${serviceId}:${String(dirIdx)}`
        : `bus:${serviceId}:${String(dirIdx)}:${String(chunkIdx)}`,
    serviceId,
    serviceName: serviceId,
    mode: 'BUS',
    headwayMs: BUS_HEADWAY_MS,
    segments,
  }))
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
      patterns.push(
        ...buildBusPatternsForRoute(
          serviceId,
          dirIdx,
          entry.routes[dirIdx] ?? [],
          stopsById,
          firstLastLookup,
        ),
      )
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

interface RailPatternOptions {
  readonly patternPrefix?: string
  readonly getOperatingWindows?: (
    fromStopId: string,
    ascending: boolean,
  ) => Readonly<Partial<Record<DayType, DayOperatingWindows>>>
  readonly isLoop?: boolean
}

const buildRailSegment = (
  fromStop: Stop,
  toStop: Stop,
  isLrt: boolean,
  operatingWindows: Readonly<Partial<Record<DayType, DayOperatingWindows>>>,
): TransitSegment => {
  const distM = haversineDistanceMeters(fromStop.point, toStop.point)
  const minRideMs = isLrt
    ? Math.max(50_000, Math.round((distM / 10) * 1000 + 25_000))
    : Math.max(75_000, Math.round((distM / 15) * 1000 + 35_000))
  const estRideMs = isLrt
    ? Math.max(minRideMs, Math.round((distM / 7.5) * 1000 + 35_000))
    : Math.max(minRideMs, Math.round((distM / 12.5) * 1000 + 50_000))
  return {
    fromStopId: fromStop.id,
    toStopId: toStop.id,
    minRideMs,
    estRideMs,
    operatingWindows,
  }
}

const makeRailPattern = (
  patternId: string,
  serviceId: string,
  orderedStops: readonly Stop[],
  isLrt: boolean,
  options?: RailPatternOptions,
  ascending = true,
): TransitPattern | null => {
  if (orderedStops.length < 2) {
    return null
  }
  const segments: TransitSegment[] = []
  for (let i = 0; i < orderedStops.length - 1; i += 1) {
    const fromStop = orderedStops[i]
    const toStop = orderedStops[i + 1]
    if (fromStop && toStop) {
      const operatingWindows =
        options?.getOperatingWindows?.(fromStop.id, ascending) ??
        RAIL_ALL_DAY_WINDOWS
      segments.push(buildRailSegment(fromStop, toStop, isLrt, operatingWindows))
    }
  }
  if (segments.length === 0) {
    return null
  }
  return {
    patternId,
    serviceId,
    serviceName: serviceId,
    mode: isLrt ? 'TRAM' : 'SUBWAY',
    headwayMs: isLrt ? LRT_HEADWAY_MS : MRT_HEADWAY_MS,
    ...(options?.isLoop ? { isLoop: true } : {}),
    segments,
  }
}

const pushBidirectionalRail = (
  patterns: TransitPattern[],
  serviceId: string,
  stops: readonly Stop[],
  isLrt: boolean,
  options?: RailPatternOptions,
): void => {
  const prefix = options?.patternPrefix ?? `rail:${serviceId}`
  const fwd = makeRailPattern(`${prefix}:fwd`, serviceId, stops, isLrt, options)
  if (fwd) {
    patterns.push(fwd)
  }
  const rev = makeRailPattern(
    `${prefix}:rev`,
    serviceId,
    [...stops].reverse(),
    isLrt,
    options,
    false,
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
  if (hubIndex < 0 || orderedStops.length <= hubIndex + 1) {
    pushBidirectionalRail(patterns, serviceId, orderedStops, isLrt)
    return
  }
  const stem = orderedStops.slice(0, hubIndex + 1)
  const loopTail = orderedStops.slice(hubIndex + 1)
  const returnStem = [...stem].reverse()
  const fwd = makeRailPattern(
    `rail:${serviceId}:fwd`,
    serviceId,
    [...stem, ...loopTail, ...returnStem],
    isLrt,
  )
  if (fwd) {
    patterns.push(fwd)
  }
  const rev = makeRailPattern(
    `rail:${serviceId}:rev`,
    serviceId,
    [...stem, ...[...loopTail].reverse(), ...returnStem],
    isLrt,
  )
  if (rev) {
    patterns.push(rev)
  }
}

const pushCircleLinePatterns = (
  patterns: TransitPattern[],
  serviceId: string,
  orderedStops: readonly Stop[],
  hubStationId: string,
  isLrt: boolean,
): void => {
  const shuttleStops = orderedStops.filter(
    (s) => parseStationNumber(s.id) <= CC_SHUTTLE_MAX_STATION,
  )
  pushBidirectionalRail(patterns, serviceId, shuttleStops, isLrt, {
    patternPrefix: `rail:${serviceId}:shuttle`,
  })

  const peakStops = orderedStops.filter(
    (s) => parseStationNumber(s.id) <= CC_PEAK_SPUR_MAX_STATION,
  )
  if (peakStops.length > shuttleStops.length) {
    const firstPeakIndex = patterns.length
    pushBidirectionalRail(patterns, serviceId, peakStops, isLrt, {
      patternPrefix: `rail:${serviceId}:peak`,
    })
    for (let i = firstPeakIndex; i < patterns.length; i += 1) {
      const pattern = patterns[i]
      if (pattern) {
        patterns[i] = {
          ...pattern,
          segments: withCircleSpurWindows(pattern.segments),
        }
      }
    }
  }

  const hubIndex = orderedStops.findIndex((s) => s.id === hubStationId)
  const hub = hubIndex >= 0 ? orderedStops[hubIndex] : undefined
  if (!hub || orderedStops.length <= hubIndex + 1) {
    return
  }
  const loopTail = orderedStops.slice(hubIndex + 1)
  pushBidirectionalRail(
    patterns,
    `${serviceId}_LOOP`,
    [hub, ...loopTail, hub],
    isLrt,
    { getOperatingWindows: getCircleLoopWindows, isLoop: true },
  )
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

  pushCircleLinePatterns(
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
  }
  return [...covered].sort((a, b) => a.localeCompare(b))
}

/** Build a reusable dated transit network index from bus and rail datasets. */
export const buildTransitNetworkIndex = (
  input: BuildTransitNetworkInput,
): TransitNetworkIndex => {
  const stopsById = new Map(input.inventory.stops.map((s) => [s.id, s]))
  const firstLastLookup = buildFirstLastLookup(input.busFirstLast)
  const busPatterns = buildBusPatterns(
    stopsById,
    input.busServices,
    firstLastLookup,
  )
  const railPatterns = buildRailTopologyPatterns(input.inventory, stopsById)
  const provenance: NetworkProvenance[] = [
    {
      source: 'data.busrouter.sg/v1 (services + firstlast)',
      version: input.networkDate,
      license: 'LTA DataMall / Singapore Open Data Licence v1.0',
      timingKind: 'first_last_estimated',
    },
    {
      source: 'stops.tsv rail topology (cheeaun/sgraildata codes)',
      version: input.inventory.inventoryDate,
      license: 'SODL v1.0 / ODbL / CC BY-SA 4.0',
      timingKind: 'first_last_estimated',
    },
  ]

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
