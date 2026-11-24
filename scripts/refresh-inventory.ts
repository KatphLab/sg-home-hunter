import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const BUS_STOPS_URL = 'https://data.busrouter.sg/v1/stops.min.json'
const RAIL_GEOJSON_URL =
  'https://raw.githubusercontent.com/cheeaun/sgraildata/master/data/v1/sg-rail.geojson'
const DEFAULT_OUTPUT_PATH = resolve(import.meta.dir, '../public/data/stops.tsv')

const BUS_ID_PATTERN = /^[0-9]{5}$/
const RAIL_ID_PATTERN = /^[A-Z]{1,3}(?:[0-9]{1,2}[A-Z]?)?$/
const SINGAPORE_OFFSET_MS = 8 * 3_600_000

interface RawStopRecord {
  readonly id: string
  readonly kind: 'bus' | 'rail'
  readonly name: string
  readonly latitude: number
  readonly longitude: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isValidSingaporeCoord = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat >= 1.0 &&
  lat <= 1.6 &&
  lon >= 103.4 &&
  lon <= 104.3

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
      !isValidSingaporeCoord(lat, lon)
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
    !isValidSingaporeCoord(lat, lon)
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

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${String(response.status)}`)
  }
  return response.json()
}

const main = async (): Promise<void> => {
  const [busJson, railJson] = await Promise.all([
    fetchJson(BUS_STOPS_URL),
    fetchJson(RAIL_GEOJSON_URL),
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

  await mkdir(dirname(DEFAULT_OUTPUT_PATH), { recursive: true })
  await writeFile(DEFAULT_OUTPUT_PATH, `${lines.join('\n')}\n`, 'utf8')

  const busCount = sorted.filter((s) => s.kind === 'bus').length
  const railCount = sorted.filter((s) => s.kind === 'rail').length
  process.stdout.write(
    `Wrote ${sorted.length} stops (${busCount} bus, ${railCount} rail) dated ${inventoryDate} to ${DEFAULT_OUTPUT_PATH}\n`,
  )
}

await main()
