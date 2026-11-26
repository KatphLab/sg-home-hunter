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
// Use the faster rail ceiling for both MRT and LRT when ruling journeys out.
const RAIL_MAX_SPEED_MPS = 25
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
}

interface BuildTransitNetworkInput {
  readonly inventory: StopInventory
  readonly networkDate: string
  readonly busRoutes: Readonly<Record<string, readonly (readonly BusVisit[])[]>>
  readonly maxTransferWalkMeters?: number
}

interface ParsedFirstLastEntry {
  readonly serviceId: string
  readonly windows: Readonly<Partial<Record<DayType, OperatingWindow>>>
}

export interface BusVisit {
  readonly stopId: string
  readonly times?: string
}

export interface ParsedBusNetworkData {
  readonly networkDate: string
  readonly busRoutes: Readonly<Record<string, readonly (readonly BusVisit[])[]>>
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

/** Serialize dated, direction-ordered bus routes with stop-visit-specific timings. */
export const serializeBusNetworkTsv = (input: ParsedBusNetworkData): string => {
  if (!ISO_DATE_PATTERN.test(input.networkDate)) {
    throw new Error(`Invalid bus network date: ${input.networkDate}`)
  }
  const lines = [
    `networkDate\t${input.networkDate}`,
    'service\tdirection\tvisits',
  ]
  const serviceIds = Object.keys(input.busRoutes).sort((a, b) =>
    a.localeCompare(b),
  )
  for (const serviceId of serviceIds) {
    const routes = input.busRoutes[serviceId] ?? []
    for (const [direction, route] of routes.entries()) {
      if (route.length < 2) continue
      const visits = route.map(
        ({ stopId, times }) =>
          `${sanitizeTsvToken(stopId)}${times === undefined ? '' : ` ${sanitizeTsvToken(times)}`}`,
      )
      lines.push(
        `${sanitizeTsvToken(serviceId)}\t${String(direction + 1)}\t${visits.join('|')}`,
      )
    }
  }
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
  if (lines[1] !== 'service\tdirection\tvisits') {
    throw new Error('Bus network TSV column header mismatch')
  }
  return networkDate
}

const parseBusVisit = (raw: string): BusVisit => {
  const separator = raw.indexOf(' ')
  return separator === -1
    ? { stopId: raw }
    : { stopId: raw.slice(0, separator), times: raw.slice(separator + 1) }
}

/** Parse a compact bus-network TSV produced by `serializeBusNetworkTsv`. */
export const parseBusNetworkTsv = (rawTsv: string): ParsedBusNetworkData => {
  const lines = rawTsv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const networkDate = parseNetworkHeader(lines)
  const routesByService = new Map<string, Map<number, BusVisit[]>>()
  for (const line of lines.slice(2)) {
    const parts = line.split('\t')
    const serviceId = parts[0] ?? ''
    const direction = Number(parts[1])
    const visits = (parts[2] ?? '')
      .split('|')
      .filter(Boolean)
      .map(parseBusVisit)
    if (
      parts.length !== 3 ||
      serviceId.length === 0 ||
      !Number.isInteger(direction) ||
      direction < 1 ||
      visits.length < 2
    ) {
      continue
    }
    const routes =
      routesByService.get(serviceId) ?? new Map<number, BusVisit[]>()
    routes.set(direction, visits)
    routesByService.set(serviceId, routes)
  }
  const busRoutes: Record<string, BusVisit[][]> = {}
  for (const [serviceId, routes] of routesByService) {
    busRoutes[serviceId] = [...routes]
      .sort(([a], [b]) => a - b)
      .map(([, route]) => route)
  }
  return { networkDate, busRoutes }
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

const getRefFirstMin = (entry: ParsedFirstLastEntry): number | null =>
  entry.windows.weekday?.firstMin ??
  entry.windows.saturday?.firstMin ??
  entry.windows.sunday_holiday?.firstMin ??
  null

// Dwell, typical operating speed and timetable deltas belong in estimates.
const minimumRideMs = (distanceM: number, maxSpeedMps: number): number =>
  Math.floor((distanceM / maxSpeedMps) * 1000)

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

  const minRideMs = minimumRideMs(distM, BUS_MAX_SPEED_MPS)
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

const buildBusPatternsForRoute = (
  serviceId: string,
  dirIdx: number,
  route: readonly BusVisit[],
  stopsById: ReadonlyMap<string, Stop>,
): TransitPattern[] => {
  const entries = route.map((visit) =>
    visit.times === undefined
      ? undefined
      : (parseBusRouterFirstLastLine(`${serviceId} ${visit.times}`) ??
        undefined),
  )
  const chunks: TransitSegment[][] = []
  let current: TransitSegment[] = []
  for (let i = 0; i < route.length - 1; i += 1) {
    const fromStop = stopsById.get(route[i]?.stopId ?? '')
    const toStop = stopsById.get(route[i + 1]?.stopId ?? '')
    if (!fromStop || !toStop) {
      if (current.length > 0) {
        chunks.push(current)
        current = []
      }
      continue
    }
    current.push(
      computeBusSegmentTiming(fromStop, toStop, entries[i], entries[i + 1]),
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
  busRoutes: Readonly<Record<string, readonly (readonly BusVisit[])[]>>,
): TransitPattern[] => {
  const patterns: TransitPattern[] = []
  for (const [serviceId, routes] of Object.entries(busRoutes)) {
    for (let dirIdx = 0; dirIdx < routes.length; dirIdx += 1) {
      patterns.push(
        ...buildBusPatternsForRoute(
          serviceId,
          dirIdx,
          routes[dirIdx] ?? [],
          stopsById,
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

const collectByPrefix = (
  railStops: readonly Stop[],
  prefix: string,
): Stop[] => {
  const stationPattern = new RegExp(`^${prefix}\\d+$`)
  return railStops
    .filter((s) =>
      prefix === 'CG' ? s.id.startsWith('CG') : stationPattern.test(s.id),
    )
    .sort((a, b) => parseStationNumber(a.id) - parseStationNumber(b.id))
}

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
  const minRideMs = minimumRideMs(distM, RAIL_MAX_SPEED_MPS)
  const estRideMs = isLrt
    ? Math.max(50_000, Math.round((distM / 7.5) * 1000 + 35_000))
    : Math.max(75_000, Math.round((distM / 12.5) * 1000 + 50_000))
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
  orderedStops: readonly Stop[],
): void => {
  const hubIndex = orderedStops.findIndex((s) => s.id === 'BP6')
  if (hubIndex < 0 || orderedStops.length <= hubIndex + 1) {
    pushBidirectionalRail(patterns, 'BP', orderedStops, true)
    return
  }
  const stem = orderedStops.slice(0, hubIndex + 1)
  const loopTail = orderedStops.slice(hubIndex + 1)
  const returnStem = [...stem].reverse()
  for (const [direction, tail] of [
    ['fwd', loopTail],
    ['rev', [...loopTail].reverse()],
  ] as const) {
    const pattern = makeRailPattern(
      `rail:BP:${direction}`,
      'BP',
      [...stem, ...tail, ...returnStem],
      true,
    )
    if (pattern) {
      patterns.push(pattern)
    }
  }
}

const pushCircleLinePatterns = (
  patterns: TransitPattern[],
  orderedStops: readonly Stop[],
): void => {
  const shuttleStops = orderedStops.filter(
    (s) => parseStationNumber(s.id) <= CC_SHUTTLE_MAX_STATION,
  )
  pushBidirectionalRail(patterns, 'CC', shuttleStops, false, {
    patternPrefix: 'rail:CC:shuttle',
  })

  const peakStops = orderedStops.filter(
    (s) => parseStationNumber(s.id) <= CC_PEAK_SPUR_MAX_STATION,
  )
  if (peakStops.length > shuttleStops.length) {
    const firstPeakIndex = patterns.length
    pushBidirectionalRail(patterns, 'CC', peakStops, false, {
      patternPrefix: 'rail:CC:peak',
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

  const hubIndex = orderedStops.findIndex((s) => s.id === 'CC4')
  const hub = hubIndex >= 0 ? orderedStops[hubIndex] : undefined
  if (!hub || orderedStops.length <= hubIndex + 1) {
    return
  }
  const loopTail = orderedStops.slice(hubIndex + 1)
  pushBidirectionalRail(patterns, 'CC_LOOP', [hub, ...loopTail, hub], false, {
    getOperatingWindows: getCircleLoopWindows,
    isLoop: true,
  })
}

const buildLrtPatterns = (
  patterns: TransitPattern[],
  railStops: readonly Stop[],
  stopsById: ReadonlyMap<string, Stop>,
): void => {
  pushStemAndLoopRail(patterns, collectByPrefix(railStops, 'BP'))

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

  pushCircleLinePatterns(patterns, collectByPrefix(railStops, 'CC'))

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

/** Build a reusable dated transit network index from bus and rail datasets. */
export const buildTransitNetworkIndex = (
  input: BuildTransitNetworkInput,
): TransitNetworkIndex => {
  const stopsById = new Map(input.inventory.stops.map((s) => [s.id, s]))
  const busPatterns = buildBusPatterns(stopsById, input.busRoutes)
  const railPatterns = buildRailTopologyPatterns(input.inventory, stopsById)
  const provenance: NetworkProvenance[] = [
    {
      source: 'data.busrouter.sg/v1/raw/bus-routes.datamall.json',
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
  }
}
