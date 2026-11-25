import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  BUS_ID_PATTERN,
  isValidSingaporeCoordinate,
  RAIL_ID_PATTERN,
} from '@lib/inventory.js'
import {
  type BusRouterServiceEntry,
  serializeBusNetworkTsv,
} from '@lib/transit-network.js'
import { isRecord } from '@utils/guards.js'

const BUS_STOPS_URL = 'https://data.busrouter.sg/v1/stops.min.json'
const BUS_SERVICES_URL = 'https://data.busrouter.sg/v1/services.min.json'
const BUS_FIRSTLAST_URL = 'https://data.busrouter.sg/v1/firstlast.min.json'
const BUS_LAST_UPDATED_URL = 'https://data.busrouter.sg/v1/last-updated.txt'
const RAIL_GEOJSON_URL =
  'https://raw.githubusercontent.com/cheeaun/sgraildata/master/data/v1/sg-rail.geojson'
const DEFAULT_OUTPUT_PATH = resolve(import.meta.dir, '../public/data/stops.tsv')
const DEFAULT_NETWORK_OUTPUT_PATH = resolve(
  import.meta.dir,
  '../public/data/bus-network.tsv',
)

const SINGAPORE_OFFSET_MS = 8 * 3_600_000

interface RawStopRecord {
  readonly id: string
  readonly kind: 'bus' | 'rail'
  readonly name: string
  readonly latitude: number
  readonly longitude: number
}

const sanitizeName = (raw: string): string =>
  raw.replace(/[\t\r\n]+/g, ' ').trim()

const getSingaporeTodayIso = (): string => {
  const shifted = new Date(Date.now() + SINGAPORE_OFFSET_MS)
  return shifted.toISOString().slice(0, 10)
}

const parseBusStops = (raw: unknown): RawStopRecord[] => {
  if (!isRecord(raw)) {
    throw new Error('Unexpected bus stops JSON payload')
  }

  const results: RawStopRecord[] = []
  for (const [id, tuple] of Object.entries(raw)) {
    if (!BUS_ID_PATTERN.test(id) || !Array.isArray(tuple) || tuple.length < 3) {
      continue
    }
    const lon: unknown = tuple[0]
    const lat: unknown = tuple[1]
    const name: unknown = tuple[2]
    if (
      typeof lon !== 'number' ||
      typeof lat !== 'number' ||
      typeof name !== 'string' ||
      !isValidSingaporeCoordinate(lat, lon)
    ) {
      continue
    }
    const cleanName = sanitizeName(name)
    if (cleanName.length === 0) {
      continue
    }
    results.push({
      id,
      kind: 'bus',
      name: cleanName,
      latitude: lat,
      longitude: lon,
    })
  }
  return results
}

const parseRailFeature = (feature: unknown): RawStopRecord[] => {
  if (!isRecord(feature)) {
    return []
  }
  const props = feature['properties']
  const geom = feature['geometry']
  if (!isRecord(props) || !isRecord(geom)) {
    return []
  }
  const coords = geom['coordinates']
  const name = props['name']
  const stationCodes = props['station_codes']
  if (
    geom['type'] !== 'Point' ||
    !Array.isArray(coords) ||
    coords.length < 2 ||
    props['stop_type'] !== 'station' ||
    typeof name !== 'string' ||
    typeof stationCodes !== 'string'
  ) {
    return []
  }
  const lon: unknown = coords[0]
  const lat: unknown = coords[1]
  if (
    typeof lon !== 'number' ||
    typeof lat !== 'number' ||
    !isValidSingaporeCoordinate(lat, lon)
  ) {
    return []
  }
  const cleanName = sanitizeName(name)
  if (cleanName.length === 0) {
    return []
  }

  return stationCodes
    .split(/[-/]/)
    .map((part) => part.trim())
    .filter((part) => RAIL_ID_PATTERN.test(part))
    .map((code) => ({
      id: code,
      kind: 'rail' as const,
      name: cleanName,
      latitude: lat,
      longitude: lon,
    }))
}

const parseRailFeatures = (raw: unknown): RawStopRecord[] => {
  if (!isRecord(raw) || !Array.isArray(raw['features'])) {
    throw new Error('Rail GeoJSON missing features array')
  }
  return raw['features'].flatMap((feature) => parseRailFeature(feature))
}

const parseServiceRoutes = (rawRoutes: unknown): string[][] => {
  if (!Array.isArray(rawRoutes)) {
    return []
  }
  const routes: string[][] = []
  for (const rawRoute of rawRoutes) {
    if (!Array.isArray(rawRoute)) {
      continue
    }
    const route = rawRoute
      .filter((stop): stop is string => typeof stop === 'string')
      .map((stop) => stop.replace(/[,\t\r\n]+/g, '').trim())
      .filter((stop) => stop.length > 0)
    if (route.length >= 2) {
      routes.push(route)
    }
  }
  return routes
}

const parseBusServicesJson = (
  raw: unknown,
): Record<string, BusRouterServiceEntry> => {
  if (!isRecord(raw)) {
    throw new Error('Unexpected bus services JSON payload')
  }
  const services: Record<string, BusRouterServiceEntry> = {}
  for (const [serviceId, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      continue
    }
    const routes = parseServiceRoutes(entry['routes'])
    if (routes.length > 0) {
      services[serviceId] = {
        name: typeof entry['name'] === 'string' ? entry['name'] : serviceId,
        routes,
      }
    }
  }
  return services
}

const parseBusFirstLastJson = (raw: unknown): Record<string, string[]> => {
  if (!isRecord(raw)) {
    throw new Error('Unexpected bus first/last JSON payload')
  }
  const result: Record<string, string[]> = {}
  for (const [stopId, rawLines] of Object.entries(raw)) {
    if (!BUS_ID_PATTERN.test(stopId) || !Array.isArray(rawLines)) {
      continue
    }
    const lines = rawLines
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.replace(/[|\t\r\n]+/g, ' ').trim())
      .filter((item) => item.length > 0)
    if (lines.length > 0) {
      result[stopId] = lines
    }
  }
  return result
}

const parseNetworkDate = (rawText: string, fallbackDate: string): string => {
  const match = /\b(\d{4}-\d{2}-\d{2})\b/.exec(rawText)
  return match?.[1] ?? fallbackDate
}

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${String(response.status)}`)
  }
  return response.json()
}

const fetchOptionalText = async (url: string): Promise<string> => {
  try {
    const response = await fetch(url)
    return response.ok ? await response.text() : ''
  } catch {
    return ''
  }
}

const main = async (): Promise<void> => {
  const [busJson, railJson, busServicesJson, busFirstLastJson, lastUpdatedRaw] =
    await Promise.all([
      fetchJson(BUS_STOPS_URL),
      fetchJson(RAIL_GEOJSON_URL),
      fetchJson(BUS_SERVICES_URL),
      fetchJson(BUS_FIRSTLAST_URL),
      fetchOptionalText(BUS_LAST_UPDATED_URL),
    ])

  const busStops = parseBusStops(busJson)
  const railStops = parseRailFeatures(railJson)

  const deduped = new Map<string, RawStopRecord>()
  for (const stop of [...busStops, ...railStops]) {
    deduped.set(`${stop.kind}:${stop.id}`, stop)
  }

  const sorted = [...deduped.values()].sort((a, b) => {
    const kindCompare = a.kind.localeCompare(b.kind)
    return kindCompare !== 0 ? kindCompare : a.id.localeCompare(b.id)
  })

  const inventoryDate = getSingaporeTodayIso()
  const lines = [
    `inventoryDate\t${inventoryDate}`,
    'id\tkind\tname\tlatitude\tlongitude',
    ...sorted.map(
      (s) =>
        `${s.id}\t${s.kind}\t${s.name}\t${s.latitude.toFixed(6)}\t${s.longitude.toFixed(6)}`,
    ),
  ]

  const busServices = parseBusServicesJson(busServicesJson)
  const busFirstLast = parseBusFirstLastJson(busFirstLastJson)
  const networkDate = parseNetworkDate(lastUpdatedRaw, inventoryDate)
  const networkTsv = serializeBusNetworkTsv({
    networkDate,
    busServices,
    busFirstLast,
  })

  await mkdir(dirname(DEFAULT_OUTPUT_PATH), { recursive: true })
  await Promise.all([
    writeFile(DEFAULT_OUTPUT_PATH, `${lines.join('\n')}\n`, 'utf8'),
    writeFile(DEFAULT_NETWORK_OUTPUT_PATH, networkTsv, 'utf8'),
  ])

  const busCount = sorted.filter((s) => s.kind === 'bus').length
  const railCount = sorted.filter((s) => s.kind === 'rail').length
  process.stdout.write(
    `Wrote ${sorted.length} stops (${busCount} bus, ${railCount} rail) dated ${inventoryDate} to ${DEFAULT_OUTPUT_PATH}\n`,
  )
  process.stdout.write(
    `Wrote ${Object.keys(busServices).length} bus services and ${Object.keys(busFirstLast).length} stop schedules dated ${networkDate} to ${DEFAULT_NETWORK_OUTPUT_PATH}\n`,
  )
}

await main()
